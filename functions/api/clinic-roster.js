// /api/clinic-roster
// "클리닉 명단" — 그날 클리닉에 와야 하는 학생 목록.
//
// 📌 2026-07-31 모델 반전 (관우T 지시: "클리닉을 제외시킬 사람을 고르는 걸로 하자, 기본적으로는 다 들어가 있고")
//   예전: 자동조건(숙제 50%↓·결석·지각)에 걸린 학생 "만" 명단에 들어왔다 → 나머지는 아예 없는 사람 취급.
//   지금: 그날 클리닉이 있는 반의 학생이 "전원 기본 포함" → 원장/조교는 뺄 사람만 고른다.
//   자동조건은 이제 포함 조건이 아니라 priority(꼭 남겨야 할 학생) 표시로만 남는다.
//
// 기본 포함 판정 (학생 1명 기준, key = "학원/반"):
//   schedules[key] 없음               → 그날 attendance 기록이 있으면 포함  (시간표 미설정 반 안전망)
//   schedules[key].clinic.days 있음   → 그날이 clinic.days 에 있을 때만 포함
//   그 외(수업 days 만 있음)          → 그날이 days 에 있을 때 포함 (클리닉을 수업 뒤에 붙이는 기본형)
//   ※ 승인 안 된 학생(대기중·거부)은 제외. 퇴원생은 students 테이블에 이미 없다.
//
// 날짜별 오버라이드(clinic_roster 테이블):
//   action='exclude' → 기본 포함이어도 뺀다
//   action='add'     → 기본 포함이 아니어도 넣는다 (다른 반 학생 보충 등)
//   action='clear'   → 수동 표시 삭제 → 기본 판정으로 복귀
//
//   조회/수정: admin(원장) · 조교만. 조교는 자기 학원 학생만(X-Staff-Phone).
//   학생/학부모는 접근 불가(다른 학생 정보가 섞이므로).
//
// GET  ?date=YYYY-MM-DD           — 그날 명단 (생략 시 오늘, KST)
// POST { name|studentId, date?, action, reason? }                 — 한 명
// POST { studentIds: [...], date?, action, reason? }              — 일괄(반 전체 제외/포함)
//        action: 'add' | 'exclude' | 'clear'

import {
  getStudentById, getStudentByName, listStudents,
  listAttendanceByDate, listClinicByDate,
  listClinicRoster, setClinicRoster, deleteClinicRoster,
} from './_db.js';
import { loadClassSchedules } from './class-options.js';
import { staffScopeAcademy } from './_staff.js';
import { safeError } from './_errors.js';

const HW_THRESHOLD = 50;                 // 숙제 이 % 이하면 priority(우선) 표시
const ABSENT_STATUSES = ['결석', '지각']; // 병결·공결은 제외(정당한 사유)
const BULK_MAX = 300;                    // 일괄 처리 1회 상한 (반 전체라도 이 정도면 충분)

// 서버(UTC) → KST(+9) 기준 오늘 YYYY-MM-DD
function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' → 0(일)~6(토). 서버 타임존과 무관하게 그 "달력 날짜"의 요일.
// (schedules.days 규약과 동일 — class-options.js 참조)
function dowOf(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '').trim());
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
}

// student_id 정규화 — D1이 JS 숫자를 REAL로 바인딩해 TEXT칸에 "24.0"으로 저장된 과거 데이터와
//   "24"를 같은 키로 수렴시킨다(_makeup.js·_db.js setClinicRoster와 동일 규칙). 이 정규화가 없으면
//   클리닉명단 오버라이드(수동추가/제외)의 student_id "24.0"이 attendance·students의 "24"와 안 맞아
//   → 수동추가 이름 유실('수동 추가'만 뜸) · 제외해도 명단에서 안 빠짐(delete 키 불일치).
function normSid(id) { return String(id == null ? '' : id).trim().replace(/\.0+$/, ''); }

// 이 반이 그날 클리닉 대상인가.
//   true=대상 · false=아님 · null=시간표가 없어 판단 불가(→ 호출부에서 attendance 폴백)
function classInClinicToday(sch, dow) {
  if (!sch || dow === null) return null;
  const cd = (sch.clinic && Array.isArray(sch.clinic.days)) ? sch.clinic.days.map(Number) : null;
  if (cd && cd.length) return cd.includes(dow);           // 클리닉 요일이 따로 설정돼 있으면 그것만 따른다
  const d = Array.isArray(sch.days) ? sch.days.map(Number) : null;
  if (d && d.length) return d.includes(dow);              // 없으면 수업일 = 클리닉일
  return null;
}

// 승인 학생만(대기중/거부 제외; 빈 값=옛 학생 통과 — admin-notify.html과 동일 규칙)
function approved(s) {
  const st = String((s && s.approvalStatus) || '').trim();
  return st === '' || st === '승인';
}

function sortKo(a, b) {
  return (String(a.academy || '')).localeCompare(String(b.academy || ''), 'ko')
      || (String(a.className || '')).localeCompare(String(b.className || ''), 'ko')
      || (String(a.name || '')).localeCompare(String(b.name || ''), 'ko');
}

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  if (!isAdmin) return Response.json({ error: 'admin 인증 필요' }, { status: 401 });

  const url = new URL(request.url);
  const scopeAcademy = await staffScopeAcademy(env, request);   // null=원장 · ''=미배정 조교 · '학원명'=조교

  // ── GET: 그날 명단 ──
  if (request.method === 'GET') {
    const date = (url.searchParams.get('date') || '').trim() || todayKST();
    const dow = dowOf(date);
    try {
      const [students, att, clinic, overrides, schedules] = await Promise.all([
        listStudents(env),
        listAttendanceByDate(env, date),
        listClinicByDate(env, date),
        listClinicRoster(env, date),
        loadClassSchedules(env).catch(() => ({})),   // 시간표를 못 읽어도 명단은 뜬다(attendance 폴백)
      ]);

      const byId = {};
      for (const s of students) byId[normSid(s.id)] = s;
      const clinicById = {};
      for (const c of clinic) clinicById[normSid(c.student_id)] = c;
      const attById = {};
      for (const a of att) attById[normSid(a.student_id)] = a;

      // 수동 오버라이드 분리
      const addMap = new Map();          // student_id → reason
      const excludeSet = new Set();
      for (const o of overrides) {
        if (o.action === 'add') addMap.set(normSid(o.student_id), o.reason || '');
        else if (o.action === 'exclude') excludeSet.add(normSid(o.student_id));
      }

      const entryOf = (sid, s, source) => ({
        studentId: sid,
        name: s ? (s.name || '') : '',
        academy: s ? (s.academy || '') : '',
        className: s ? (s.className || '') : '',
        grade: s ? (s.grade || '') : '',
        source,                          // 'schedule' | 'attendance' | 'manual' — 왜 명단에 들어왔는지
        manual: false,
        priority: false,                 // 자동조건(숙제↓·결석·지각) → 꼭 남겨야 할 학생
        reasons: [],
        attStatus: null,
        homework: null,
        clinicStatus: null,              // 실제 클리닉 참석 상태(null=기록 없음)
      });

      // ── ① 기본 포함 — 그날 클리닉이 있는 반의 학생 전원 ──
      const roster = {};
      let unscheduled = 0;               // 시간표 미설정이라 attendance 폴백으로 들어온 수(진단용)
      for (const s of students) {
        if (!approved(s)) continue;
        const sid = normSid(s.id);
        const key = (s.academy || '') + '/' + (s.className || '');
        const verdict = classInClinicToday(schedules[key], dow);
        if (verdict === null) {
          if (!attById[sid]) continue;   // 시간표도 없고 그날 기록도 없다 → 판단 근거 없음
          roster[sid] = entryOf(sid, s, 'attendance');
          unscheduled++;
        } else if (verdict) {
          roster[sid] = entryOf(sid, s, 'schedule');
        }
      }

      // ── ② 수동 추가 — 기본 포함이 아니어도 넣는다 ──
      for (const [sid, reason] of addMap) {
        if (!roster[sid]) roster[sid] = entryOf(sid, byId[sid], 'manual');
        roster[sid].manual = true;
        roster[sid].manualReason = reason || '';
      }

      // ── ③ 출결·클리닉 기록 붙이고 사유 배지 구성 ──
      for (const e of Object.values(roster)) {
        const a = attById[e.studentId];
        if (a) {
          e.attStatus = a.status || null;
          const hw = (a.homework === null || a.homework === undefined) ? null : Number(a.homework);
          e.homework = hw;
          if (ABSENT_STATUSES.includes(a.status)) { e.reasons.push(a.status); e.priority = true; }
          if (hw !== null && hw <= HW_THRESHOLD) { e.reasons.push('숙제 ' + hw + '%'); e.priority = true; }
        }
        if (e.manual) e.reasons.push(e.manualReason ? ('수동: ' + e.manualReason) : '수동 추가');
        delete e.manualReason;
        const c = clinicById[e.studentId];
        e.clinicStatus = c && c.status ? c.status : null;
      }

      // ── ④ 수동 제외 (기본 포함이어도 뺀다) ──
      for (const sid of excludeSet) delete roster[sid];

      let list = Object.values(roster);

      // 제외한 학생(되돌리기 UI용) — 반 정보까지 붙여서 화면에서 제자리에 흐리게 남길 수 있게
      let excluded = [];
      for (const sid of excludeSet) {
        const s = byId[sid];
        excluded.push({
          studentId: sid,
          name: s ? (s.name || '') : '',
          academy: s ? (s.academy || '') : '',
          className: s ? (s.className || '') : '',
          grade: s ? (s.grade || '') : '',
        });
      }

      // 조교 스코프(자기 학원만) — 이름이 아니라 학원으로 필터(동명이인 안전). 미배정('')이면 전부 빠짐.
      if (scopeAcademy !== null) {
        const inScope = e => !!scopeAcademy && (String(e.academy || '').trim() === scopeAcademy);
        list = list.filter(inScope);
        excluded = excluded.filter(inScope);
      }

      list.sort(sortKo);
      excluded.sort(sortKo);
      // isOwner=원장만 true(scopeAcademy===null). 조교앱에서 학부모 클리닉결석 알림 발송 버튼을 숨기는 데 사용.
      return Response.json({
        date, dow,
        mode: 'default-in',              // 화면이 옛 모델("자동조건만 포함")과 구분하는 스위치
        threshold: HW_THRESHOLD,
        unscheduled,                     // 시간표 미설정이라 출결기록으로 주워 온 인원(0이면 전부 시간표 기준)
        roster: list, excluded,
        isOwner: scopeAcademy === null,
      });
    } catch (e) {
      return safeError(e, env, { message: '클리닉 명단을 불러오지 못했습니다.' });
    }
  }

  // ── POST: 수동 추가/제외/해제 (한 명 또는 일괄) ──
  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}
    const date = (body.date || '').trim() || todayKST();
    const action = (body.action || '').trim();                 // add | exclude | clear
    const reason = typeof body.reason === 'string' ? body.reason : '';
    if (!['add', 'exclude', 'clear'].includes(action))
      return Response.json({ error: 'action은 add/exclude/clear 중 하나' }, { status: 400 });

    // ── 일괄(반 전체 제외/포함) ──
    const rawIds = Array.isArray(body.studentIds) ? body.studentIds : null;
    if (rawIds) {
      const ids = Array.from(new Set(rawIds.map(normSid).filter(Boolean)));
      if (!ids.length) return Response.json({ error: 'studentIds가 비었습니다.' }, { status: 400 });
      if (ids.length > BULK_MAX)
        return Response.json({ error: '한 번에 ' + BULK_MAX + '명까지만 처리할 수 있어요.' }, { status: 400 });
      try {
        const students = await listStudents(env);              // id 조회 N번 대신 1번
        const byId = {};
        for (const s of students) byId[normSid(s.id)] = s;

        let done = 0, skipped = 0;
        for (const sid of ids) {
          const st = byId[sid];
          if (!st) { skipped++; continue; }                    // 퇴원·삭제된 id는 조용히 건너뛴다
          // 조교는 자기 학원 학생만(원장=null→통과, 미배정 조교=''→전부 차단)
          if (scopeAcademy !== null && (!scopeAcademy || String(st.academy || '').trim() !== scopeAcademy)) { skipped++; continue; }
          const r = (action === 'clear')
            ? await deleteClinicRoster(env, st.id, date)
            : await setClinicRoster(env, st.id, date, action, reason);
          if (r && r.ok !== false) done++; else skipped++;
        }
        return Response.json({ ok: true, date, action, done, skipped });
      } catch (e) {
        return safeError(e, env, { message: '명단 저장에 실패했습니다.' });
      }
    }

    // ── 한 명 ──
    const studentId = (body.studentId != null ? String(body.studentId) : '').trim();
    const name = (body.name || '').trim();
    if (!studentId && !name) return Response.json({ error: 'studentId 또는 name 필수' }, { status: 400 });

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
