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
import { getStudentByName, getStudentById, listStudents } from './_db.js';
import { staffScopeAcademy } from './_staff.js';
import { safeError } from './_errors.js';
import { listGrantsForStudent, requestMakeup, approveMakeup, revokeMakeup, listAllGrants } from './_makeup.js';

// 조교(X-Staff-Phone)면 "맡은 학원" 학생 이름 Set, 원장이면 null(제한 없음). 미배정 조교는 빈 Set.
async function staffNameScope(env, request) {
  const academy = await staffScopeAcademy(env, request);
  if (academy === null) return null;                               // 원장 → 전체
  const roster = academy ? (await listStudents(env)).filter(s => (s.academy || '') === academy) : [];
  return new Set(roster.map(s => s.name));
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
        const allowed = await staffNameScope(env, request);
        if (allowed) out = out.filter(g => allowed.has(g.name));
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
      let st = null;
      if (body.studentId !== undefined && body.studentId !== null && String(body.studentId) !== '') {
        st = await getStudentById(env, body.studentId);
      } else if ((body.name || '').trim()) {
        st = await getStudentByName(env, body.name.trim());
      }
      if (!st) return Response.json({ error: '학생을 찾을 수 없습니다. (name 또는 studentId 필요)' }, { status: 404 });

      // 조교는 자기 학원 학생만 (원장이면 allowed=null → 통과)
      const allowed = await staffNameScope(env, request);
      if (allowed && !allowed.has(st.name))
        return Response.json({ error: '담당 학원 학생만 처리할 수 있어요.' }, { status: 403 });

      try {
        const r = (action === 'revoke')
          ? await revokeMakeup(env, st.id, date)
          : await approveMakeup(env, st.id, date, 'admin');
        if (!r.ok) return safeError(r.error || 'makeup write failed', env, { message: '처리에 실패했습니다.' });
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
      return Response.json({ ok: true, status: r.status, date });
    } catch (e) { return safeError(e, env, { message: '신청에 실패했습니다.' }); }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
