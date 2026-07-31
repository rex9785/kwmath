// /api/reports-write — admin 전용 리포트 생성/수정/삭제 (Cloudflare D1 reports, 이전엔 Notion 82ef)
//   POST   { studentName, phone4?, date, school?, content?, homework?, notes? } — 생성 + 학부모 푸쉬
//     (phone4는 옛 '이름+끝4자리' 열람 인증의 잔재 — 지금은 포털 토큰 인증이라 선택값. 2026-07-09)
//   PATCH  { pageId, date?, school?, content?, homework?, notes? }             — 수정 (pageId = D1 id)
//   DELETE { pageId }                                                          — 삭제
// pageId는 문자열로 와도 숫자로 변환해서 D1 조회.

import { getStudentByName, createReport, updateReport, deleteReport, getReportByStudentAndDate } from './_db.js';
import { safeError } from './_errors.js';
import { sendPushToUsers } from './_push.js';   // 🔔 2026-07-30 — 웹푸시+FCM 병행 (push-send 경유 시 FCM 미발송 버그 수정)
import { logAudit, diffFields } from './_auditlog.js';

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

      // 📓 2026-07-31 — 이 경로는 겉보기엔 "생성"인데 실제로는 **기존 리포트 덮어쓰기**다.
      //   MathOS에서 두 번 올리면 학부모가 이미 읽은 내용이 조용히 바뀐다 → 전/후를 반드시 남긴다.
      const d = diffFields(u.before, u.after, ['date', 'school', 'content', 'homework', 'notes']);
      await logAudit(env, request, {
        action: 'report.overwrite',
        target: String(dup.id), targetName: studentName,
        summary: '리포트 덮어쓰기 [' + studentName + ' · ' + date + '] (같은 날짜 재업로드) — ' + (d.요약 || '내용 동일'),
        detail: {
          리포트id: dup.id, 학생: studentName, 수업일: date,
          바뀐칸: d.바뀐칸, 변경: d.변경,
          이전내용: u.before || null,
          경로: '같은 학생+같은 날짜 중복 가드 — 새로 쌓지 않고 기존 행 갱신',
          푸시: '재발송 안 함(학부모는 첫 업로드 때 이미 받음)',
        },
      });
      return Response.json({ ok: true, id: String(dup.id), deduped: true });
    }

    const r = await createReport(env, { studentName, phone4, date, school, content, homework, notes });
    if (!r.ok) return safeError(r.error || 'createReport failed', env, { message: '리포트 저장에 실패했습니다.' });

    await logAudit(env, request, {
      action: 'report.create',
      target: String(r.id || ''), targetName: studentName,
      summary: '리포트 작성 [' + studentName + ' · ' + date + ']' + (body.noPush ? ' (푸시 없음 — 복사 등록)' : ''),
      detail: {
        리포트id: r.id, 학생: studentName, 수업일: date, 학원: school || '대치동 정규반',
        수업내용: content || '', 숙제: homework || '', 특이사항: notes || '',
        푸시보냄: !body.noPush,
      },
    });

    // 푸쉬 알림 (비치명적 — 실패해도 생성은 성공)
    //   noPush=true면 조용히 생략 — "이미 올린 레포트를 다른 학생에게 복사"할 때 그 학부모엔 알림 안 보냄(관우T 확정 2026-07-23).
    if (!body.noPush) try {
      const parentPhone = await findParentPhone(env, studentName);
      if (parentPhone) {
        // 🔔 2026-07-30 — push-send(웹푸시 전용) 경유 → sendPushToUsers(웹+FCM 병행)로 교체.
        //   앱(WebView) 학부모는 FCM만 등록돼 있어 기존 경로로는 낮 리포트 푸시를 못 받았다
        //   (밤 리포트만 야간 큐→sendPushToUsers를 타서 받는 비대칭 버그). 야간 정책은 동일 유지.
        await sendPushToUsers(env, [parentPhone], {
          title: '📋 새 수업 리포트가 올라왔어요',
          body: studentName + ' 학생 — ' + date + ' 수업 내용을 확인해보세요',
          url: '/portal?tab=report',
          tag: 'report-' + studentName + '-' + date,
        }, {
          nightSilent: true,     // 학부모 대상 → 밤(KST 23~7)엔 즉시 발송 안 함
          queueIfNight: true,    // 드롭 대신 야간 큐 → 아침 07시~ 모아서 발송
          queueTag: 'report',
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

    // 📓 리포트 본문은 학부모가 읽는 글이다. 어느 칸을 무엇에서 무엇으로 고쳤는지 통째로 남긴다.
    const d = diffFields(r.before, r.after, ['date', 'school', 'content', 'homework', 'notes']);
    await logAudit(env, request, {
      action: 'report.update',
      target: String(id),
      targetName: (r.before && r.before.studentName) || (r.after && r.after.studentName) || '',
      summary: '리포트 수정 [' + (((r.before && r.before.studentName) || '') + ' · ' + ((r.before && r.before.date) || '')).trim()
        + '] — ' + (d.요약 || '변경 없음'),
      detail: {
        리포트id: id,
        학생: (r.before && r.before.studentName) || '',
        바뀐칸: d.바뀐칸, 변경: d.변경,
        보낸값: patch,
        수정전전문: r.before || null,     // 본문 전체 — 잘못 고쳤을 때 되돌릴 근거
      },
    });
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

    // 🔴 되돌릴 수 없음 — 지워진 리포트 전문을 로그에 통째로 박는다. 이게 유일한 복원 근거.
    await logAudit(env, request, {
      action: 'report.delete',
      target: String(id), targetName: (r.before && r.before.studentName) || '',
      summary: '리포트 삭제 [' + (((r.before && r.before.studentName) || '') + ' · ' + ((r.before && r.before.date) || '')).trim()
        + '] 영구 삭제 (복구 불가)',
      detail: {
        리포트id: id,
        지워진리포트: r.before || '(행을 못 읽음 — 이미 없었을 수 있음)',
        삭제건수: r.removed,
        비고: r.removed === 0 ? '지울 행이 없었음' : '학부모 앱에서 즉시 사라짐',
      },
    });
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
