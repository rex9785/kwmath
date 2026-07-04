// /api/push-prefs — 로그인한 학생/학부모 본인의 '푸시 카테고리 선호' 조회·설정
// ───────────────────────────────────────────────────────────
// GET  → { ok, prefs: { study:bool } }        (없으면 기본 ON 으로 채워 반환)
// POST { category:'study', on:bool } → { ok, prefs }
// 인증: requireStudentAccess. userId = access.phone (본인 것만 수정 — 클라가 보낸 userId 는 무시).
//   추월 푸시가 student_phone·parent_phone 로 가므로, 각자 자기 로그인 폰(=access.phone)으로 자기 선호를 끈다.
// ───────────────────────────────────────────────────────────
import { requireStudentAccess } from './_auth.js';
import { getPushPrefs, setPushPref } from './_prefs.js';

// 노출·설정 허용 카테고리 (화이트리스트 — 임의 키 저장 방지). 나중에 종류 추가 시 여기만 확장.
const ALLOWED = ['study'];

function withDefaults(prefs) {
  const out = {};
  for (const k of ALLOWED) out[k] = (prefs && prefs[k]) !== false;   // 기본 ON
  return out;
}

export async function onRequest({ request, env }) {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    return Response.json({ error: 'GET 또는 POST만 허용' }, { status: 405 });
  }

  const access = await requireStudentAccess(env, request);
  if (!access.ok) return access.response;
  const userId = access.phone;
  if (!userId) return Response.json({ error: '사용자 확인 실패' }, { status: 400 });

  if (method === 'GET') {
    const prefs = await getPushPrefs(env, userId);
    return Response.json({ ok: true, prefs: withDefaults(prefs) });
  }

  // POST — 카테고리 하나 켜기/끄기
  let body = {};
  try { body = await request.json(); } catch {}
  const category = String(body.category || '').trim();
  if (!ALLOWED.includes(category)) {
    return Response.json({ error: '알 수 없는 알림 종류' }, { status: 400 });
  }
  const on = body.on === true || body.on === 1 || body.on === 'true';
  try {
    const prefs = await setPushPref(env, userId, category, on);
    return Response.json({ ok: true, prefs: withDefaults(prefs) });
  } catch (e) {
    return Response.json({ error: '설정 저장에 실패했습니다.' }, { status: 500 });
  }
}
