// functions/api/_push.js
// ───────────────────────────────────────────────────────────
// Web Push 공용 발송 모듈 (RFC 8291 aes128gcm + RFC 8292 VAPID ES256).
// push-send.js의 검증된 구현을 모듈화 — 다른 엔드포인트(study.js 추월 넛지 등)에서 재사용.
// env: VAPID_PUBLIC_KEY · VAPID_PRIVATE_KEY · VAPID_SUBJECT 필요.
// 구독 저장 위치: R2 push-subs/{userId}.json  { subs:[{endpoint,keys:{p256dh,auth}}] }
// ───────────────────────────────────────────────────────────

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...arrs) {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

async function makeVapidJwt(endpoint, vapidPubB64, vapidPrivB64, subject) {
  const u = new URL(endpoint);
  const aud = `${u.protocol}//${u.host}`;
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const header  = b64url(new TextEncoder().encode(JSON.stringify({ typ:'JWT', alg:'ES256' })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ aud, exp, sub: subject })));
  const data = `${header}.${payload}`;
  const pub  = b64urlDecode(vapidPubB64);
  const priv = b64urlDecode(vapidPrivB64);
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65)),
    d: b64url(priv)
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name:'ECDSA', namedCurve:'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, key, new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}

async function hkdf(salt, ikm, info, lengthBytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'HKDF', hash:'SHA-256', salt, info }, key, lengthBytes * 8);
  return new Uint8Array(bits);
}

async function encryptPayload(plaintext, p256dhB64, authB64) {
  const receiverPub = b64urlDecode(p256dhB64);
  const authSecret  = b64urlDecode(authB64);
  const ephemeral = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']);
  const senderJwk = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
  const senderPub = concat(new Uint8Array([0x04]), b64urlDecode(senderJwk.x), b64urlDecode(senderJwk.y));
  const receiverKey = await crypto.subtle.importKey(
    'jwk',
    { kty:'EC', crv:'P-256', x: b64url(receiverPub.slice(1, 33)), y: b64url(receiverPub.slice(33, 65)) },
    { name:'ECDH', namedCurve:'P-256' }, false, []
  );
  const sharedBits = await crypto.subtle.deriveBits({ name:'ECDH', public: receiverKey }, ephemeral.privateKey, 256);
  const ecdhSecret = new Uint8Array(sharedBits);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyInfo = concat(new TextEncoder().encode('WebPush: info\0'), receiverPub, senderPub);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);
  const pt = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : new Uint8Array(plaintext);
  const padded = concat(pt, new Uint8Array([0x02]));
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv: nonce }, cekKey, padded));
  const recordSize = 4096;
  const header = new Uint8Array(21);
  header.set(salt, 0);
  header[16] = (recordSize >>> 24) & 0xff;
  header[17] = (recordSize >>> 16) & 0xff;
  header[18] = (recordSize >>>  8) & 0xff;
  header[19] =  recordSize         & 0xff;
  header[20] = 65;
  return { body: concat(header, senderPub, ct) };
}

async function sendOne(sub, payload, vapidPub, vapidPriv, subject) {
  const jwt = await makeVapidJwt(sub.endpoint, vapidPub, vapidPriv, subject);
  const { body } = await encryptPayload(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
  return await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'TTL': '86400',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Authorization': `vapid t=${jwt}, k=${vapidPub}`
    },
    body
  });
}

// ── 공개 API: 여러 userId(=휴대폰)에게 알림 발송 (best-effort, 절대 throw 안 함) ──
export async function sendPushToUsers(env, userIds, payload) {
  try {
    const vapidPub  = env.VAPID_PUBLIC_KEY  || '';
    const vapidPriv = env.VAPID_PRIVATE_KEY || '';
    const subject   = env.VAPID_SUBJECT     || 'mailto:rex9785@gmail.com';
    if (!vapidPub || !vapidPriv) return { ok: false, sent: 0, note: 'VAPID 미설정' };

    const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String))];
    if (!ids.length) return { ok: true, sent: 0 };

    const msg = {
      title: payload.title || '이관우 수학연구소',
      body:  payload.body  || '',
      url:   payload.url   || '/portal',
      tag:   payload.tag   || 'kwmath',
    };

    const allSubs = [];
    for (const uid of ids) {
      try {
        const obj = await env.BUCKET.get(`push-subs/${encodeURIComponent(uid)}.json`);
        if (!obj) continue;
        const rec = JSON.parse(await obj.text());
        for (const s of (rec.subs || [])) allSubs.push(s);
      } catch {}
    }
    if (!allSubs.length) return { ok: true, sent: 0, note: '구독자 없음' };

    const results = await Promise.allSettled(
      allSubs.map(s => sendOne(s, msg, vapidPub, vapidPriv, subject))
    );
    let sent = 0;
    for (const r of results) if (r.status === 'fulfilled' && r.value && r.value.ok) sent++;
    return { ok: true, sent, total: allSubs.length };
  } catch (e) {
    return { ok: false, sent: 0, error: String(e && e.message || e) };
  }
}
