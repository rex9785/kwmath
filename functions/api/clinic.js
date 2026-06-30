// /api/clinic
// 클리닉 출석 + 성취도 + 시간 — Cloudflare D1 clinic 테이블 (수업 출결 attendance와 완전 별도).
// 학생 명단/인증은 _auth(현재 Notion). 이름 → D1 student_id 변환 후 D1 clinic 사용.
// 구조는 /api/attendance를 그대로 미러링하되, 클리닉 전용 필드(achieve·minutes)를 더했다.
//
// GET ?name=홍길동 [&month=YYYY-MM]  — 특정 학생 기록 (admin 또는 본인/자녀)
// GET ?all=1                         — 모든 학생 (admin only, 조교는 자기 학원만)
// POST { name, date, status?, achieve?, minutes?, note? } — 부분 업데이트 (admin·조교)
// DELETE { name, date }              — 그날 기록 삭제 (admin·조교)
//
// status: '출석' / '지각' / '결석' / '병결' / '공결'
// achieve(성취도): 0 / 25 / 50 / 75 / 100   minutes(클리닉 시간, 분): 0~780 (시 0~12·분 0~60)

import { requireStudentAccess } from './_auth.js';
import { getStudentByName, getStudentsByPhone, getClinic, upsertClinic, deleteClinic, listAllClinic, listStudents } from './_db.js';
import { staffScopeAcademy } from './_staff.js';
import { safeError } from './_errors.js';

const VALID_STATUS = ['출석', '지각', '결석', '병결', '공결'];
const VALID_ACHIEVE = [0, 25, 50, 75, 100];
const MAX_MINUTES = 12 * 60 + 60;   // 시 12 + 분 60 = 780

// 조교(X-Staff-Phone)면 "맡은 학원" 학생 이름 Set, 원장이면 null(제한 없음).
//   미배정 조교는 빈 Set → 아무 기록도 못 봄. POST/DELETE는 미들웨어가 이미 403으로 막음.
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
    // 조교 학원 스코프 (원장이면 null). isAdmin일 때만 의미 있음(학생/학부모는 자기 것만).
    const allowedNames = isAdmin ? await staffNameScope(env, request) : null;

    // admin/조교 전체 (조교는 자기 학원만 필터)
    if (isAdmin && url.searchParams.get('all') === '1') {
      try {
        let out = await listAllClinic(env);
        if (allowedNames) out = out.filter(e => allowedNames.has(e.name));
        return Response.json(out);
      } catch (e) {
        return safeError(e, env, { message: '클리닉 기록을 불러오지 못했습니다.' });
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
        // 조교가 자기 학원 밖 학생을 조회하면 빈 기록 반환(존재 여부도 숨김)
        if (allowedNames && !allowedNames.has(targetName)) {
          return Response.json({ name: targetName, records: {}, updatedAt: null });
        }
        const st = await getStudentByName(env, targetName);
        studentId = st ? st.id : null;
      }
    } catch (e) {
      return safeError(e, env, { message: '클리닉 기록을 불러오지 못했습니다.' });
    }
    if (!targetName) return Response.json({ error: 'name 필수' }, { status: 400 });
    if (!studentId) return Response.json({ name: targetName, records: {}, updatedAt: null });

    const month = (url.searchParams.get('month') || '').trim();
    try {
      const got = await getClinic(env, studentId, month || undefined);
      return Response.json({ name: targetName, records: got.records, updatedAt: got.updatedAt });
    } catch (e) {
      return safeError(e, env, { message: '클리닉 기록을 불러오지 못했습니다.' });
    }
  }

  // ── POST: 부분 업데이트 (admin·조교) ──
  if (request.method === 'POST') {
    if (!isAdmin) return Response.json({ error: 'admin 인증 필요' }, { status: 401 });

    let body = {};
    try { body = await request.json(); } catch {}
    const name = (body.name || '').trim();
    const date = (body.date || '').trim();
    if (!name) return Response.json({ error: 'name 필수' }, { status: 400 });
    if (!date) return Response.json({ error: 'date(YYYY-MM-DD) 필수' }, { status: 400 });

    // 조교는 자기 학원 학생만 입력 가능 (원장이면 allowedNames=null → 통과)
    const allowedNames = await staffNameScope(env, request);
    if (allowedNames && !allowedNames.has(name))
      return Response.json({ error: '담당 학원 학생만 클리닉을 입력할 수 있어요.' }, { status: 403 });

    const updates = {};
    if (typeof body.status === 'string' && body.status) {
      if (!VALID_STATUS.includes(body.status))
        return Response.json({ error: 'status는 ' + VALID_STATUS.join('/') + ' 중 하나' }, { status: 400 });
      updates.status = body.status;
    }
    if (body.achieve !== undefined && body.achieve !== null && body.achieve !== '') {
      const a = Number(body.achieve);
      if (!VALID_ACHIEVE.includes(a))
        return Response.json({ error: 'achieve(성취도)는 ' + VALID_ACHIEVE.join('/') + ' 중 하나' }, { status: 400 });
      updates.achieve = a;
    }
    if (body.minutes !== undefined && body.minutes !== null && body.minutes !== '') {
      const m = Number(body.minutes);
      if (!Number.isFinite(m) || m < 0 || m > MAX_MINUTES || Math.round(m) !== m)
        return Response.json({ error: 'minutes(시간)는 0~' + MAX_MINUTES + '분 사이 정수' }, { status: 400 });
      updates.minutes = m;
    }
    if (typeof body.note === 'string') updates.note = body.note;

    if (!Object.keys(updates).length)
      return Response.json({ error: '업데이트할 필드 없음(status/achieve/minutes/note)' }, { status: 400 });

    try {
      const st = await getStudentByName(env, name);
      if (!st) return Response.json({ error: '학생을 D1에서 찾을 수 없습니다.' }, { status: 404 });
      const r = await upsertClinic(env, st.id, date, updates);
      if (!r.ok) return safeError(r.error || 'upsertClinic failed', env, { message: '클리닉 저장에 실패했습니다.' });
      return Response.json({ ok: true, name, date, record: r.record });
    } catch (e) {
      return safeError(e, env, { message: '클리닉 저장에 실패했습니다.' });
    }
  }

  // ── DELETE: 특정 날짜 삭제 (admin·조교) ──
  if (request.method === 'DELETE') {
    if (!isAdmin) return Response.json({ error: 'admin 인증 필요' }, { status: 401 });
    let body = {};
    try { body = await request.json(); } catch {}
    const name = (body.name || '').trim();
    const date = (body.date || '').trim();
    if (!name || !date) return Response.json({ error: 'name + date 필수' }, { status: 400 });

    // 조교는 자기 학원 학생만 삭제 가능 (원장이면 allowedNames=null → 통과)
    const allowedNames = await staffNameScope(env, request);
    if (allowedNames && !allowedNames.has(name))
      return Response.json({ error: '담당 학원 학생만 클리닉을 수정할 수 있어요.' }, { status: 403 });

    try {
      const st = await getStudentByName(env, name);
      if (!st) return Response.json({ ok: true, removed: 0 });
      const r = await deleteClinic(env, st.id, date);
      return Response.json({ ok: true, removed: r.removed || 0 });
    } catch (e) {
      return safeError(e, env, { message: '클리닉 삭제에 실패했습니다.' });
    }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
