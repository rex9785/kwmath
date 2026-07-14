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

// ── FCM HTTP v1 (안드로이드 네이티브 앱 푸시) ──────────────────────────────
// 서비스계정 JSON(env.FCM_SERVICE_ACCOUNT)으로 OAuth2 액세스 토큰 발급(RS256 JWT) 후
//   POST https://fcm.googleapis.com/v1/projects/{project_id}/messages:send
// 토큰 저장: R2 fcm-tokens/{userId}.json  { tokens:[{token,ua,savedAt}], updatedAt }
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
let _fcmSA = null;     // 파싱한 서비스계정(아이솔레이트 재사용 시 캐시)
let _fcmToken = null;  // { token, expMs }

function parseServiceAccount(env) {
  if (_fcmSA) return _fcmSA;
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  try { _fcmSA = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch { _fcmSA = null; }
  return _fcmSA;
}

function pemToDer(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der.buffer;
}

async function getGoogleAccessToken(sa) {
  if (_fcmToken && _fcmToken.expMs > Date.now() + 60000) return _fcmToken.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg:'RS256', typ:'JWT' })));
  const claims = b64url(new TextEncoder().encode(JSON.stringify({
    iss: sa.client_email, scope: FCM_SCOPE,
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })));
  const data = `${header}.${claims}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key),
    { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
  const jwt = `${data}.${b64url(sig)}`;
  const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method:'POST',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    body:`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new Error('FCM OAuth 실패: ' + (d.error_description || d.error || res.status));
  _fcmToken = { token: d.access_token, expMs: Date.now() + (d.expires_in || 3600) * 1000 };
  return _fcmToken.token;
}

async function sendFcmOne(projectId, accessToken, token, msg) {
  return await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${accessToken}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ message: {
      token,
      notification: { title: msg.title, body: msg.body },
      data: { url: String(msg.url || '/portal'), tag: String(msg.tag || 'kwmath') },
      android: { priority: 'high' },
    }}),
  });
}

async function sendFcmToUsers(env, ids, msg) {
  try {
    const sa = parseServiceAccount(env);
    if (!sa || !sa.private_key || !sa.client_email || !sa.project_id) return { sent: 0, note: 'FCM 미설정' };
    const accessToken = await getGoogleAccessToken(sa);
    const tokens = [];
    for (const uid of ids) {
      try {
        const obj = await env.BUCKET.get(`fcm-tokens/${encodeURIComponent(uid)}.json`);
        if (!obj) continue;
        const rec = JSON.parse(await obj.text());
        for (const t of (rec.tokens || [])) if (t && t.token) tokens.push(t.token);
      } catch {}
    }
    if (!tokens.length) return { sent: 0, note: 'FCM 토큰 없음' };
    const results = await Promise.allSettled(tokens.map(t => sendFcmOne(sa.project_id, accessToken, t, msg)));
    let sent = 0;
    for (const r of results) if (r.status === 'fulfilled' && r.value && r.value.ok) sent++;
    return { sent, total: tokens.length };
  } catch (e) {
    return { sent: 0, error: String(e && e.message || e) };
  }
}

// 밤 무음 판정: KST(UTC+9) 기준 23:00~06:59면 true. "학부모" 대상 푸시를 이 시간대엔 건너뛰는 데 씀.
//   "저녁 11시~아침 7시" = 23:00~07:00. 정각 07:00(h=7)은 발송 허용, 22:59(h=22)도 발송.
export function isKstQuietHours(d = new Date()) {
  const h = new Date(d.getTime() + 9 * 3600 * 1000).getUTCHours();   // KST 시(0~23)
  return h >= 23 || h < 7;
}

// ── 공개 API: 여러 userId(=휴대폰)에게 알림 발송 (Web Push + FCM 병행, best-effort, 절대 throw 안 함) ──
//   opts.nightSilent: 밤(KST 23~7) 무음 대상(학부모). true=이 호출 전원 / [id…]=그 id만 제외(학생·원장은 그대로 발송).
//   ⚠️ nightSilent의 id는 userIds와 "같은 표기"여야 매칭됨(호출부가 동일 형식으로 넘김).
export async function sendPushToUsers(env, userIds, payload, opts = {}) {
  let ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String))];
  if (!ids.length) return { ok: true, sent: 0 };

  // 밤(KST 23:00~07:00) 무음 — 학부모 수신자만 제외(관우T: 학부모만·학생/원장은 발송, 밤 알림은 그냥 건너뜀).
  if (opts && opts.nightSilent && isKstQuietHours()) {
    if (opts.nightSilent === true) return { ok: true, sent: 0, skipped: ids.length, note: 'quiet-hours(parent)' };
    const silent = new Set((Array.isArray(opts.nightSilent) ? opts.nightSilent : [opts.nightSilent]).filter(Boolean).map(String));
    if (silent.size) ids = ids.filter(id => !silent.has(id));
    if (!ids.length) return { ok: true, sent: 0, skipped: silent.size, note: 'quiet-hours(parent)' };
  }

  const msg = {
    title: payload.title || '이관우 수학연구소',
    body:  payload.body  || '',
    url:   payload.url   || '/portal',
    tag:   payload.tag   || 'kwmath',
  };

  // ① Web Push (브라우저·PWA) — 기존 경로 유지
  let webSent = 0, webTotal = 0;
  try {
    const vapidPub  = env.VAPID_PUBLIC_KEY  || '';
    const vapidPriv = env.VAPID_PRIVATE_KEY || '';
    const subject   = env.VAPID_SUBJECT     || 'mailto:rex9785@gmail.com';
    if (vapidPub && vapidPriv) {
      const allSubs = [];
      for (const uid of ids) {
        try {
          const obj = await env.BUCKET.get(`push-subs/${encodeURIComponent(uid)}.json`);
          if (!obj) continue;
          const rec = JSON.parse(await obj.text());
          for (const s of (rec.subs || [])) allSubs.push(s);
        } catch {}
      }
      webTotal = allSubs.length;
      if (allSubs.length) {
        const results = await Promise.allSettled(
          allSubs.map(s => sendOne(s, msg, vapidPub, vapidPriv, subject))
        );
        for (const r of results) if (r.status === 'fulfilled' && r.value && r.value.ok) webSent++;
      }
    }
  } catch {}

  // ② FCM (안드로이드 앱) — 병행 발송
  const fcm = await sendFcmToUsers(env, ids, msg);

  return { ok: true, sent: webSent + (fcm.sent || 0), web: { sent: webSent, total: webTotal }, fcm };
}
