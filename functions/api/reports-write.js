// /api/reports-write — admin 전용 리포트 생성/수정/삭제 (Cloudflare D1 reports, 이전엔 Notion 82ef)
//   POST   { studentName, phone4?, date, school?, content?, homework?, notes? } — 생성 + 학부모 푸쉬
//     (phone4는 옛 '이름+끝4자리' 열람 인증의 잔재 — 지금은 포털 토큰 인증이라 선택값. 2026-07-09)
//   PATCH  { pageId, date?, school?, content?, homework?, notes? }             — 수정 (pageId = D1 id)
//   DELETE { pageId }                                                          — 삭제
// pageId는 문자열로 와도 숫자로 변환해서 D1 조회.

import { getStudentByName, createReport, updateReport, deleteReport, getReportByStudentAndDate } from './_db.js';
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

    // ── 재업로드 중복 가드: 같은 학생+같은 날짜 리포트가 이미 있으면 새로 쌓지 않고 그 행을 갱신 ──
    //    (7/01 실사고: MathOS에서 두 번 올려 학생당 2건 누적 → 수동 삭제. 이제 두 번 눌러도 최신 내용 1건.)
    //    푸시도 재발송 안 함 — 학부모는 첫 업로드 때 이미 받았음.
    const dup = await getReportByStudentAndDate(env, studentName, date);
    if (dup && dup.id != null) {
      const u = await updateReport(env, dup.id, { date, school, content, homework, notes });
      if (!u.ok) return safeError(u.error || 'updateReport(dedup) failed', env, { message: '리포트 저장에 실패했습니다.' });
      return Response.json({ ok: true, id: String(dup.id), deduped: true });
    }

    const r = await createReport(env, { studentName, phone4, date, school, content, homework, notes });
    if (!r.ok) return safeError(r.error || 'createReport failed', env, { message: '리포트 저장에 실패했습니다.' });

    // 푸쉬 알림 (비치명적 — 실패해도 생성은 성공)
    //   noPush=true면 조용히 생략 — "이미 올린 레포트를 다른 학생에게 복사"할 때 그 학부모엔 알림 안 보냄(관우T 확정 2026-07-23).
    if (!body.noPush) try {
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
            nightSilent: true,     // 학부모 대상 → 밤(KST 23~7)엔 즉시 발송 안 함
            queueIfNight: true,    // 드롭 대신 야간 큐 → 아침 07시~ 모아서 발송
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
