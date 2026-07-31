// POST /api/admin-update-student-class (admin only) — Cloudflare D1 students (이전엔 Notion)
// body: { studentId, academy, className }  (studentId = D1 id, 문자열로 와도 숫자 변환)
// 효과: 학원/반 변경 + "특이사항"에 변경 로그 append

import { getStudentById, updateStudent } from './_db.js';
import { safeError } from './_errors.js';
import { logAudit, diffFields } from './_auditlog.js';

// 반이 바뀌면 학생 화면이 통째로 갈아엎어진다 — 로그마다 이 문장을 같이 남겨 원장이 파급을 바로 읽게 한다.
const 효과문구 = '반이 바뀌면 이 학생이 보는 공지·수업영상·과제가 전부 새 반 것으로 바뀐다. '
  + '이미 쌓인 출결·클리닉·성적·리포트는 학생 id에 붙어 있어 그대로 남지만, 반별 통계·반 평균에서는 새 반으로 잡힌다.';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) {
    // 🔒 인증 없는 반 변경 시도 — 학생 화면을 통째로 바꾸는 요청이라 시도 자체를 남긴다.
    await logAudit(env, request, {
      action: 'student.class.update.denied',
      summary: '학원/반 변경 거부(401) — 관리자 인증 없음',
      detail: { 결과: '아무것도 바뀌지 않음', 비고: '토큰·비밀번호 원문은 로그에 담지 않는다' },
    });
    return Response.json({ error: '인증 실패' }, { status: 401 });
  }

  let body = {};
  try { body = await request.json(); } catch {}
  const studentId = Number((body.studentId || '').toString().trim());
  const academy   = (body.academy   || '').toString().trim();
  const className = (body.className || '').toString().trim();

  // 반려(400)도 남긴다 — 화면 버그로 값이 안 실려 오는 경우를 사후에 구분해야 한다.
  const rejectMove = async (msg) => {
    await logAudit(env, request, {
      action: 'student.class.update.reject',
      target: body.studentId != null ? String(body.studentId).slice(0, 200) : '',
      summary: '학원/반 변경 반려(400) — ' + msg,
      detail: {
        받은학생id: body.studentId != null ? String(body.studentId) : '(없음)',
        받은학원: academy || '(안 보냄)', 받은반: className || '(안 보냄)',
        사유: msg, 결과: '아무것도 바뀌지 않음',
      },
    });
    return Response.json({ error: msg }, { status: 400 });
  };

  if (!body.studentId || !Number.isFinite(studentId)) return await rejectMove('studentId 필수');
  if (!academy && !className) return await rejectMove('academy 또는 className 중 하나 이상 필요');

  try {
    const st = await getStudentById(env, studentId);
    if (!st) {
      await logAudit(env, request, {
        action: 'student.class.update.miss',
        target: String(studentId),
        summary: '학원/반 변경 실패(404) — 학생(id ' + studentId + ')을 찾을 수 없음',
        detail: {
          학생id: String(studentId), 보내려던학원: academy || '(안 보냄)', 보내려던반: className || '(안 보냄)',
          추정원인: '퇴원·삭제된 학생이거나 화면이 옛 id를 들고 있음',
          결과: '아무것도 바뀌지 않음',
        },
      });
      return Response.json({ error: '학생을 찾을 수 없습니다' }, { status: 404 });
    }

    const oldAcademy   = st.academy || '';
    const oldClassName = st.className || '';
    const oldName      = st.name || '';
    const oldNotes     = st.notes || '';

    if (oldAcademy === academy && oldClassName === className) {
      // 📓 "반을 바꿨는데 그대로다"는 문의의 상당수가 원래 반과 똑같은 값을 저장한 경우다.
      //   성공만 남기면 이 경우가 통째로 사라져 요청이 서버까지 왔는지조차 확인이 안 된다.
      await logAudit(env, request, {
        action: 'student.class.update.noop',
        target: String(studentId), targetName: oldName,
        summary: '[' + (oldName || studentId) + '] 학원/반 변경 요청이 왔지만 원래와 같은 값 — '
          + (oldAcademy || '?') + ' · ' + (oldClassName || '?'),
        detail: {
          학생id: String(studentId), 이름: oldName,
          현재학원: oldAcademy, 현재반: oldClassName,
          보낸학원: academy, 보낸반: className,
          결과: 'DB 쓰기 안 함 · 특이사항(notes)에 변경 줄도 안 붙임',
        },
      });
      return Response.json({ ok: true, noChange: true, academy, className });
    }

    const now = new Date().toISOString().slice(0, 10);
    const logLine = '[' + now + '] 학원/반 변경: ' + (oldAcademy || '?') + '/' + (oldClassName || '?')
      + ' → ' + (academy || oldAcademy) + '/' + (className || oldClassName);
    const newNotes = oldNotes ? oldNotes + '\n' + logLine : logLine;

    const patch = { notes: newNotes };
    if (academy)   patch.academy = academy;
    if (className) patch.className = className;

    const r = await updateStudent(env, studentId, patch);
    if (!r.ok) {
      await logAudit(env, request, {
        action: 'student.class.update.fail',
        target: String(studentId), targetName: oldName,
        summary: '학원/반 변경 실패(DB 오류) [' + (oldName || studentId) + '] '
          + (oldAcademy || '?') + '/' + (oldClassName || '?') + ' → '
          + (academy || oldAcademy) + '/' + (className || oldClassName),
        detail: {
          학생id: String(studentId), 이름: oldName,
          바꾸려던값: { 전: { 학원: oldAcademy, 반: oldClassName },
                        후: { 학원: academy || oldAcademy, 반: className || oldClassName } },
          DB오류: String(r.error || '알 수 없는 오류').slice(0, 300),
          결과: '반은 그대로 · 특이사항(notes)에 변경 줄도 안 붙음',
        },
      });
      return safeError(r.error || 'updateStudent failed', env, { message: '학원/반 변경에 실패했습니다.' });
    }

    // 📓 2026-07-31 — 반 변경은 학생이 보는 화면 전체를 바꾸는 일인데 지금까지 기록이 특이사항(notes) 한 줄뿐이었다.
    //   그 한 줄에는 "누가" 바꿨는지가 없어서, 조교·원장 중 누구의 손인지 영영 알 수 없었다.
    //   actor·actor_name은 logAudit이 미들웨어 헤더에서 자동으로 채운다(이 API는 조교 차단 · 원장/관리자키 전용).
    const d = diffFields(r.before, r.after, ['academy', 'className']);
    await logAudit(env, request, {
      action: 'student.class.update',
      target: String(studentId), targetName: oldName,
      summary: '학원/반 변경 [' + (oldName || studentId) + '] '
        + (oldAcademy || '?') + ' · ' + (oldClassName || '?') + ' → '
        + (academy || oldAcademy) + ' · ' + (className || oldClassName),
      detail: {
        학생id: String(studentId), 이름: oldName,
        전: { 학원: oldAcademy, 반: oldClassName },
        후: { 학원: (r.after && r.after.academy) || (academy || oldAcademy),
              반:   (r.after && r.after.className) || (className || oldClassName) },
        바뀐칸: d.바뀐칸, 변경: d.변경,
        보낸값: { 학원: academy || '(안 보냄 — 기존 유지)', 반: className || '(안 보냄 — 기존 유지)' },
        특이사항에붙인줄: logLine.slice(0, 1000),
        특이사항길이: { 전: oldNotes.length, 후: newNotes.length },
        효과: 효과문구,
        비고: '이 API는 등록을 새로 만들지 않고 기존 등록의 학원/반 칸만 고친다. '
          + '한 학생을 두 반에 동시에 넣으려면 반 등록 추가(admin-add-enrollment)를 쓴다.',
      },
    });

    return Response.json({
      ok: true,
      name: oldName,
      from: { academy: oldAcademy, className: oldClassName },
      to:   { academy: academy || oldAcademy, className: className || oldClassName },
    });
  } catch (e) {
    return safeError(e, env, { message: '학원/반 변경에 실패했습니다.' });
  }
}
