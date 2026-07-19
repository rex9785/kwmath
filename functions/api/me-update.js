// POST /api/me-update  (Bearer 토큰 — 학생/학부모 본인)
// body: { id: '12', patch: { school, grade, studentPhone, parentPhone, parentRelation, level,
//         mathMockGrade, mathMockScore, korMockGrade, engMockGrade, schoolMathGrade,
//         advanceProgress, weakness, dreamUniv, availableDays, goals } }
//
// ✏️ 학생 셀프 정보수정 — 잘못 입력한 정보를 본인이 직접 고치는 기능.
//   - 소유권: 토큰 phone에 연결된 학생만, String(id) 매칭 (student_id 평생 규칙 — 이름 매칭 금지)
//   - 수정 불가: name(리포트가 이름 키), academy/className(반코드 시스템 — 반 이동은 관우T),
//                notes(원장 메모), approvalStatus 등 운영 필드
//   - 로그인 중인 번호(auth.phone과 같은 필드)는 변경 불가 — 스스로 계정 연결이 끊기는 사고 방지
//   - 변경 내역은 notes에 로그 append + 관리자(__admin__) 푸시
import { requireAuth, fetchStudentsByPhone, jsonError, normalizePhone } from './_auth.js';
import { getStudentById, updateStudent } from './_db.js';
import { safeError } from './_errors.js';
import { sendPushToUsers } from './_push.js';

const ADMIN_PUSH_USERS = ['__admin__'];

// ── 허용값 (register.html 폼과 동일 세트) ──
const GRADES = ['중2', '중3', '고1', '고2', '고3', 'N수'];
const RELATIONS = ['어머니', '아버지', '기타'];
const LEVELS = ['잘 모름', '1등급', '2등급', '3등급', '4등급', '5등급 이하'];
const MOCK_GRADES = ['1등급','2등급','3등급','4등급','5등급','6등급','7등급','8등급','9등급','미응시','모름'];
const ADVANCE = ['중3 과정','공통수학1','공통수학2','대수','미적분1','미적분2','확률과통계','기하','심화/실전','모름'];
const GOALS = ['수능', '내신', '기초다지기', '선행'];
const DAYS = ['월', '화', '수', '목', '금', '토', '일', '협의'];

const FIELD_LABELS = {
  school: '학교', grade: '학년', studentPhone: '학생폰', parentPhone: '학부모폰',
  parentRelation: '학부모 관계', level: '수학 수준', mathMockGrade: '모의 수학',
  mathMockScore: '모의 수학 점수', korMockGrade: '모의 국어', engMockGrade: '모의 영어',
  schoolMathGrade: '내신 수학', advanceProgress: '선행 진도', weakness: '취약 단원',
  dreamUniv: '희망 대학', availableDays: '등원 요일', goals: '수강 목적',
};

function normDays(arr) {
  const set = new Set((Array.isArray(arr) ? arr : []).map(String));
  return DAYS.filter(d => set.has(d));
}
function normGoals(arr) {
  const set = new Set((Array.isArray(arr) ? arr : []).map(String));
  return GOALS.filter(g => set.has(g));
}
function fmtVal(v) {
  if (Array.isArray(v)) return v.join('·') || '(없음)';
  if (v === null || v === undefined || v === '') return '(없음)';
  return String(v).slice(0, 30);
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return jsonError('POST만 허용', 405);

  const auth = await requireAuth(env, request);
  if (!auth.ok) return auth.response;

  let body = {};
  try { body = await request.json(); } catch {}
  const queryId = String(body.id || '').trim();
  const rawPatch = (body.patch && typeof body.patch === 'object') ? body.patch : {};
  if (!queryId) return jsonError('id 필요', 400);

  // 소유권 검증 — 토큰 phone에 연결된 학생만 (me-detail.js와 동일 패턴)
  const students = await fetchStudentsByPhone(env, auth.phone);
  const target = students.find(s => String(s.id) === queryId);
  if (!target) return jsonError('해당 학생을 찾을 수 없거나 접근 권한이 없습니다.', 403);

  let st;
  try { st = await getStudentById(env, target.id); }
  catch (e) { return safeError(e, env, { message: '학생 정보를 불러오지 못했습니다.' }); }
  if (!st) return jsonError('학생 정보를 불러오지 못했습니다.', 500);

  const editorRole = (auth.phone === st.studentPhone) ? '학생'
                   : (auth.phone === st.parentPhone) ? '학부모' : '보호자';

  // ── 필드별 검증 → clean 패치 구성 (허용 필드 외 전부 무시) ──
  const clean = {};
  const errors = [];
  const has = (k) => rawPatch[k] !== undefined;

  if (has('school')) {
    const v = String(rawPatch.school || '').trim();
    if (v.length > 40) errors.push('학교명은 40자 이내');
    else clean.school = v;
  }
  if (has('grade')) {
    const v = String(rawPatch.grade || '').trim();
    if (!GRADES.includes(v)) errors.push('학년 값이 올바르지 않습니다');
    else clean.grade = v;
  }
  if (has('studentPhone')) {
    const v = normalizePhone(rawPatch.studentPhone);
    if (!v) errors.push('학생 휴대폰 형식 오류');
    else if (st.studentPhone && st.studentPhone === auth.phone && v !== st.studentPhone) {
      errors.push('로그인에 사용 중인 학생 번호는 본인이 바꿀 수 없어요 (관우T께 문의)');
    } else clean.studentPhone = v;
  }
  if (has('parentPhone')) {
    const v = normalizePhone(rawPatch.parentPhone);
    if (!v) errors.push('학부모 휴대폰 형식 오류');
    else if (st.parentPhone && st.parentPhone === auth.phone && v !== st.parentPhone) {
      errors.push('로그인에 사용 중인 학부모 번호는 본인이 바꿀 수 없어요 (관우T께 문의)');
    } else {
      clean.parentPhone = v;
      clean.parentPhone4 = v.replace(/[^0-9]/g, '').slice(-4); // parent_last4 동기화
    }
  }
  if (has('parentRelation')) {
    const v = String(rawPatch.parentRelation || '').trim();
    if (!RELATIONS.includes(v)) errors.push('학부모 관계 값이 올바르지 않습니다');
    else clean.parentRelation = v;
  }
  if (has('level')) {
    const v = String(rawPatch.level || '').trim();
    if (!LEVELS.includes(v)) errors.push('수학 수준 값이 올바르지 않습니다');
    else clean.level = v;
  }
  for (const k of ['mathMockGrade', 'korMockGrade', 'engMockGrade', 'schoolMathGrade']) {
    if (has(k)) {
      const v = String(rawPatch[k] || '').trim();
      if (!MOCK_GRADES.includes(v)) errors.push(FIELD_LABELS[k] + ' 등급 값이 올바르지 않습니다');
      else clean[k] = v;
    }
  }
  if (has('mathMockScore')) {
    const raw = rawPatch.mathMockScore;
    if (raw === '' || raw === null) clean.mathMockScore = null;
    else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) errors.push('모의 수학 점수는 0~100');
      else clean.mathMockScore = n;
    }
  }
  if (has('advanceProgress')) {
    const v = String(rawPatch.advanceProgress || '').trim();
    if (!ADVANCE.includes(v)) errors.push('선행 진도 값이 올바르지 않습니다');
    else clean.advanceProgress = v;
  }
  if (has('weakness')) {
    const v = String(rawPatch.weakness || '').trim();
    if (v.length > 500) errors.push('취약 단원은 500자 이내');
    else clean.weakness = v;
  }
  if (has('dreamUniv')) {
    const v = String(rawPatch.dreamUniv || '').trim();
    if (v.length > 100) errors.push('희망 대학은 100자 이내');
    else clean.dreamUniv = v;
  }
  if (has('availableDays')) {
    const v = normDays(rawPatch.availableDays);
    if (!v.length) errors.push('등원 요일을 1개 이상 선택');
    else clean.availableDays = v;
  }
  if (has('goals')) {
    const v = normGoals(rawPatch.goals);
    if (!v.length) errors.push('수강 목적을 1개 이상 선택');
    else clean.goals = v;
  }

  if (errors.length) return jsonError(errors.join(' / '), 400);

  // ── 실제로 바뀐 필드만 추림 (diff) ──
  const changes = [];
  for (const k of Object.keys(clean)) {
    if (k === 'parentPhone4') continue; // 파생 필드 — 로그 제외
    const before = (k === 'availableDays') ? normDays(st.availableDays)
                 : (k === 'goals') ? normGoals(st.goals)
                 : st[k];
    const same = Array.isArray(before)
      ? JSON.stringify(before) === JSON.stringify(clean[k])
      : String(before ?? '') === String(clean[k] ?? '');
    if (same) delete clean[k];
    else changes.push({ field: k, before, after: clean[k] });
  }
  if (!changes.length) return Response.json({ ok: true, changed: [] });

  // ── notes에 변경 로그 append (원장 메모 필드 — 셀프수정 이력 남김) ──
  const kstDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const diffText = changes.map(c => `${FIELD_LABELS[c.field] || c.field} ${fmtVal(c.before)}→${fmtVal(c.after)}`).join(', ');
  const logLine = `[${kstDate}] 셀프수정(${editorRole}): ${diffText}`;
  clean.notes = st.notes ? (st.notes + '\n' + logLine) : logLine;

  const result = await updateStudent(env, target.id, clean);
  if (!result.ok) return jsonError('저장 실패: ' + (result.error || '알 수 없는 오류'), 500);

  // ── 관리자 푸시 (best-effort) ──
  try {
    const p = sendPushToUsers(env, ADMIN_PUSH_USERS, {
      title: '✏️ 학생 정보 셀프수정',
      body: `${st.name}(${st.academy || ''} ${st.className || ''}) ${editorRole} — ${diffText}`.slice(0, 120),
      url: '/admin',
      tag: 'kwmath-me-update',
    });
    if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
    else if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* best-effort */ }

  return Response.json({ ok: true, changed: changes.map(c => c.field) });
}
