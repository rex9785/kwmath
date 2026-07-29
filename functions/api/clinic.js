// /api/clinic
// 클리닉 출석 + 성취도 + 시간 — Cloudflare D1 clinic 테이블 (수업 출결 attendance와 완전 별도).
// 학생 명단/인증은 _auth(현재 Notion). 이름 → D1 student_id 변환 후 D1 clinic 사용.
// 구조는 /api/attendance를 그대로 미러링하되, 클리닉 전용 필드(achieve·minutes)를 더했다.
//
// GET ?id=24 [&month=YYYY-MM]        — 특정 학생 기록 (권장 · admin/조교)
// GET ?name=홍길동 [&month=YYYY-MM]  — 구버전 호환 (동명이인이면 먼저 등록된 1명)
// GET ?all=1                         — 모든 학생 (admin only, 조교는 자기 학원만)
// POST { id | name, date, status?, achieve?, minutes?, note? } — 부분 업데이트 (admin·조교)
// DELETE { id | name, date }         — 그날 기록 삭제 (admin·조교)
//
// 🆔 2026-07-29 — 쓰기 경로에 id 수용(attendance.js와 동일 규약). 이름만으로 저장하면 동명이인 시 남의 기록에 들어간다.
//
// status: '출석' / '지각' / '결석' / '병결' / '공결'
// achieve(성취도): 0 / 25 / 50 / 75 / 100   minutes(클리닉 시간, 분): 0~780 (시 0~12·분 0~60)

import { requireStudentAccess } from './_auth.js';
import { getStudentsByPhone, resolveStudent, getClinic, upsertClinic, deleteClinic, listAllClinic, listStudents } from './_db.js';
import { staffScopeAcademy } from './_staff.js';
import { safeError } from './_errors.js';

const VALID_STATUS = ['출석', '지각', '결석', '병결', '공결'];
const VALID_ACHIEVE = [0, 25, 50, 75, 100];
const MAX_MINUTES = 12 * 60 + 60;   // 시 12 + 분 60 = 780

// 조교(X-Staff-Phone)면 "맡은 학원" 학생의 id·이름 Set, 원장이면 null(제한 없음).
//   미배정 조교는 빈 Set → 아무 기록도 못 봄. POST/DELETE는 미들웨어가 이미 403으로 막음.
//   🆔 권한 판정은 ids로 한다(동명이인 안전). names는 listAllClinic 구형 응답 대비용.
async function staffScope(env, request) {
  const academy = await staffScopeAcademy(env, request);
  if (academy === null) return null;                               // 원장 → 전체
  const roster = academy ? (await listStudents(env)).filter(s => (s.academy || '') === academy) : [];
  return { ids: new Set(roster.map(s => String(s.id))), names: new Set(roster.map(s => s.name)) };
}

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  const url = new URL(request.url);

  // ── GET ──
  if (request.method === 'GET') {
    // 조교 학원 스코프 (원장이면 null). isAdmin일 때만 의미 있음(학생/학부모는 자기 것만).
    const scope = isAdmin ? await staffScope(env, request) : null;

    // admin/조교 전체 (조교는 자기 학원만 필터)
    if (isAdmin && url.searchParams.get('all') === '1') {
      try {
        let out = await listAllClinic(env);
        if (scope) out = out.filter(e => (e.id != null ? scope.ids.has(String(e.id)) : scope.names.has(e.name)));
        return Response.json(out);
      } catch (e) {
        return safeError(e, env, { message: '클리닉 기록을 불러오지 못했습니다.' });
      }
    }

    // 특정 학생 (admin/조교: ?id 권장 · ?name 구버전 / 학생·학부모: 본인·자녀)
    const queryId = (url.searchParams.get('id') || '').trim();
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
        if (!queryId && !targetName) return Response.json({ error: 'id 또는 name 필수' }, { status: 400 });
        const st = await resolveStudent(env, queryId, targetName);
        // 조교가 자기 학원 밖 학생을 조회하면 빈 기록 반환(존재 여부도 숨김)
        if (scope && (!st || !scope.ids.has(String(st.id)))) {
          return Response.json({ name: targetName, records: {}, updatedAt: null });
        }
        studentId = st ? st.id : null;
        if (st) targetName = st.name;
      }
    } catch (e) {
      return safeError(e, env, { message: '클리닉 기록을 불러오지 못했습니다.' });
    }
    if (!studentId) return Response.json({ name: targetName, records: {}, updatedAt: null });

    const month = (url.searchParams.get('month') || '').trim();
    try {
      const got = await getClinic(env, studentId, month || undefined);
      return Response.json({ id: studentId, name: targetName, records: got.records, updatedAt: got.updatedAt });
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
    if (body.id === undefined && !name) return Response.json({ error: 'id 또는 name 필수' }, { status: 400 });
    if (!date) return Response.json({ error: 'date(YYYY-MM-DD) 필수' }, { status: 400 });

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
      const st = await resolveStudent(env, body.id, name);
      if (!st) return Response.json({ error: '학생을 D1에서 찾을 수 없습니다.' }, { status: 404 });
      // 조교는 자기 학원 학생만 입력 가능 (원장이면 scope=null → 통과) — 🆔 id로 판정
      const scope = await staffScope(env, request);
      if (scope && !scope.ids.has(String(st.id)))
        return Response.json({ error: '담당 학원 학생만 클리닉을 입력할 수 있어요.' }, { status: 403 });
      const r = await upsertClinic(env, st.id, date, updates);
      if (!r.ok) return safeError(r.error || 'upsertClinic failed', env, { message: '클리닉 저장에 실패했습니다.' });
      return Response.json({ ok: true, id: st.id, name: st.name, date, record: r.record });
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
    if ((body.id === undefined && !name) || !date) return Response.json({ error: '(id 또는 name) + date 필수' }, { status: 400 });

    try {
      const st = await resolveStudent(env, body.id, name);
      if (!st) return Response.json({ ok: true, removed: 0 });
      // 조교는 자기 학원 학생만 삭제 가능 (원장이면 scope=null → 통과) — 🆔 id로 판정
      const scope = await staffScope(env, request);
      if (scope && !scope.ids.has(String(st.id)))
        return Response.json({ error: '담당 학원 학생만 클리닉을 수정할 수 있어요.' }, { status: 403 });
      const r = await deleteClinic(env, st.id, date);
      return Response.json({ ok: true, removed: r.removed || 0 });
    } catch (e) {
      return safeError(e, env, { message: '클리닉 삭제에 실패했습니다.' });
    }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
