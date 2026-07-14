// /api/reports-write — admin 전용 리포트 생성/수정/삭제 (Cloudflare D1 reports, 이전엔 Notion 82ef)
//   POST   { studentName, phone4?, date, school?, content?, homework?, notes? } — 생성 + 학부모 푸쉬
//     (phone4는 옛 '이름+끝4자리' 열람 인증의 잔재 — 지금은 포털 토큰 인증이라 선택값. 2026-07-09)
//   PATCH  { pageId, date?, school?, content?, homework?, notes? }             — 수정 (pageId = D1 id)
//   DELETE { pageId }                                                          — 삭제
// pageId는 문자열로 와도 숫자로 변환해서 D1 조회.

import { getStudentByName, createReport, updateReport, deleteReport } from './_db.js';
import { safeError } from './_errors.js';

// 학생 이름 → 학부모 휴대폰 (푸쉬 발송용, D1)
async function findParentPhone(env, studentName) {
  try {
    const st = await getStudentByName(env, studentName);
    return st && st.parentPhone ? st.parentPhone : null;
  } catch (e) {
    return null;
  }
}

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  // ── 생성 ──
  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}
    const { studentName, phone4, date, school, content, homework, notes } = body;
    if (!studentName || !date)
      return Response.json({ error: '학생 이름과 수업 날짜는 필수입니다.' }, { status: 400 });

    const r = await createReport(env, { studentName, phone4, date, school, content, homework, notes });
    if (!r.ok) return safeError(r.error || 'createReport failed', env, { message: '리포트 저장에 실패했습니다.' });

    // 푸쉬 알림 (비치명적 — 실패해도 생성은 성공)
    try {
      const parentPhone = await findParentPhone(env, studentName);
      if (parentPhone) {
        await fetch(new URL('/api/push-send', request.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: env.ADMIN_PASSWORD,
            userId: parentPhone,
            title: '📋 새 수업 리포트가 올라왔어요',
            body: studentName + ' 학생 — ' + date + ' 수업 내용을 확인해보세요',
            url: '/portal?tab=report',
            tag: 'report-' + studentName + '-' + date,
            nightSilent: true,   // 학부모 대상 → 밤(KST 23~7)엔 발송 건너뜀
          }),
        });
      }
    } catch (e) { /* 무시 */ }

    return Response.json({ ok: true, id: String(r.id) });
  }

  // ── 수정 ──
  if (request.method === 'PATCH') {
    let body = {};
    try { body = await request.json(); } catch {}
    const id = Number(body.pageId);
    if (!body.pageId || !Number.isFinite(id)) return Response.json({ error: 'pageId 필요' }, { status: 400 });

    const patch = {};
    if (typeof body.date     === 'string' && body.date)   patch.date = body.date;
    if (typeof body.school   === 'string' && body.school) patch.school = body.school;
    if (typeof body.content  === 'string')                patch.content = body.content;
    if (typeof body.homework === 'string')                patch.homework = body.homework;
    if (typeof body.notes    === 'string')                patch.notes = body.notes;

    const r = await updateReport(env, id, patch);
    if (!r.ok) return safeError(r.error || 'updateReport failed', env, { message: '리포트 수정에 실패했습니다.' });
    return Response.json({ ok: true });
  }

  // ── 삭제 ──
  if (request.method === 'DELETE') {
    let body = {};
    try { body = await request.json(); } catch {}
    const id = Number(body.pageId);
    if (!body.pageId || !Number.isFinite(id)) return Response.json({ error: 'pageId 필요' }, { status: 400 });

    const r = await deleteReport(env, id);
    if (!r.ok) return safeError(r.error || 'deleteReport failed', env, { message: '리포트 삭제에 실패했습니다.' });
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
