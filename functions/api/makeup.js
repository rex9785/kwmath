// /api/makeup — 인강 신청/해제
//   결석·병결·공결이면 그날 영상+수업자료가 자동 잠긴다. 여기서 신청·승인·해제를 처리한다.
//
//   GET  (학생/학부모) [?name=]          → 본인/자녀 신청·해제 목록 { ok, grants:[{date,status}] }
//   GET  (admin/조교)  ?all=1[&status=]  → 전체 목록(이름 포함). 조교는 자기 학원 학생만.
//   POST (학생/학부모) { name?, date }   → 그 날짜 인강 신청 (status=requested)
//   POST (admin/조교)  { action, name|studentId, date }
//        action='approve'|'grant' → 해제(approved) / 'revoke' → 취소(다시 잠금)
//
//   ※ 학생 식별은 studentId(동명이인 안전) 우선, 없으면 name.
import { requireStudentAccess } from './_auth.js';
import { listStudentsByName, getStudentById, listStudents } from './_db.js';
import { staffScopeAcademy } from './_staff.js';
import { safeError } from './_errors.js';
import { listGrantsForStudent, requestMakeup, approveMakeup, revokeMakeup, listAllGrants } from './_makeup.js';
import { logAudit, actorOf } from './_auditlog.js';

// 조교(X-Staff-Phone)면 "맡은 학원" 학생 **id** Set, 원장이면 null(제한 없음). 미배정 조교는 빈 Set.
//   👥 2026-07-31 — 예전엔 이름 Set 이었다. 세정학원에 김민준이 있으면 대치동 김민준의
//     인강 해제 내역까지 목록에 딸려 나왔다(이름만 같으면 통과). id 로 바꾸면 그런 일이 없다.
async function staffIdScope(env, request) {
  const academy = await staffScopeAcademy(env, request);
  if (academy === null) return null;                               // 원장 → 전체
  const roster = academy ? (await listStudents(env)).filter(s => (s.academy || '') === academy) : [];
  return new Set(roster.map(s => String(s.id)));
}

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  const url = new URL(request.url);

  // ── GET ──
  if (request.method === 'GET') {
    // admin/조교 전체 목록 (조교는 자기 학원만)
    if (isAdmin && url.searchParams.get('all') === '1') {
      try {
        const status = (url.searchParams.get('status') || '').trim();
        let out = await listAllGrants(env, status || undefined);
        const allowed = await staffIdScope(env, request);
        if (allowed) out = out.filter(g => allowed.has(String(g.student_id)));
        return Response.json(out);
      } catch (e) { return safeError(e, env, { message: '목록을 불러오지 못했습니다.' }); }
    }
    // 학생/학부모: 본인·자녀 것만
    try {
      const access = await requireStudentAccess(env, request);
      if (!access.ok) return access.response;
      const grants = await listGrantsForStudent(env, access.student.id);
      return Response.json({ ok: true, student: access.student.name, grants });
    } catch (e) { return safeError(e, env, { message: '목록을 불러오지 못했습니다.' }); }
  }

  // ── POST ──
  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}

    // 관리자/조교: 승인·직접해제·취소
    if (isAdmin) {
      const action = (body.action || 'grant').toString().trim();
      const date = (body.date || '').toString().trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        return Response.json({ error: 'date(YYYY-MM-DD) 필수' }, { status: 400 });

      // 학생 식별 — studentId 우선, 없으면 name
      //   👥 2026-07-31 — 이름 폴백이 getStudentByName(ORDER BY id LIMIT 1) 이었다. 같은 이름이 2명이면
      //     먼저 등록된 쪽의 영상 잠금이 조용히 풀렸다(= 결석한 날 수업영상을 엉뚱한 학생이 보게 됨).
      //     2명 이상이면 아무것도 하지 않고 409로 되돌린다.
      let st = null;
      if (body.studentId !== undefined && body.studentId !== null && String(body.studentId) !== '') {
        st = await getStudentById(env, body.studentId);
      } else if ((body.name || '').trim()) {
        const 후보 = await listStudentsByName(env, body.name.trim());
        if (후보.length > 1) {
          return Response.json({
            error: '같은 이름 학생이 ' + 후보.length + '명이라 누구인지 확정할 수 없어요. 학생 목록에서 학생을 골라 주세요.',
            동명이인수: 후보.length,
            후보목록: 후보.map((s) => ({ id: String(s.id), 학원: s.academy || '', 반: s.className || '' })),
          }, { status: 409 });
        }
        st = 후보[0] || null;
      }
      if (!st) return Response.json({ error: '학생을 찾을 수 없습니다. (name 또는 studentId 필요)' }, { status: 404 });

      // 조교는 자기 학원 학생만 (원장이면 allowed=null → 통과). 이름이 아니라 학생 id로 검사한다.
      const allowed = await staffIdScope(env, request);
      if (allowed && !allowed.has(String(st.id)))
        return Response.json({ error: '담당 학원 학생만 처리할 수 있어요.' }, { status: 403 });

      try {
        // 📓 2026-07-31 — approved_by 에 여태 'admin' 다섯 글자만 박혀 있었다. 조교가 여럿인데
        //   누가 열어줬는지 DB만 봐선 영영 알 수 없었다(homework.js checked_by 와 같은 문제).
        //   미들웨어가 검증해 실어 보낸 실제 이름/번호를 쓴다.
        const who = actorOf(request, env);
        const 승인자표기 = (who.actorRole === 'staff' && (who.actorName || who.actor))
          ? ((who.actorName || '조교') + '(' + (who.actor || '') + ')')
          : (who.actorRole === 'owner' ? '원장' : 'admin');

        const r = (action === 'revoke')
          ? await revokeMakeup(env, st.id, date)
          : await approveMakeup(env, st.id, date, 승인자표기);
        if (!r.ok) return safeError(r.error || 'makeup write failed', env, { message: '처리에 실패했습니다.' });

        // 📓 인강 해제 = 결석한 날의 영상·수업자료 잠금을 푸는 일이다.
        //   여태 아무 기록이 없어, 안 온 날 영상을 누가 왜 열어줬는지 확인할 방법이 없었다.
        const 전 = r.before || null;
        await logAudit(env, request, {
          action: action === 'revoke' ? 'makeup.revoke' : 'makeup.approve',
          target: String(st.id), targetName: st.name || '',
          summary: '인강 ' + (action === 'revoke' ? '해제 취소(다시 잠금)' : '해제 승인')
            + ' [' + (st.name || st.id) + ' · ' + date + '] — '
            + (action === 'revoke'
               ? ('전: ' + (전 ? 전.status : '기록 없음') + ' · 삭제 ' + (r.removed || 0) + '건')
               : ('전: ' + (전 ? 전.status : '기록 없음') + ' → approved'
                  + (전 && 전.status === 'requested' ? ' (학생이 신청한 건 승인)' : ' (원장/조교가 직접 열어줌)'))),
          detail: {
            학생id: String(st.id), 이름: st.name || '', 학원: st.academy || '', 반: st.className || '',
            날짜: date,
            전: 전 || '(그 날짜 기록 없음)',
            후: action === 'revoke' ? '(행 삭제 — 다시 잠김)'
              : { status: 'approved', approved_by: 승인자표기, approved_at: r.approvedAt || '' },
            승인자표기, 지목방식: (body.studentId !== undefined && String(body.studentId) !== '') ? 'studentId(동명이인 안전)' : 'name 폴백',
            처리범위: allowed ? '조교(담당 학원 학생만)' : '원장(전체)',
            효과: action === 'revoke'
              ? '이 날짜 수업영상·수업자료가 다시 잠긴다(출석/지각 기록이 있으면 원래 열려 있음)'
              : '이 날짜 수업영상·수업자료가 열린다 — 결석·기록없음이어도 열람 가능해짐',
            삭제건수: action === 'revoke' ? (r.removed || 0) : undefined,
          },
        });
        return Response.json({ ok: true, action, studentId: st.id, name: st.name, date });
      } catch (e) { return safeError(e, env, { message: '처리에 실패했습니다.' }); }
    }

    // 학생/학부모: 인강 신청 (자녀 여러 명일 때 body.name으로 올바른 자녀 지정)
    try {
      const access = await requireStudentAccess(env, request, { name: (body.name || '').trim() });
      if (!access.ok) return access.response;
      const date = (body.date || '').toString().trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        return Response.json({ error: 'date(YYYY-MM-DD) 필수' }, { status: 400 });
      const r = await requestMakeup(env, access.student.id, date);
      if (!r.ok) return safeError(r.error || 'makeup request failed', env, { message: '신청에 실패했습니다.' });

      // 📓 학생·학부모가 신청한 것도 남긴다 — "신청했는데 안 열어줬다"는 말이 나오면
      //   신청이 실제로 접수됐는지(그리고 이미 approved라 무시됐는지)를 여기서 확인한다.
      await logAudit(env, request, {
        action: 'makeup.request',
        actor: String(access.student.id), actorRole: 'student', actorName: access.student.name || '',
        target: String(access.student.id), targetName: access.student.name || '',
        summary: '인강 신청 [' + (access.student.name || access.student.id) + ' · ' + date + '] — '
          + (r.created ? '접수(requested)' : '이미 ' + r.status + ' 상태라 그대로 둠'),
        detail: {
          학생id: String(access.student.id), 이름: access.student.name || '', 날짜: date,
          전: r.before || '(그 날짜 기록 없음)',
          후: r.created ? { status: 'requested', requested_at: r.requestedAt || '' } : '(변화 없음)',
          새로접수: !!r.created,
          비고: r.created
            ? '원장/조교가 승인해야 실제로 영상·자료가 열린다'
            : '이미 신청/승인된 날짜 — 중복 신청은 상태를 낮추지 않는다(다운그레이드 금지)',
        },
      });
      return Response.json({ ok: true, status: r.status, date });
    } catch (e) { return safeError(e, env, { message: '신청에 실패했습니다.' }); }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
