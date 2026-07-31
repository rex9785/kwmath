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
//
// 🔒 1기기 = 1계정 (2026-07-31 신설)
//   등록할 때 "이 토큰(=이 폰)이 물려 있던 다른 계정"에서 자동으로 뺀다.
//   이게 없으면 학생이 선생님 폰으로 한 번 로그인한 흔적이 영원히 남아,
//   그 학생에게 보낸 알림이 선생님 폰까지 울린다(2026-07-31 실제 발생).
//   역인덱스 fcm-owner/{sha256(token)}.json = { userId, updatedAt } 로 O(1) 유지.
//   인덱스가 없는 토큰(배포 전부터 있던 기기)은 그 첫 1회만 전수 스캔해서 정리한다.
//   ⚠️ 예약 id(__admin__ 등)는 양방향 예외 — 원장은 관리자 알림과 본인 포털 계정을
//      한 폰에서 같이 써야 하므로, 서로를 밀어내면 안 된다.

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

// ───────── 1기기 = 1계정 헬퍼 ─────────
const TOKENS_PREFIX = 'fcm-tokens/';
const OWNER_PREFIX  = 'fcm-owner/';

async function ownerKey(token) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${OWNER_PREFIX}${hex}.json`;
}

function uidFromTokensKey(key) {
  try { return decodeURIComponent(key.slice(TOKENS_PREFIX.length, -'.json'.length)); }
  catch { return ''; }
}

// 특정 userId의 기록에서 토큰 1개만 뺀다. 남는 게 없으면 키 자체를 지움.
async function removeTokenFrom(env, uid, token) {
  const k = `${TOKENS_PREFIX}${encodeURIComponent(uid)}.json`;
  const obj = await env.BUCKET.get(k);
  if (!obj) return false;
  let rec;
  try { rec = JSON.parse(await obj.text()); } catch { return false; }
  if (!rec || !Array.isArray(rec.tokens)) return false;
  const before = rec.tokens.length;
  rec.tokens = rec.tokens.filter(t => t && t.token !== token);
  if (rec.tokens.length === before) return false;
  rec.userId = uid;
  rec.updatedAt = new Date().toISOString();
  if (rec.tokens.length === 0) await env.BUCKET.delete(k);
  else await env.BUCKET.put(k, JSON.stringify(rec), { httpMetadata: { contentType: 'application/json' } });
  return true;
}

// 역인덱스에 없는(=배포 전부터 있던) 토큰만 전수 스캔으로 정리. 기기당 최초 1회만 돈다.
async function legacySweep(env, keepUid, token) {
  const moved = [];
  const listed = await env.BUCKET.list({ prefix: TOKENS_PREFIX, limit: 1000 });
  for (const o of (listed.objects || [])) {
    const uid = uidFromTokensKey(o.key);
    if (!uid || uid === keepUid || isReservedUserId(uid)) continue;   // 예약 id는 건드리지 않음
    try { if (await removeTokenFrom(env, uid, token)) moved.push(uid); } catch {}
  }
  return moved;
}

// 등록 직전에 호출. 실패해도 등록 자체는 절대 막지 않는다(best-effort).
async function claimDeviceForUser(env, userId, token) {
  if (isReservedUserId(userId)) return [];   // __admin__ 등록은 다른 계정을 밀어내지 않음
  const okey = await ownerKey(token);
  let prevUid = '';
  let hadIndex = false;
  try {
    const o = await env.BUCKET.get(okey);
    if (o) { hadIndex = true; prevUid = String((JSON.parse(await o.text()) || {}).userId || ''); }
  } catch {}

  let moved = [];
  if (hadIndex) {
    if (prevUid && prevUid !== userId && !isReservedUserId(prevUid)) {
      if (await removeTokenFrom(env, prevUid, token)) moved.push(prevUid);
    }
  } else {
    moved = await legacySweep(env, userId, token);
  }

  await env.BUCKET.put(okey, JSON.stringify({ userId, updatedAt: new Date().toISOString() }), {
    httpMetadata: { contentType: 'application/json' },
  });
  return moved;
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

  const key = `${TOKENS_PREFIX}${encodeURIComponent(userId)}.json`;
  const ua = request.headers.get('user-agent') || '';

  // 🔒 1기기 = 1계정 — 이 폰이 물려 있던 다른 계정에서 먼저 뺀다(실패해도 등록은 진행).
  let movedFrom = [];
  try { movedFrom = await claimDeviceForUser(env, userId, token); } catch (_) {}

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
    return Response.json({ ok: true, deviceCount: record.tokens.length, movedFrom });
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

  const key = `${TOKENS_PREFIX}${encodeURIComponent(userId)}.json`;

  try {
    const existing = await env.BUCKET.get(key);
    if (!existing) {
      return Response.json({ ok: true, removed: 0, remaining: 0 });  // idempotent
    }
    let record = JSON.parse(await existing.text());
    if (!record || !Array.isArray(record.tokens)) record = { userId, tokens: [] };

    const before = record.tokens.length;
    const dropped = token ? [token] : record.tokens.map(t => t && t.token).filter(Boolean);
    record.tokens = token ? record.tokens.filter(t => t && t.token !== token) : [];
    const removed = before - record.tokens.length;
    record.userId = userId;
    record.updatedAt = new Date().toISOString();

    // 역인덱스도 같이 정리 — 이 계정이 소유자로 적혀 있을 때만 지운다(다른 계정 소유권은 보존).
    for (const tk of dropped) {
      try {
        const okey = await ownerKey(tk);
        const o = await env.BUCKET.get(okey);
        if (o && String((JSON.parse(await o.text()) || {}).userId || '') === userId) {
          await env.BUCKET.delete(okey);
        }
      } catch (_) {}
    }

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
