import { safeError } from './_errors.js';
// /api/push-register-fcm
// 안드로이드 네이티브 앱(Capacitor)에서 받은 FCM 디바이스 토큰 저장/해제.
// portal/admin-qna 페이지가 결정한 userId(휴대폰 등) 기준으로 묶음.
// 한 사용자 = 여러 기기 가능 (token으로 중복 제거, 최근 20개만 유지).
//
// POST   — 토큰 등록 (Body: { userId, token })
// DELETE — 토큰 해제 (Body: { userId, token? })  token 없으면 전체 해제
//
// 저장: R2 key = fcm-tokens/{userId}.json
// 구조: { userId, tokens: [ { token, ua, savedAt } ], updatedAt }

export async function onRequest({ request, env }) {
  if (request.method === 'POST')   return handleRegister(request, env);
  if (request.method === 'DELETE') return handleUnregister(request, env);
  return Response.json({ error: 'POST 또는 DELETE만 허용' }, { status: 405 });
}

// 예약(시스템) userId 보호 — push-subscribe.js와 동일 규약.
//   '__' 접두 id(__admin__ 등)는 관리자/조교 인증(Bearer ADMIN_PASSWORD, 미들웨어 번역)이 있을 때만 조작 허용.
//   학생 전화번호 id는 종전대로 무인증 허용.
function isReservedUserId(id) { return typeof id === 'string' && id.startsWith('__'); }
function adminAuthed(request, env) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  return !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
}
function reservedGuard(userId, request, env) {
  if (isReservedUserId(userId) && !adminAuthed(request, env)) {
    return Response.json({ error: '권한이 없습니다.' }, { status: 403 });
  }
  return null;
}

// ───────── POST: 토큰 등록 ─────────
async function handleRegister(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}

  const userId = String(body.userId || '').trim();
  const token  = String(body.token  || '').trim();

  if (!userId) return Response.json({ error: 'userId 필수' }, { status: 400 });
  const guard = reservedGuard(userId, request, env);
  if (guard) return guard;
  if (!token)  return Response.json({ error: 'token 필수' }, { status: 400 });

  const key = `fcm-tokens/${encodeURIComponent(userId)}.json`;
  const ua = request.headers.get('user-agent') || '';

  // 기존 토큰 로드 (있으면)
  let record = { userId, tokens: [], updatedAt: '' };
  try {
    const existing = await env.BUCKET.get(key);
    if (existing) {
      const parsed = JSON.parse(await existing.text());
      if (parsed && Array.isArray(parsed.tokens)) record = parsed;
    }
  } catch {}

  // token 기준 중복 제거 후 추가, 최근 20개만 유지
  const filtered = record.tokens.filter(t => t && t.token !== token);
  filtered.push({ token, ua, savedAt: new Date().toISOString() });
  record.tokens = filtered.slice(-20);
  record.userId = userId;
  record.updatedAt = new Date().toISOString();

  try {
    await env.BUCKET.put(key, JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' }
    });
    return Response.json({ ok: true, deviceCount: record.tokens.length });
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}

// ───────── DELETE: 토큰 해제 ─────────
// body: { userId, token? }
//   token 명시 → 그 기기 1개만 해제
//   token 없음 → 해당 userId의 모든 기기 해제 (계정 삭제·로그아웃용)
async function handleUnregister(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}

  const userId = String(body.userId || '').trim();
  const token  = String(body.token  || '').trim();

  if (!userId) return Response.json({ error: 'userId 필수' }, { status: 400 });
  const guard = reservedGuard(userId, request, env);
  if (guard) return guard;

  const key = `fcm-tokens/${encodeURIComponent(userId)}.json`;

  try {
    const existing = await env.BUCKET.get(key);
    if (!existing) {
      return Response.json({ ok: true, removed: 0, remaining: 0 });  // idempotent
    }
    let record = JSON.parse(await existing.text());
    if (!record || !Array.isArray(record.tokens)) record = { userId, tokens: [] };

    const before = record.tokens.length;
    record.tokens = token ? record.tokens.filter(t => t && t.token !== token) : [];
    const removed = before - record.tokens.length;
    record.userId = userId;
    record.updatedAt = new Date().toISOString();

    if (record.tokens.length === 0) {
      await env.BUCKET.delete(key);
    } else {
      await env.BUCKET.put(key, JSON.stringify(record), {
        httpMetadata: { contentType: 'application/json' }
      });
    }
    return Response.json({ ok: true, removed, remaining: record.tokens.length });
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
