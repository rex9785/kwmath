// POST /api/push-send
// admin 인증 후 특정 사용자(들)에게 Web Push 발송.
// 표준: RFC 8291 (aes128gcm) + RFC 8292 (VAPID JWT, ES256)
// 의존성 없이 Cloudflare Pages Functions의 Web Crypto API로 구현.
//
// 환경변수 필요 (Cloudflare):
//   ADMIN_PASSWORD      — 기존
//   VAPID_PUBLIC_KEY    — base64url, raw P-256 공개키 65바이트 (앞 0x04)
//   VAPID_PRIVATE_KEY   — base64url, raw P-256 사설키 32바이트
//   VAPID_SUBJECT       — "mailto:rex9785@gmail.com" 또는 사이트 URL
//
// Body: {
//   password: string,         // admin
//   userId | userIds,         // 단일 또는 배열
//   title: string,            // 알림 제목
//   body: string,             // 본문
//   url?: string,             // 클릭 시 이동 (기본 /portal)
//   tag?: string,             // 동일 tag 알림은 덮어씀
//   image?: string            // (선택) 알림 이미지
// }

export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  let body = {};
  try { body = await request.json(); } catch {}

  // 인증: 둘 중 하나면 통과
  //   (1) Authorization: Bearer <ADMIN_PASSWORD>  — _middleware가 원장 세션토큰(adm_)을 번역해 줌 (admin 페이지 표준 경로)
  //   (2) body.password === ADMIN_PASSWORD        — 서버 내부 호출(notices-write 등)·레거시 호환
  const authz = request.headers.get('Authorization') || '';
  const bearerOk = !!env.ADMIN_PASSWORD && authz === 'Bearer ' + env.ADMIN_PASSWORD;
  const bodyOk   = !!env.ADMIN_PASSWORD && (body.password || '') === env.ADMIN_PASSWORD;
  if (!bearerOk && !bodyOk)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  const vapidPub  = env.VAPID_PUBLIC_KEY  || '';
  const vapidPriv = env.VAPID_PRIVATE_KEY || '';
  const subject   = env.VAPID_SUBJECT     || 'mailto:rex9785@gmail.com';
  if (!vapidPub || !vapidPriv)
    return Response.json({ error: 'VAPID 키 미설정' }, { status: 503 });

  const userIds = Array.isArray(body.userIds) ? body.userIds : (body.userId ? [body.userId] : []);
  if (!userIds.length)
    return Response.json({ error: 'userId 또는 userIds 필요' }, { status: 400 });

  const payload = {
    title: body.title || '이관우 수학연구소',
    body:  body.body  || '',
    url:   body.url   || '/portal',
    tag:   body.tag   || 'kwmath',
    image: body.image || undefined
  };

  // 사용자별 구독 정보 R2에서 로드
  const allSubs = [];
  for (const uid of userIds) {
    try {
      const obj = await env.BUCKET.get(`push-subs/${encodeURIComponent(uid)}.json`);
      if (!obj) continue;
      const rec = JSON.parse(await obj.text());
      for (const s of (rec.subs || [])) allSubs.push({ uid, sub: s });
    } catch {}
  }
  if (!allSubs.length)
    return Response.json({ ok: true, sent: 0, fails: 0, note: '구독자 없음' });

  // 발송 (병렬, 실패해도 다른 건 계속)
  const results = await Promise.allSettled(
    allSubs.map(({ sub }) => sendWebPush(sub, payload, vapidPub, vapidPriv, subject))
  );

  let sent = 0, fails = 0, gone = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value.ok) {
      sent++;
    } else {
      fails++;
      // 410 Gone / 404 = 구독 만료. 정리 대상으로 표시.
      const status = r.status === 'fulfilled' ? r.value.status : 0;
      if (status === 410 || status === 404) {
        gone.push(allSubs[i]);
      }
    }
  }

  // 만료된 구독 자동 정리
  if (gone.length) {
    const byUser = {};
    for (const g of gone) {
      (byUser[g.uid] = byUser[g.uid] || []).push(g.sub.endpoint);
    }
    for (const [uid, eps] of Object.entries(byUser)) {
      try {
        const key = `push-subs/${encodeURIComponent(uid)}.json`;
        const obj = await env.BUCKET.get(key);
        if (!obj) continue;
        const rec = JSON.parse(await obj.text());
        rec.subs = (rec.subs || []).filter(s => !eps.includes(s.endpoint));
        rec.updatedAt = new Date().toISOString();
        if (rec.subs.length === 0) {
          await env.BUCKET.delete(key);
        } else {
          await env.BUCKET.put(key, JSON.stringify(rec), { httpMetadata:{ contentType:'application/json' } });
        }
      } catch {}
    }
  }

  return Response.json({ ok: true, sent, fails, cleanedExpired: gone.length });
}

// ─────────────────────────────────────────────────────────────
// Web Push 표준 구현
// ─────────────────────────────────────────────────────────────

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
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

// VAPID JWT (ES256)
async function makeVapidJwt(endpoint, vapidPubB64, vapidPrivB64, subject) {
  const u = new URL(endpoint);
  const aud = `${u.protocol}//${u.host}`;
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const header  = b64url(new TextEncoder().encode(JSON.stringify({ typ:'JWT', alg:'ES256' })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ aud, exp, sub: subject })));
  const data = `${header}.${payload}`;

  const pub  = b64urlDecode(vapidPubB64);  // 65바이트 (0x04 || x32 || y32)
  const priv = b64urlDecode(vapidPrivB64); // 32바이트
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65)),
    d: b64url(priv)
  };
  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name:'ECDSA', namedCurve:'P-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name:'ECDSA', hash:'SHA-256' }, key,
    new TextEncoder().encode(data)
  );
  return `${data}.${b64url(sig)}`;
}

// HKDF-SHA256
async function hkdf(salt, ikm, info, lengthBytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name:'HKDF', hash:'SHA-256', salt, info },
    key, lengthBytes * 8
  );
  return new Uint8Array(bits);
}

// aes128gcm 페이로드 암호화 (RFC 8291)
async function encryptPayload(plaintext, p256dhB64, authB64) {
  const receiverPub = b64urlDecode(p256dhB64); // 65바이트
  const authSecret  = b64urlDecode(authB64);   // 16바이트

  // 임시 sender ECDH 키쌍
  const ephemeral = await crypto.subtle.generateKey(
    { name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']
  );
  const senderJwk = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
  const senderPub = concat(new Uint8Array([0x04]), b64urlDecode(senderJwk.x), b64urlDecode(senderJwk.y)); // 65바이트

  // Receiver public 키 import
  const receiverKey = await crypto.subtle.importKey(
    'jwk',
    { kty:'EC', crv:'P-256',
      x: b64url(receiverPub.slice(1, 33)),
      y: b64url(receiverPub.slice(33, 65)) },
    { name:'ECDH', namedCurve:'P-256' },
    false, []
  );

  // ECDH 공유 비밀
  const sharedBits = await crypto.subtle.deriveBits(
    { name:'ECDH', public: receiverKey },
    ephemeral.privateKey, 256
  );
  const ecdhSecret = new Uint8Array(sharedBits);

  // Salt (16바이트 랜덤)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // PRK_key 도출: HKDF(auth, ecdhSecret, "WebPush: info\0" || receiver || sender, 32)
  const keyInfo = concat(
    new TextEncoder().encode('WebPush: info\0'),
    receiverPub,
    senderPub
  );
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // CEK: HKDF(salt, ikm, "Content-Encoding: aes128gcm\0", 16)
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  // Nonce: HKDF(salt, ikm, "Content-Encoding: nonce\0", 12)
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  // 평문 + 0x02 끝 마커 (RFC 8188 단일 레코드)
  const pt = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : new Uint8Array(plaintext);
  const padded = concat(pt, new Uint8Array([0x02]));

  // AES-GCM 암호화
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv: nonce }, cekKey, padded));

  // 헤더 조립: salt(16) + recordSize(4 BE) + keyIdLen(1=65) + keyId(senderPub 65) + ciphertext
  const recordSize = 4096;
  const header = new Uint8Array(21);
  header.set(salt, 0);
  header[16] = (recordSize >>> 24) & 0xff;
  header[17] = (recordSize >>> 16) & 0xff;
  header[18] = (recordSize >>>  8) & 0xff;
  header[19] =  recordSize         & 0xff;
  header[20] = 65;
  return { body: concat(header, senderPub, ct), salt, senderPub };
}

// 한 구독에 발송
async function sendWebPush(sub, payload, vapidPub, vapidPriv, subject) {
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
