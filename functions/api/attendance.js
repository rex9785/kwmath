// /api/attendance
// 출석 + 숙제 완료율 — Cloudflare D1 attendance 테이블 (Phase 4 전환, 이전엔 R2 attendance/{name}.json)
// 학생 명단/인증은 _auth(현재 Notion). 이름 → D1 student_id 변환 후 D1 attendance 사용.
//
// GET ?name=홍길동 [&month=YYYY-MM]  — 특정 학생 기록 (admin 또는 본인/자녀)
// GET ?all=1                         — 모든 학생 (admin only)
// POST { name, date, status?, homework?, homework_note?, note? } — 부분 업데이트 (admin only)
// DELETE { name, date }              — 그날 기록 삭제 (admin only)
//
// status: '출석' / '지각' / '결석' / '병결' / '공결'   homework: 0~100

import { requireStudentAccess } from './_auth.js';
import { getStudentByName, getStudentsByPhone, getAttendance, upsertAttendance, deleteAttendance, listAllAttendance } from './_db.js';
import { safeError } from './_errors.js';

const VALID_STATUS = ['출석', '지각', '결석', '병결', '공결'];

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  const url = new URL(request.url);

  // ── GET ──
  if (request.method === 'GET') {
    // admin 전체
    if (isAdmin && url.searchParams.get('all') === '1') {
      try {
        const out = await listAllAttendance(env);
        return Response.json(out);
      } catch (e) {
        return safeError(e, env, { message: '출결 기록을 불러오지 못했습니다.' });
      }
    }

    // 특정 학생 (admin: ?name / 학생·학부모: 본인·자녀)
    let targetName = (url.searchParams.get('name') || '').trim();
    let studentId = null;
    try {
      if (!isAdmin) {
        const access = await requireStudentAccess(env, request);
        if (!access.ok) return access.response;
        targetName = access.student.name;
        const list = await getStudentsByPhone(env, access.phone);
        const me = list.find(s => s.name === targetName) || (list.length === 1 ? list[0] : null);
        studentId = me ? me.id : null;
      } else {
        if (!targetName) return Response.json({ error: 'name 필수' }, { status: 400 });
        const st = await getStudentByName(env, targetName);
        studentId = st ? st.id : null;
      }
    } catch (e) {
      return safeError(e, env, { message: '출결 기록을 불러오지 못했습니다.' });
    }
    if (!targetName) return Response.json({ error: 'name 필수' }, { status: 400 });
    if (!studentId) return Response.json({ name: targetName, records: {}, updatedAt: null });

    const month = (url.searchParams.get('month') || '').trim();
    try {
      const got = await getAttendance(env, studentId, month || undefined);
      return Response.json({ name: targetName, records: got.records, updatedAt: got.updatedAt });
    } catch (e) {
      return safeError(e, env, { message: '출결 기록을 불러오지 못했습니다.' });
    }
  }

  // ── POST: 부분 업데이트 (admin only) ──
  if (request.method === 'POST') {
    if (!isAdmin) return Response.json({ error: 'admin 인증 필요' }, { status: 401 });

    let body = {};
    try { body = await request.json(); } catch {}
    const name = (body.name || '').trim();
    const date = (body.date || '').trim();
    if (!name) return Response.json({ error: 'name 필수' }, { status: 400 });
    if (!date) return Response.json({ error: 'date(YYYY-MM-DD) 필수' }, { status: 400 });

    const updates = {};
    if (typeof body.status === 'string' && body.status) {
      if (!VALID_STATUS.includes(body.status))
        return Response.json({ error: 'status는 ' + VALID_STATUS.join('/') + ' 중 하나' }, { status: 400 });
      updates.status = body.status;
    }
    if (body.homework !== undefined && body.homework !== null && body.homework !== '') {
      const pct = Number(body.homework);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100)
        return Response.json({ error: 'homework는 0~100' }, { status: 400 });
      updates.homework = Math.round(pct);
    }
    if (typeof body.homework_note === 'string') updates.homework_note = body.homework_note;
    if (typeof body.note === 'string') updates.note = body.note;

    if (!Object.keys(updates).length)
      return Response.json({ error: '업데이트할 필드 없음(status/homework/homework_note/note)' }, { status: 400 });

    try {
      const st = await getStudentByName(env, name);
      if (!st) return Response.json({ error: '학생을 D1에서 찾을 수 없습니다. (신규 등록 학생이면 마이그레이션 재실행 필요)' }, { status: 404 });
      const r = await upsertAttendance(env, st.id, date, updates);
      if (!r.ok) return safeError(r.error || 'upsertAttendance failed', env, { message: '출결 저장에 실패했습니다.' });
      return Response.json({ ok: true, name, date, record: r.record });
    } catch (e) {
      return safeError(e, env, { message: '출결 저장에 실패했습니다.' });
    }
  }

  // ── DELETE: 특정 날짜 삭제 (admin only) ──
  if (request.method === 'DELETE') {
    if (!isAdmin) return Response.json({ error: 'admin 인증 필요' }, { status: 401 });
    let body = {};
    try { body = await request.json(); } catch {}
    const name = (body.name || '').trim();
    const date = (body.date || '').trim();
    if (!name || !date) return Response.json({ error: 'name + date 필수' }, { status: 400 });

    try {
      const st = await getStudentByName(env, name);
      if (!st) return Response.json({ ok: true, removed: 0 });
      const r = await deleteAttendance(env, st.id, date);
      return Response.json({ ok: true, removed: r.removed || 0 });
    } catch (e) {
      return safeError(e, env, { message: '출결 삭제에 실패했습니다.' });
    }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
