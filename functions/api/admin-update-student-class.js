// POST /api/admin-update-student-class (admin only) — Cloudflare D1 students (이전엔 Notion)
// body: { studentId, academy, className }  (studentId = D1 id, 문자열로 와도 숫자 변환)
// 효과: 학원/반 변경 + "특이사항"에 변경 로그 append

import { getStudentById, updateStudent } from './_db.js';
import { safeError } from './_errors.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const studentId = Number((body.studentId || '').toString().trim());
  const academy   = (body.academy   || '').toString().trim();
  const className = (body.className || '').toString().trim();

  if (!body.studentId || !Number.isFinite(studentId)) return Response.json({ error: 'studentId 필수' }, { status: 400 });
  if (!academy && !className) return Response.json({ error: 'academy 또는 className 중 하나 이상 필요' }, { status: 400 });

  try {
    const st = await getStudentById(env, studentId);
    if (!st) return Response.json({ error: '학생을 찾을 수 없습니다' }, { status: 404 });

    const oldAcademy   = st.academy || '';
    const oldClassName = st.className || '';
    const oldName      = st.name || '';
    const oldNotes     = st.notes || '';

    if (oldAcademy === academy && oldClassName === className) {
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
    if (!r.ok) return safeError(r.error || 'updateStudent failed', env, { message: '학원/반 변경에 실패했습니다.' });

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
