// /api/clinic-roster
// "클리닉 필수 명단" — 그날 클리닉에 반드시 와야 하는 학생 목록.
//   자동 포함(OR 조건, attendance에서 파생):
//     (1) 그날 숙제 완료율 50% 이하
//     (2) 그날 결석 또는 지각        (병결·공결은 정당한 사유 → 제외)
//     (3) 수동 추가(add)
//   자동조건이어도 수동 제외(exclude)하면 명단에서 빠진다.
//
//   조회/수정: admin(원장) · 조교만. 조교는 자기 학원 학생만(X-Staff-Phone).
//   학생/학부모는 접근 불가(다른 학생 정보가 섞이므로).
//
// GET  ?date=YYYY-MM-DD           — 그날 명단 (생략 시 오늘, KST)
// POST { name, date?, action, reason? }
//        action: 'add'(강제 포함) | 'exclude'(자동이어도 제외) | 'clear'(수동표시 삭제 → 자동조건만 적용)

import {
  getStudentByName, listStudents,
  listAttendanceByDate, listClinicByDate,
  listClinicRoster, setClinicRoster, deleteClinicRoster,
} from './_db.js';
import { staffScopeAcademy } from './_staff.js';
import { safeError } from './_errors.js';

const HW_THRESHOLD = 50;                 // 숙제 이 % 이하면 자동 포함
const ABSENT_STATUSES = ['결석', '지각']; // 병결·공결은 제외(정당한 사유)

// 조교면 "맡은 학원" 학생 이름 Set, 원장이면 null(제한 없음). 미배정 조교는 빈 Set.
async function staffNameScope(env, request) {
  const academy = await staffScopeAcademy(env, request);
  if (academy === null) return null;
  const roster = academy ? (await listStudents(env)).filter(s => (s.academy || '') === academy) : [];
  return new Set(roster.map(s => s.name));
}

// 서버(UTC) → KST(+9) 기준 오늘 YYYY-MM-DD
function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  if (!isAdmin) return Response.json({ error: 'admin 인증 필요' }, { status: 401 });

  const url = new URL(request.url);
  const allowedNames = await staffNameScope(env, request);   // null=원장, Set=조교

  // ── GET: 그날 명단 ──
  if (request.method === 'GET') {
    const date = (url.searchParams.get('date') || '').trim() || todayKST();
    try {
      const [students, att, clinic, overrides] = await Promise.all([
        listStudents(env),
        listAttendanceByDate(env, date),
        listClinicByDate(env, date),
        listClinicRoster(env, date),
      ]);

      const byId = {};
      for (const s of students) byId[s.id] = s;
      const clinicById = {};
      for (const c of clinic) clinicById[c.student_id] = c;

      // 수동 오버라이드 분리
      const addMap = new Map();          // student_id → reason
      const excludeSet = new Set();
      for (const o of overrides) {
        if (o.action === 'add') addMap.set(o.student_id, o.reason || '');
        else if (o.action === 'exclude') excludeSet.add(o.student_id);
      }

      const roster = {};                 // student_id → entry
      const ensure = (sid, name) => {
        if (!roster[sid]) {
          const s = byId[sid];
          roster[sid] = {
            studentId: sid,
            name: name || (s ? s.name : ''),
            academy: s ? s.academy : '',
            grade: s ? s.grade : '',
            reasons: [],
            manual: false,
            attStatus: null,
            homework: null,
            clinicStatus: null,          // 실제 클리닉 참석 상태(null=기록 없음)
          };
        }
        return roster[sid];
      };

      // (1)(2) 자동조건 — 그날 attendance 기록에서
      for (const a of att) {
        const reasons = [];
        if (ABSENT_STATUSES.includes(a.status)) reasons.push(a.status);
        const hw = (a.homework === null || a.homework === undefined) ? null : Number(a.homework);
        if (hw !== null && hw <= HW_THRESHOLD) reasons.push('숙제 ' + hw + '%');
        if (!reasons.length) continue;
        const e = ensure(a.student_id, a.name);
        e.reasons.push(...reasons);
        e.attStatus = a.status || null;
        e.homework = hw;
      }

      // (3) 수동 추가
      for (const [sid, reason] of addMap) {
        const e = ensure(sid);
        e.manual = true;
        e.reasons.push(reason ? ('수동: ' + reason) : '수동 추가');
      }

      // 수동 제외 (자동조건이어도 뺀다)
      for (const sid of excludeSet) delete roster[sid];

      // 실제 클리닉 참석 상태 부착 + 명단 배열화
      let list = Object.values(roster);
      for (const e of list) {
        const c = clinicById[e.studentId];
        e.clinicStatus = c && c.status ? c.status : null;
      }

      // 수동 제외한 학생(되돌리기 UI용) — 이름 붙여서 별도로 내려준다
      let excluded = [];
      for (const sid of excludeSet) {
        const s = byId[sid];
        excluded.push({ studentId: sid, name: s ? s.name : '', academy: s ? s.academy : '' });
      }

      // 조교 스코프(자기 학원만) — 미배정 조교면 빈 Set → 전부 필터됨
      if (allowedNames) {
        list = list.filter(e => allowedNames.has(e.name));
        excluded = excluded.filter(e => allowedNames.has(e.name));
      }

      list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
      excluded.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
      return Response.json({ date, threshold: HW_THRESHOLD, roster: list, excluded });
    } catch (e) {
      return safeError(e, env, { message: '클리닉 명단을 불러오지 못했습니다.' });
    }
  }

  // ── POST: 수동 추가/제외/해제 ──
  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}
    const name = (body.name || '').trim();
    const date = (body.date || '').trim() || todayKST();
    const action = (body.action || '').trim();                 // add | exclude | clear
    const reason = typeof body.reason === 'string' ? body.reason : '';
    if (!name) return Response.json({ error: 'name 필수' }, { status: 400 });
    if (!['add', 'exclude', 'clear'].includes(action))
      return Response.json({ error: 'action은 add/exclude/clear 중 하나' }, { status: 400 });

    // 조교는 자기 학원 학생만 (원장이면 allowedNames=null → 통과)
    if (allowedNames && !allowedNames.has(name))
      return Response.json({ error: '담당 학원 학생만 명단을 수정할 수 있어요.' }, { status: 403 });

    try {
      const st = await getStudentByName(env, name);
      if (!st) return Response.json({ error: '학생을 D1에서 찾을 수 없습니다.' }, { status: 404 });
      if (action === 'clear') {
        const r = await deleteClinicRoster(env, st.id, date);
        return Response.json({ ok: true, name, date, removed: r.removed || 0 });
      }
      const r = await setClinicRoster(env, st.id, date, action, reason);
      if (!r.ok) return safeError(r.error || 'setClinicRoster failed', env, { message: '명단 저장에 실패했습니다.' });
      return Response.json({ ok: true, name, date, action });
    } catch (e) {
      return safeError(e, env, { message: '명단 저장에 실패했습니다.' });
    }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
