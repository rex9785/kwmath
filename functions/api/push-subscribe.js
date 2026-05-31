import { safeError } from './_errors.js';
// /api/push-subscribe
// 브라우저 푸쉬 구독 정보 저장/해제.
// portal 페이지가 결정한 userId(이메일이든, 학생ID든, 휴대폰이든) 기준으로 묶음.
// 한 사용자 = 여러 기기/브라우저 가능 (구독 여러 개 누적, endpoint로 중복 제거).
//
// POST  — 구독 등록 (Body: { userId, subscription })
// DELETE — 구독 해제 (Body: { userId, endpoint })
//
// 저장: R2 key = push-subs/{userId}.json
// 구조: { userId, subs: [ { endpoint, keys: {p256dh, auth}, ua, savedAt } ], updatedAt }

export async function onRequest({ request, env }) {
  if (request.method === 'POST')   return handleSubscribe(request, env);
  if (request.method === 'DELETE') return handleUnsubscribe(request, env);
  return Response.json({ error: 'POST 또는 DELETE만 허용' }, { status: 405 });
}

// ───────── POST: 구독 등록 ─────────
async function handleSubscribe(request, env) {
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
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}

// ───────── DELETE: 구독 해제 ─────────
// body: { userId, endpoint? }
//   endpoint 명시 → 그 기기 1개만 해제
//   endpoint 없음 → 해당 userId의 모든 기기 해제 (계정 삭제용)
async function handleUnsubscribe(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}

  const userId = String(body.userId || '').trim();
  const endpoint = String(body.endpoint || '').trim();

  if (!userId)
    return Response.json({ error: 'userId 필수' }, { status: 400 });

  const key = `push-subs/${encodeURIComponent(userId)}.json`;

  try {
    const existing = await env.BUCKET.get(key);
    if (!existing) {
      // 이미 없으면 성공으로 처리 (idempotent)
      return Response.json({ ok: true, removed: 0, remaining: 0 });
    }
    const text = await existing.text();
    let record = JSON.parse(text);
    if (!record || !Array.isArray(record.subs)) record = { userId, subs: [] };

    const before = record.subs.length;
    if (endpoint) {
      // 특정 endpoint만 제거
      record.subs = record.subs.filter(s => s.endpoint !== endpoint);
    } else {
      // 전체 제거
      record.subs = [];
    }
    const removed = before - record.subs.length;
    record.userId = userId;
    record.updatedAt = new Date().toISOString();

    if (record.subs.length === 0) {
      // 구독 0개면 R2 파일 자체 삭제
      await env.BUCKET.delete(key);
    } else {
      await env.BUCKET.put(key, JSON.stringify(record), {
        httpMetadata: { contentType: 'application/json' }
      });
    }
    return Response.json({ ok: true, removed, remaining: record.subs.length });
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
