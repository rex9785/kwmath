// POST /api/me-update  (Bearer 토큰 — 학생/학부모 본인)
// body: { id: '12', patch: { school, grade, parentRelation, level,
//         mathMockGrade, mathMockScore, korMockGrade, engMockGrade, schoolMathGrade,
//         advanceProgress, weakness, dreamUniv, availableDays, goals } }
//
// ✏️ 학생 셀프 정보수정 — 잘못 입력한 정보를 본인이 직접 고치는 기능.
//   - 소유권: 토큰 phone에 연결된 학생만, String(id) 매칭 (student_id 평생 규칙 — 이름 매칭 금지)
//   - 수정 불가: name(리포트가 이름 키), academy/className(반코드 시스템 — 반 이동은 관우T),
//                studentPhone/parentPhone(전화번호 전부 — 2026-07-20 관우T 지시 "번호는 못바꾸게 해",
//                번호 변경은 관우T가 직접), notes(원장 메모), approvalStatus 등 운영 필드
//   - 변경 내역은 notes에 로그 append + 관리자(__admin__) 푸시
import { requireAuth, fetchStudentsByPhone, jsonError } from './_auth.js';
import { getStudentById, updateStudent } from './_db.js';
import { safeError } from './_errors.js';
import { sendPushToUsers } from './_push.js';
import { logAudit, diffFields } from './_auditlog.js';

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
  school: '학교', grade: '학년',
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
  if (!target) {
    // ⚠️ 2026-07-31 — 남의 학생 id로 셀프수정을 시도한 흔적이 어디에도 안 남았다.
    //   앱이 엉뚱한 id를 보낸 버그인지, 사람이 남의 정보를 만지려 한 건지 사후에 구분할 근거가 없었다.
    await logAudit(env, request, {
      action: 'me.update.denied',
      actor: auth.phone, actorRole: 'student',
      actorName: students.map(s => s.name).filter(Boolean).join(', ').slice(0, 60),
      target: queryId,
      summary: '내정보 수정 거부(403) — 이 번호에 연결되지 않은 학생 id(' + queryId + ')를 고치려 했음',
      detail: {
        요청한학생id: queryId,
        이번호에연결된학생: students.slice(0, 20).map(s => ({ id: s.id, 이름: s.name, 관계: s.role })),
        고치려한칸: Object.keys(rawPatch).slice(0, 30),
        결과: '거부됨 — 아무것도 저장되지 않음',
      },
    });
    return jsonError('해당 학생을 찾을 수 없거나 접근 권한이 없습니다.', 403);
  }

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
  // ⛔ 전화번호(studentPhone·parentPhone)는 셀프수정 불가 — patch에 와도 무시됨(허용 필드 화이트리스트 방식)
  if (has('studentPhone') || has('parentPhone')) {
    errors.push('전화번호 변경은 관우T께 문의해주세요');
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

  if (errors.length) {
    // 🔎 2026-07-31 — 저장이 "막힌" 경우는 통째로 안 남았다. 학부모가 "고쳤는데 그대로다" 하면
    //   값이 규칙에 안 맞아 반려된 건지, 앱이 아예 안 보낸 건지 확인할 방법이 없었다.
    //   전화번호 변경 시도(2026-07-20 "번호는 못바꾸게 해")가 몇 번 있었는지도 이 로그로만 알 수 있다.
    await logAudit(env, request, {
      action: 'me.update.reject',
      actor: auth.phone,
      actorRole: editorRole === '학생' ? 'student' : 'parent',
      actorName: (st.name || '') + (editorRole === '학생' ? '' : ' ' + editorRole),
      target: String(target.id), targetName: st.name || '',
      summary: '내정보 수정 반려(400) — ' + errors.join(' / ').slice(0, 200),
      detail: {
        학생id: String(target.id), 이름: st.name || '', 수정자: editorRole,
        보낸칸: Object.keys(rawPatch).slice(0, 30),
        반려사유: errors.slice(0, 20),
        전화번호변경시도: (has('studentPhone') || has('parentPhone')) ? '있음(정책상 차단됨)' : '없음',
        결과: '아무것도 저장되지 않음',
      },
    });
    return jsonError(errors.join(' / '), 400);
  }

  // ── 실제로 바뀐 필드만 추림 (diff) ──
  const changes = [];
  const submitted = Object.keys(clean);  // 로그용 — 아래 루프가 "같은 값"인 칸을 clean에서 지우기 전 목록
  for (const k of Object.keys(clean)) {
    const before = (k === 'availableDays') ? normDays(st.availableDays)
                 : (k === 'goals') ? normGoals(st.goals)
                 : st[k];
    const same = Array.isArray(before)
      ? JSON.stringify(before) === JSON.stringify(clean[k])
      : String(before ?? '') === String(clean[k] ?? '');
    if (same) delete clean[k];
    else changes.push({ field: k, before, after: clean[k] });
  }
  if (!changes.length) {
    // 📓 2026-07-31 — "저장했는데 반영이 안 됐다"는 문의의 상당수가 **원래 값과 똑같은 값**을 저장한 경우다.
    //   성공했을 때만 로그가 찍히면 이 경우가 통째로 사라져서 "요청이 서버까지 오긴 했는지"조차 확인이 안 됐다.
    await logAudit(env, request, {
      action: 'me.update.noop',
      actor: auth.phone,
      actorRole: editorRole === '학생' ? 'student' : 'parent',
      actorName: (st.name || '') + (editorRole === '학생' ? '' : ' ' + editorRole),
      target: String(target.id), targetName: st.name || '',
      summary: '[' + (st.name || target.id) + '] 내정보 수정 요청이 왔지만 아무것도 안 바뀜 — '
        + (submitted.length ? submitted.map(k => FIELD_LABELS[k] || k).join(', ') + ' 전부 기존값과 동일' : '고칠 칸을 아예 안 보냄'),
      detail: {
        학생id: String(target.id), 이름: st.name || '', 수정자: editorRole,
        보낸칸: submitted.map(k => FIELD_LABELS[k] || k),
        결과: 'DB 쓰기 안 함 · 원장 메모(notes) append 안 함 · 관리자 푸시도 안 감',
      },
    });
    return Response.json({ ok: true, changed: [] });
  }

  // ── 로그용 전/후 표 (한글 칸 이름) — 저장이 실패해도 남겨야 하므로 쓰기 전에 만들어 둔다 ──
  const logBefore = {}, logAfter = {};
  for (const c of changes) {
    const label = FIELD_LABELS[c.field] || c.field;
    logBefore[label] = Array.isArray(c.before) ? c.before.join('·') : (c.before ?? '');
    logAfter[label]  = Array.isArray(c.after)  ? c.after.join('·')  : (c.after ?? '');
  }
  const d = diffFields(logBefore, logAfter);

  // ── notes에 변경 로그 append (원장 메모 필드 — 셀프수정 이력 남김) ──
  const kstDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const diffText = changes.map(c => `${FIELD_LABELS[c.field] || c.field} ${fmtVal(c.before)}→${fmtVal(c.after)}`).join(', ');
  const logLine = `[${kstDate}] 셀프수정(${editorRole}): ${diffText}`;
  clean.notes = st.notes ? (st.notes + '\n' + logLine) : logLine;

  const result = await updateStudent(env, target.id, clean);
  if (!result.ok) {
    // ⚠️ 2026-07-31 — 저장 실패는 학생 화면의 빨간 글씨 한 줄로만 뜨고 사라졌다.
    //   "그때 무엇을 무엇으로 고치려다 실패했는지"가 안 남아 재현도, 대신 입력해 주는 것도 불가능했다.
    await logAudit(env, request, {
      action: 'me.update.fail',
      actor: auth.phone,
      actorRole: editorRole === '학생' ? 'student' : 'parent',
      actorName: (st.name || '') + (editorRole === '학생' ? '' : ' ' + editorRole),
      target: String(target.id), targetName: st.name || '',
      summary: '[' + (st.name || target.id) + '] 내정보 셀프수정 저장 실패(500) — ' + (d.요약 || '변경 없음'),
      detail: {
        학생id: String(target.id), 이름: st.name || '', 수정자: editorRole,
        바뀌려던칸: d.바뀐칸, 시도한변경: d.변경,
        DB오류: String(result.error || '알 수 없는 오류').slice(0, 300),
        결과: '저장 안 됨 — 학생 정보는 예전 값 그대로 · 원장 메모 append도 안 됨',
      },
    });
    return jsonError('저장 실패: ' + (result.error || '알 수 없는 오류'), 500);
  }

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

  // 📓 2026-07-31 — 여기서 만든 전/후 표(changes)가 지금까지 응답만 만들고 그대로 버려졌다.
  //   notes에 한 줄 append되긴 하지만 값이 30자에서 잘리고(fmtVal) 원장 메모와 뒤섞여서,
  //   "취약 단원 원문이 뭐였는지 / 어느 번호로 로그인한 사람이 고쳤는지"는 복원이 안 됐다.
  //   학생·학부모가 스스로 고치는 유일한 통로라, 잘못 바뀐 값을 되돌리려면 이 로그가 유일한 근거다.
  await logAudit(env, request, {
    action: 'me.update',
    actor: auth.phone,
    actorRole: editorRole === '학생' ? 'student' : 'parent',
    actorName: (st.name || '') + (editorRole === '학생' ? '' : ' ' + editorRole),
    target: String(target.id), targetName: st.name || '',
    summary: '[' + (st.name || target.id) + '] 내정보 셀프수정(' + editorRole + ') — ' + (d.요약 || diffText),
    detail: {
      학생id: String(target.id), 이름: st.name || '',
      학원: st.academy || '', 반: st.className || '', 수정자: editorRole,
      바뀐칸: d.바뀐칸, 변경: d.변경,
      원장메모에붙인줄: logLine.slice(0, 1000),
      메모길이: { 전: (st.notes || '').length, 후: String(clean.notes || '').length },
      관리자푸시: '발송 시도함(도착 보장 아님 — 푸시 로그 별도 확인)',
      비고: '이름·전화번호·학원/반·승인상태는 셀프수정 불가 필드라 여기엔 절대 안 나온다',
    },
  });

  return Response.json({ ok: true, changed: changes.map(c => c.field) });
}
