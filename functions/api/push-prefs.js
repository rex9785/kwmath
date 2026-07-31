// /api/push-prefs — 로그인한 학생/학부모 본인의 '푸시 카테고리 선호' 조회·설정
// ───────────────────────────────────────────────────────────
// GET  → { ok, prefs: { study:bool } }        (없으면 기본 ON 으로 채워 반환)
// POST { category:'study', on:bool } → { ok, prefs }
// 인증: requireStudentAccess. userId = access.phone (본인 것만 수정 — 클라가 보낸 userId 는 무시).
//   추월 푸시가 student_phone·parent_phone 로 가므로, 각자 자기 로그인 폰(=access.phone)으로 자기 선호를 끈다.
// ───────────────────────────────────────────────────────────
import { requireStudentAccess } from './_auth.js';
import { getPushPrefs, setPushPref } from './_prefs.js';
import { logAudit } from './_auditlog.js';

// 카테고리 코드 → 사람이 읽는 이름. 로그에 'study' 만 남기면 나중에 무슨 알림인지 알 수 없다.
const CATEGORY_LABEL = { study: 'KW-Study 친구 추월 알림' };

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
    const r = await setPushPref(env, userId, category, on);
    // 📓 "알림이 안 와요" 신고의 첫 번째 원인이 여기다 — 본인이 껐는데 기억 못 하는 경우.
    //    끈 시각·기기까지 남아야 답할 수 있다. 행위자는 미들웨어가 아니라 **본인(포털 토큰의 전화번호)**이다.
    const 이전값 = r.before && r.before[category] !== undefined ? (r.before[category] !== false) : true;
    await logAudit(env, request, {
      action: 'push.pref.change',
      actor: userId, actorRole: (access.student && access.student.role) || 'student',
      actorName: (access.student && access.student.name) || '',
      target: userId, targetName: CATEGORY_LABEL[category] || category,
      summary: (CATEGORY_LABEL[category] || category) + ' 알림 ' + (이전값 ? '켜짐' : '꺼짐') + ' → ' + (on ? '켜짐' : '꺼짐')
        + ' (' + userId + ')',
      detail: {
        알림종류: CATEGORY_LABEL[category] || category,
        코드: category,
        전: 이전값 ? '켜짐' : '꺼짐',
        후: on ? '켜짐' : '꺼짐',
        실제변경: 이전값 !== on,
        이전전체설정: r.before,
        이후전체설정: r.prefs,
        저장위치: r.key,
        첫설정: r.새파일,
        효과: on
          ? '이 번호로 ' + (CATEGORY_LABEL[category] || category) + ' 푸시가 다시 간다.'
          : '이 번호로는 ' + (CATEGORY_LABEL[category] || category) + ' 푸시가 더 이상 가지 않는다. 다른 알림(리포트·공지)은 그대로 간다.',
        비고: '설정한 사람은 로그인한 본인이다(클라이언트가 보낸 userId 는 무시하고 토큰의 전화번호를 쓴다). 저장 파일에 설정값 외 개인정보는 없다.',
      },
    });
    return Response.json({ ok: true, prefs: withDefaults(r.prefs) });
  } catch (e) {
    // 저장 실패도 남긴다 — "껐는데 계속 온다"의 원인이 여기일 수 있다.
    await logAudit(env, request, {
      action: 'push.pref.fail',
      actor: userId, actorRole: (access.student && access.student.role) || 'student',
      target: userId, targetName: CATEGORY_LABEL[category] || category,
      summary: (CATEGORY_LABEL[category] || category) + ' 알림 설정 저장 실패 — ' + String((e && e.message) || e).slice(0, 100),
      detail: {
        알림종류: CATEGORY_LABEL[category] || category,
        바꾸려던값: on ? '켜짐' : '꺼짐',
        오류: String((e && e.message) || e),
        효과: '설정이 저장되지 않았다. 이전 상태 그대로 알림이 간다(사용자는 바뀐 줄 알 수 있다).',
      },
    });
    return Response.json({ error: '설정 저장에 실패했습니다.' }, { status: 500 });
  }
}
