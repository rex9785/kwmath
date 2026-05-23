// POST /api/push-subscribe
// 브라우저 푸쉬 구독 정보를 받아 R2에 저장.
// portal 페이지가 결정한 userId(이메일이든, 학생ID든, 휴대폰이든) 기준으로 묶음.
// 한 사용자 = 여러 기기/브라우저 가능 (구독 여러 개 누적, endpoint로 중복 제거).
//
// Body: {
//   userId: string,                // portal이 결정한 식별자
//   subscription: PushSubscription // 브라우저 pushManager.subscribe() 결과
// }
//
// 인증: portal 페이지가 어떻게 인증하든 자유. 이 API는 userId 자체만 받음.
// (보안 강화 필요 시 portal에서 토큰 발급 후 헤더로 전달, 여기서 검증하는 식으로 확장 가능)
//
// 저장: R2 key = push-subs/{userId}.json
// 구조: { userId, subs: [ { endpoint, keys: {p256dh, auth}, ua, savedAt } ], updatedAt }

export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  let body = {};
  try { body = await request.json(); } catch {}

  const userId = String(body.userId || '').trim();
  const sub = body.subscription;

  if (!userId)
    return Response.json({ error: 'userId 필수' }, { status: 400 });
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
    return Response.json({ error: 'subscription 형식 오류' }, { status: 400 });

  const key = `push-subs/${encodeURIComponent(userId)}.json`;
  const ua = request.headers.get('user-agent') || '';

  // 기존 구독 로드 (있으면)
  let record = { userId, subs: [], updatedAt: '' };
  try {
    const existing = await env.BUCKET.get(key);
    if (existing) {
      const text = await existing.text();
      const parsed = JSON.parse(text);
      if (parsed && Array.isArray(parsed.subs)) record = parsed;
    }
  } catch {}

  // endpoint 기준 중복 제거 후 추가
  const filtered = record.subs.filter(s => s.endpoint !== sub.endpoint);
  filtered.push({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    ua,
    savedAt: new Date().toISOString()
  });
  record.subs = filtered;
  record.userId = userId;
  record.updatedAt = new Date().toISOString();

  try {
    await env.BUCKET.put(key, JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' }
    });
    return Response.json({ ok: true, deviceCount: record.subs.length });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
