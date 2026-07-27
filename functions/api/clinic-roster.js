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
  getStudentById, getStudentByName, listStudents,
  listAttendanceByDate, listClinicByDate,
  listClinicRoster, setClinicRoster, deleteClinicRoster,
} from './_db.js';
import { staffScopeAcademy } from './_staff.js';
import { safeError } from './_errors.js';

const HW_THRESHOLD = 50;                 // 숙제 이 % 이하면 자동 포함
const ABSENT_STATUSES = ['결석', '지각']; // 병결·공결은 제외(정당한 사유)

// 서버(UTC) → KST(+9) 기준 오늘 YYYY-MM-DD
function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// student_id 정규화 — D1이 JS 숫자를 REAL로 바인딩해 TEXT칸에 "24.0"으로 저장된 과거 데이터와
//   "24"를 같은 키로 수렴시킨다(_makeup.js·_db.js setClinicRoster와 동일 규칙). 이 정규화가 없으면
//   클리닉명단 오버라이드(수동추가/제외)의 student_id "24.0"이 attendance·students의 "24"와 안 맞아
//   → 수동추가 이름 유실('수동 추가'만 뜸) · 제외해도 명단에서 안 빠짐(delete 키 불일치).
function normSid(id) { return String(id == null ? '' : id).trim().replace(/\.0+$/, ''); }

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  if (!isAdmin) return Response.json({ error: 'admin 인증 필요' }, { status: 401 });

  const url = new URL(request.url);
  const scopeAcademy = await staffScopeAcademy(env, request);   // null=원장 · ''=미배정 조교 · '학원명'=조교

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
      for (const s of students) byId[normSid(s.id)] = s;
      const clinicById = {};
      for (const c of clinic) clinicById[normSid(c.student_id)] = c;

      // 수동 오버라이드 분리
      const addMap = new Map();          // student_id → reason
      const excludeSet = new Set();
      for (const o of overrides) {
        if (o.action === 'add') addMap.set(normSid(o.student_id), o.reason || '');
        else if (o.action === 'exclude') excludeSet.add(normSid(o.student_id));
      }

      const roster = {};                 // student_id → entry
      const ensure = (sid, name) => {
        const key = normSid(sid);        // 모든 roster 키를 표준형("24")으로 — attendance/override 혼용 대비
        if (!roster[key]) {
          const s = byId[key];
          roster[key] = {
            studentId: key,
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
        return roster[key];
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

      // 조교 스코프(자기 학원만) — 이름이 아니라 학원으로 필터(동명이인 안전). 미배정('')이면 전부 빠짐.
      if (scopeAcademy !== null) {
        const inScope = e => !!scopeAcademy && (String(e.academy || '').trim() === scopeAcademy);
        list = list.filter(inScope);
        excluded = excluded.filter(inScope);
      }

      list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
      excluded.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
      // isOwner=원장만 true(scopeAcademy===null). 조교앱에서 학부모 클리닉결석 알림 발송 버튼을 숨기는 데 사용.
      return Response.json({ date, threshold: HW_THRESHOLD, roster: list, excluded, isOwner: scopeAcademy === null });
    } catch (e) {
      return safeError(e, env, { message: '클리닉 명단을 불러오지 못했습니다.' });
    }
  }

  // ── POST: 수동 추가/제외/해제 ──
  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}
    const studentId = (body.studentId != null ? String(body.studentId) : '').trim();
    const name = (body.name || '').trim();
    const date = (body.date || '').trim() || todayKST();
    const action = (body.action || '').trim();                 // add | exclude | clear
    const reason = typeof body.reason === 'string' ? body.reason : '';
    if (!studentId && !name) return Response.json({ error: 'studentId 또는 name 필수' }, { status: 400 });
    if (!['add', 'exclude', 'clear'].includes(action))
      return Response.json({ error: 'action은 add/exclude/clear 중 하나' }, { status: 400 });

    try {
      // id 우선 해석(동명이인 안전), 없으면 이름 폴백
      const st = studentId ? await getStudentById(env, studentId) : await getStudentByName(env, name);
      if (!st) return Response.json({ error: '학생을 D1에서 찾을 수 없습니다.' }, { status: 404 });

      // 조교는 자기 학원 학생만. id로 해석한 학생의 학원으로 검사(원장=null→통과, 미배정 조교=''→전부 차단).
      if (scopeAcademy !== null && (!scopeAcademy || String(st.academy || '').trim() !== scopeAcademy))
        return Response.json({ error: '담당 학원 학생만 명단을 수정할 수 있어요.' }, { status: 403 });

      if (action === 'clear') {
        const r = await deleteClinicRoster(env, st.id, date);
        return Response.json({ ok: true, name: st.name, studentId: String(st.id), date, removed: r.removed || 0 });
      }
      const r = await setClinicRoster(env, st.id, date, action, reason);
      if (!r.ok) return safeError(r.error || 'setClinicRoster failed', env, { message: '명단 저장에 실패했습니다.' });
      return Response.json({ ok: true, name: st.name, studentId: String(st.id), date, action });
    } catch (e) {
      return safeError(e, env, { message: '명단 저장에 실패했습니다.' });
    }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
