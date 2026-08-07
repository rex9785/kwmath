// /api/weekly-digest  (GET, admin Bearer 또는 ?key=CRON_KEY) + runWeeklyDigestReminder(env) (내부 재사용)
// ───────────────────────────────────────────────────────────
// 「주말 피드백」 — 학생 한 명 한 명의 **이번 주 테스트에서 틀린 문항**을 자동으로 모아
// 학부모에게 보낼 3줄 피드백의 재료를 만든다. 발송은 하지 않는다(관우T가 화면에서 승인해야 나간다).
//
// 왜 만들었나 (2026-08-07 관우T 지시)
//   "월말에 너를 부르는 건 확정인데 주말에는 어떻게해 내가 편하려면"
//   → 주중엔 아무것도 안 하고, 토요일에 폰 알림 한 번 받고, 표를 훑고, 보내기만 누르면 끝나게.
//   보고서(PDF)는 여전히 월말에 한 번만 나간다. 이건 그 사이를 메우는 **문자 3줄**이다.
//
// 🔴 이 파일의 첫 판(같은 날 폐기) — 평균 점수를 문장으로 만들어 보내려 했다. 관우T가 잘랐다:
//   "학부모도 테스트 결과를 볼 수 있잖아 … 그저 평균만알려주는게 무슨 의민가 싶어"
//   맞는 지적이다. 학부모는 이미 ① 매 수업 MathOS 리포트 ② my-scores.html 의 회차별 점수를 본다.
//   거기에 "평균 72점"을 한 번 더 밀어 넣는 건 정보량 0이다.
//   앱이 **안 보여 주는 것**은 셋뿐이다 — ⓐ 어느 문항을 틀렸는지 ⓑ 그게 무슨 뜻인지 ⓒ 선생이 뭘 할 건지.
//   → 그래서 이 API 는 **문장을 쓰지 않는다.** ⓐ(기계가 뽑을 수 있는 것)만 최대한 정확히 뽑아 주고,
//     ⓑ·ⓒ(문항 내용을 읽어야 나오는 판단)는 토요일에 Claude 가 초안으로 채운다.
//     body 를 빈 문자열로 두는 것이 **의도**다. 여기서 자동 문장을 만들면 그 순간 위 지적으로 되돌아간다.
//
// ⚠️ 진도 문구는 넣지 않는다 (관우T 확정: "아냐 개인숫자만하자 다음주진도말고").
//   "다음 주엔 삼각함수 나갑니다" 같은 줄을 매주 관우T가 입력해야 하면 "편하려면"이 깨진다.
//   3줄 중 셋째 줄("뭘 할 건가")은 **틀린 문항에서 따라 나오는 조치**지 진도표가 아니다.
//
// 데이터 출처 = exam_scores 중 퀴즈 자동반영분(일일/주간/월말테스트).
//   퀴즈 빌더에서 「테스트 종류」만 골라 두면 채점과 동시에 여기 쌓인다(_scores.js). 별도 입력 없음.
//   ⚠️ 「테스트 종류」를 안 고른 퀴즈는 성적에 안 들어가므로 이 요약에도 안 잡힌다.
//
// 반 구분 — 시동반/공통수학2는 절대 안 섞는다는 규칙이 여기선 자동으로 지켜진다.
//   모든 숫자가 **그 학생 개인의 것**이라 반 평균·등수를 아예 계산하지 않기 때문이다.
//   ⚠️ 단 하나의 예외가 오답 상세의 `missed`(그 문항을 틀린 사람 수)다. 이건 **난이도 맥락**이지 등수가 아니다.
//     "3명 중 3명이 틀림" → 문제가 어려웠다 / "8명 중 혼자 틀림" → 그 학생만의 구멍.
//     화면에서 관우T와 Claude 만 보고, 학부모 문자에는 절대 넣지 않는다(등수로 읽힌다).
//
// 📅 날짜 경계 주의 — exam_date 는 채점 시각의 **UTC 날짜**다(_scores.js).
//   KST 00:00~09:00 에 응시하면 전날로 기록된다. 학원 테스트가 그 시간대에 있을 일은 없어
//   실무상 문제가 없지만, 주 경계(월요일 새벽)에 본 테스트는 지난주로 잡힐 수 있다.
// ───────────────────────────────────────────────────────────
import { sendPushToUsers } from './_push.js';
import { listStudents } from './_db.js';
import { ensureExamScoresTable, TEST_KINDS } from './_scores.js';
import { staffScopeAcademy } from './_staff.js';
import { logAudit } from './_auditlog.js';
// 채점 규칙은 절대 복사하지 않는다 — surveys.js 의 gradeAnswers 하나만 쓴다(수식 동치·복수정답 드리프트 방지).
import { gradeAnswers } from './surveys.js';

const ADMIN_PUSH_USERS = ['__admin__'];
const STATE_KEY = 'weekly-digest/state.json';

// 🔁 미도달 재시도 — admin-reminders.js §11-10 과 같은 이유.
//   sendPushToUsers 는 보낼 기기가 없어도 throw 하지 않고 { sent: 0 } 을 준다.
//   그때 "이번 주 보냄"으로 찍어 버리면 알림이 한 대도 안 갔는데 그 주가 조용히 넘어간다.
const MAX_PUSH_TRIES = 3;

function ymdUTC(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

// 한국 시간(UTC+9). 한국은 서머타임 없음 → 고정 +9 안전.
function kstNow() {
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  return { at: k, dow: k.getUTCDay(), hour: k.getUTCHours() };   // dow 0=일 … 6=토
}

// KST 기준 '이번 주'(월~일). offsetWeeks=-1 이면 지난주.
//   주를 월요일에 끊는 이유 — 토요일 저녁에 보내는데 일요일 시작이면 그 주가 아직 하루 남는다.
function weekRangeKST(offsetWeeks) {
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  const backToMon = (k.getUTCDay() + 6) % 7;                     // 일요일이면 6일 뒤로
  const monMs = k.getTime() - backToMon * 86400000 + (offsetWeeks || 0) * 7 * 86400000;
  const from = ymdUTC(new Date(monMs));
  const to = ymdUTC(new Date(monMs + 6 * 86400000));
  return { from, to };
}

// '2026-08-03' → '8/3'
function md(s) {
  const p = String(s || '').split('-');
  return p.length === 3 ? (Number(p[1]) + '/' + Number(p[2])) : String(s || '');
}

// 기간 안의 테스트 점수 행 → { studentId: [ {label, type, score, date, surveyId}, … ] }
//   source_key 는 'quiz:<surveyId>'(_scores.js). 이 값이 **점수 ↔ 응답지**를 잇는 유일한 끈이라
//   오답 상세를 뽑으려면 반드시 같이 읽어야 한다. 수동 입력 내신·모의는 source_key 가 NULL 이라 surveyId=null.
async function fetchWeek(env, from, to) {
  const kinds = [...TEST_KINDS];
  const { results } = await env.DB.prepare(
    'SELECT student_id, exam_type, label, raw_score, exam_date, source_key FROM exam_scores ' +
    'WHERE exam_type IN (' + kinds.map(() => '?').join(',') + ') ' +
    'AND raw_score IS NOT NULL AND exam_date >= ? AND exam_date <= ? ' +
    'ORDER BY exam_date ASC, id ASC'
  ).bind(...kinds, from, to).all();
  const by = {};
  for (const r of (results || [])) {
    const k = String(r.student_id);
    if (!by[k]) by[k] = [];
    const m = /^quiz:(\d+)$/.exec(String(r.source_key || ''));
    by[k].push({
      label: r.label || '', type: r.exam_type || '', score: Number(r.raw_score), date: r.exam_date || '',
      surveyId: m ? Number(m[1]) : null,
    });
  }
  return by;
}

// 답을 사람이 읽을 수 있는 짧은 문자열로. 배열(복수정답)·수식(LaTeX)·빈값 모두 안전하게.
function answerText(v, max) {
  const s = Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v);
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return '(무응답)';
  return t.length > max ? (t.slice(0, max) + '…') : t;
}

// ═══════════ 🔍 오답 상세 ═══════════
// 이 함수가 이 파일의 존재 이유다. items 각각에 「이번 주에 틀린 문항」을 붙인다.
//   붙는 것: 문항 본문 · 배점 · 정답 · 그 학생이 쓴 답 · 그 문항을 틀린 사람 수 / 푼 사람 수.
//   안 붙는 것: 단원 이름. 문항에 단원 태그 필드가 **아예 없다**(surveys.js 문항 스키마 참고).
//     → 단원은 문항 본문을 읽어야 나온다 = 사람이나 Claude 의 몫. 여기서 추측하지 않는다.
//
// 학생 특정 — 응답지에는 이름만 있고 student_id 가 없다. 그래서 이름으로 직접 찾지 않고
//   **이미 성적표에 꽂힌 결과**(exam_scores.source_key='quiz:<id>')를 역으로 쓴다.
//   _scores.js 가 동명이인이면 아예 안 꽂으므로, 그 끈을 타면 동명이인 오배정이 원천적으로 불가능하다.
async function attachWrongDetail(env, items) {
  const ids = [];
  for (const it of items) {
    for (const t of (it.tests || [])) {
      if (Number.isFinite(t.surveyId) && ids.indexOf(t.surveyId) < 0) ids.push(t.surveyId);
    }
  }
  if (!ids.length) return { surveys: 0, matched: 0, skipped: [] };
  const use = ids.slice(0, 60);                       // 한 주에 60개 넘는 테스트는 현실에 없다(쿼리 폭주 방지)
  const ph = use.map(() => '?').join(',');

  const sv = await env.DB.prepare('SELECT id, title, test_kind, questions FROM surveys WHERE id IN (' + ph + ')').bind(...use).all();
  const rs = await env.DB.prepare(
    'SELECT survey_id, respondent_name, answers, manual FROM survey_responses WHERE survey_id IN (' + ph + ')'
  ).bind(...use).all();

  // surveyId → { title, kind, questions[], qById }
  const svById = new Map();
  for (const r of (sv.results || [])) {
    let qs = [];
    try { const p = JSON.parse(r.questions || '[]'); if (Array.isArray(p)) qs = p; } catch (_) {}
    const qById = new Map();
    qs.forEach((q, i) => qById.set(String(q.id), { q, no: i + 1 }));
    svById.set(Number(r.id), { title: r.title || '', kind: r.test_kind || '', questions: qs, qById });
  }

  // 'surveyId|이름' → studentId  (성적표에 실제로 꽂힌 조합만 등록)
  const ownerOf = new Map();
  const 이름중복 = new Set();
  for (const it of items) {
    for (const t of (it.tests || [])) {
      if (!Number.isFinite(t.surveyId)) continue;
      const key = t.surveyId + '|' + (it.name || '');
      if (ownerOf.has(key)) 이름중복.add(key);        // 방어선 — 이론상 _scores.js 가 막지만 확인은 여기서도
      else ownerOf.set(key, it.studentId);
    }
  }
  for (const k of 이름중복) ownerOf.delete(k);

  // 1차 통과 — 채점만 전부 돌려 두고, 문항별 「틀린 사람 수 / 푼 사람 수」를 센다(난이도 맥락).
  const graded = [];                                  // { sid, name, wrongIds:Set, answers }
  const stat = new Map();                             // 'sid|qid' → { missed, answered }
  for (const r of (rs.results || [])) {
    const sid = Number(r.survey_id);
    const meta = svById.get(sid);
    if (!meta) continue;
    let answers = {}, manual = {};
    try { const p = JSON.parse(r.answers || '{}'); if (p && typeof p === 'object') answers = p; } catch (_) {}
    try { const p = JSON.parse(r.manual || '{}'); if (p && typeof p === 'object') manual = p; } catch (_) {}

    let d = {};
    try { d = (gradeAnswers(meta.questions, answers) || {}).detail || {}; } catch (_) { continue; }

    const wrongIds = [];
    for (const qid of Object.keys(d)) {
      const cell = d[qid];
      let ok;
      if (cell && cell.pending) {
        // 장문형 — 사람이 O·X 를 매겨야 한다. 아직 안 매겼으면 정답도 오답도 아니다(빼고 센다).
        if (manual[qid] === 1) ok = true;
        else if (manual[qid] === 0) ok = false;
        else continue;
      } else {
        ok = !!(cell && cell.correct);
      }
      const k = sid + '|' + qid;
      const s = stat.get(k) || { missed: 0, answered: 0 };
      s.answered += 1;
      if (!ok) { s.missed += 1; wrongIds.push(qid); }
      stat.set(k, s);
    }
    graded.push({ sid, name: String(r.respondent_name || '').trim(), wrongIds, answers, detail: d });
  }

  // 2차 통과 — 성적표 끈으로 주인을 찾은 응답만 학생 카드에 붙인다.
  const byStudent = new Map();
  let matched = 0;
  const skipped = [];
  for (const g of graded) {
    const owner = ownerOf.get(g.sid + '|' + g.name);
    if (!owner) { if (g.name) skipped.push(g.name + ' (테스트 #' + g.sid + ')'); continue; }
    matched += 1;
    const meta = svById.get(g.sid);
    const arr = byStudent.get(owner) || [];
    for (const qid of g.wrongIds) {
      const hit = meta.qById.get(String(qid));
      const q = (hit && hit.q) || {};
      const s = stat.get(g.sid + '|' + qid) || { missed: 0, answered: 0 };
      arr.push({
        test: meta.title || meta.kind || ('테스트 #' + g.sid),
        no: (hit && hit.no) || null,
        type: q.type || '',
        points: Number.isFinite(q.points) ? q.points : 1,
        q: answerText(q.label, 300),
        correct: answerText(q.correct, 80),
        given: answerText(g.answers[qid], 80),
        missed: s.missed, answered: s.answered,
      });
    }
    byStudent.set(owner, arr);
  }

  for (const it of items) {
    const arr = byStudent.get(it.studentId) || [];
    arr.sort((a, b) => (a.test || '').localeCompare(b.test || '') || ((a.no || 0) - (b.no || 0)));
    it.wrong = arr;
    it.wrongCount = arr.length;
    // 혼자만 틀린 문항 수 — "반 전체가 어려워한 문제"와 "이 학생만의 구멍"을 구분하는 단서.
    it.soloMiss = arr.filter((w) => w.missed === 1 && w.answered > 1).length;
  }
  return { surveys: use.length, matched, skipped };
}

function avgOf(list) {
  if (!list || !list.length) return null;
  let sum = 0;
  for (const t of list) sum += t.score;
  return Math.round(sum / list.length);
}

// 초안 계산 — 읽기만 한다. 아무것도 저장하지 않고 아무것도 발송하지 않는다.
//   opts.detail=true 면 오답 상세까지 붙인다(관리자 화면 전용). 토요일 알림은 인원수만 필요해서 안 붙인다.
export async function buildWeeklyDigest(env, opts) {
  const withDetail = !!(opts && opts.detail);
  await ensureExamScoresTable(env);

  const cur = weekRangeKST(0);
  const prev = weekRangeKST(-1);
  const weekLabel = md(cur.from) + '~' + md(cur.to);

  let students = [];
  try { students = await listStudents(env); } catch (_) { return { ok: false, error: '학생 명단을 불러오지 못했습니다.' }; }

  let curBy = {}, prevBy = {};
  try {
    curBy = await fetchWeek(env, cur.from, cur.to);
    prevBy = await fetchWeek(env, prev.from, prev.to);
  } catch (_) { return { ok: false, error: '테스트 점수를 불러오지 못했습니다.' }; }

  const items = [];       // 보낼 수 있는 학생(이번 주 테스트 1회 이상)
  const noData = [];      // 이번 주 기록이 없는 학생 — 보내지 않지만 몇 명인지는 보여 준다
  for (const s of students) {
    const key = String(s.id);
    const tests = curBy[key] || [];
    const prevTests = prevBy[key] || [];
    const base = {
      studentId: String(s.id), name: s.name || '',
      academy: s.academy || '', className: s.className || '', grade: s.grade || '',
    };
    if (!tests.length) {
      // 시험을 안 본 주에 "0회"라고 보내면 그 문자는 학부모에게 아무 정보도 아니다 — 조용히 뺀다.
      noData.push(Object.assign({}, base, { prevN: prevTests.length }));
      continue;
    }
    const n = tests.length, avg = avgOf(tests);
    const prevN = prevTests.length, prevAvg = avgOf(prevTests);
    items.push(Object.assign({}, base, {
      n, avg, prevN, prevAvg,
      delta: prevN > 0 ? (avg - prevAvg) : null,
      title: '📊 이번 주 테스트 피드백 (' + weekLabel + ')',
      // 🔴 일부러 비워 둔다. 여기에 자동 문장을 채우는 순간 "평균만 알려주는 게 무슨 의미냐"로 돌아간다.
      //    토요일에 Claude 가 오답을 읽고 3줄로 채운다(파일 맨 위 주석 참고).
      body: '',
      // 화면 검증용 — 이 목록은 **문자에 들어가지 않는다**. 관우T가 숫자가 맞는지 눈으로 보는 용도.
      tests: tests.map((t) => ({ label: t.label, type: t.type, score: t.score, date: t.date, surveyId: t.surveyId })),
      wrong: [], wrongCount: 0, soloMiss: 0,   // detail=1 일 때만 채워진다
    }));
  }

  // 이름순 정렬(반 → 이름) — 화면에서 반별로 뭉쳐 보이게. 숫자는 전부 개인 것이라 반끼리 안 섞인다.
  const collator = (a, b) => (a.className || '').localeCompare(b.className || '') || (a.name || '').localeCompare(b.name || '');
  items.sort(collator);
  noData.sort(collator);

  // 오답 상세는 **덤**이다 — 실패해도 요약 자체는 나가야 한다(빈 wrong[] 으로 남는다).
  let detailInfo = null;
  if (withDetail && items.length) {
    try { detailInfo = await attachWrongDetail(env, items); }
    catch (e) { detailInfo = { error: String((e && e.message) || e) }; }
  }

  return {
    ok: true,
    detail: withDetail,
    weekLabel, from: cur.from, to: cur.to,
    prevFrom: prev.from, prevTo: prev.to,
    count: items.length, noDataCount: noData.length,
    items, noData,
    detailInfo,
  };
}

// ═══════════ 📅 토요일 알림 ═══════════
// 발송이 아니라 **관우T 폰에 "초안 준비됨"만** 알린다. 학부모에게 가는 건 관우T가 화면에서 눌러야 나간다.
// 게이트: KST 토요일 · 09~22시 · 주 1회(그 주 월요일 날짜로 멱등).
// 절대 throw 안 함 — 실패해도 5분 크론(공지 발송)을 막지 않는다.
export async function runWeeklyDigestReminder(env) {
  const now = kstNow();
  if (now.dow !== 6) return { ok: true, fired: false, reason: 'not saturday' };
  if (now.hour < 9 || now.hour >= 22) return { ok: true, fired: false, reason: 'not daytime window', h: now.hour };

  const cur = weekRangeKST(0);
  const weekKey = cur.from;            // 그 주 월요일 — 주 단위 멱등 키

  let state = { lastWeek: '', tries: 0 };
  try {
    const obj = await env.BUCKET.get(STATE_KEY);
    if (obj) {
      const j = JSON.parse(await obj.text());
      if (j && typeof j === 'object') state = Object.assign({ lastWeek: '', tries: 0 }, j);
    }
  } catch (_) {}
  if (state.lastWeek === weekKey) return { ok: true, fired: false, reason: 'already sent this week', weekKey };

  let digest = null;
  try { digest = await buildWeeklyDigest(env); } catch (_) { return { ok: false, reason: 'digest build failed' }; }
  if (!digest || !digest.ok) return { ok: false, reason: (digest && digest.error) || 'digest build failed' };
  if (!digest.count) {
    // 이번 주 테스트가 한 건도 없으면 알리지 않는다(방학·휴원 주에 헛알림이 가면 다음부터 안 보게 된다).
    // "보냈다"로도 찍지 않는다 — 주말 늦게 점수가 들어오면 그때 알려야 하므로.
    return { ok: true, fired: false, reason: 'no tests this week', weekKey };
  }

  // 문구 주의 — 이 알림은 "가서 보내세요"가 아니라 "Claude 를 부르세요"다.
  //   초안(3줄)은 사람이/Claude 가 문항을 읽어야 나온다. 화면만 열면 문자 칸이 비어 있다.
  const body = '이번 주 테스트를 본 학생 ' + digest.count + '명의 오답까지 모아 뒀어요.'
    + (digest.noDataCount ? ('\n(기록 없는 학생 ' + digest.noDataCount + '명은 빠져 있어요.)') : '')
    + '\nClaude 에게 「주간 피드백」이라고 하시면 학생별 3줄 초안을 채워 드려요.'
    + '\n그다음 관리자 → 「📅 주간 요약」에서 읽어 보고 보내시면 끝입니다.';

  let sent = 0, 발송오류 = '';
  try {
    const res = await sendPushToUsers(env, ADMIN_PUSH_USERS, {
      title: '📅 주간 피드백 재료 준비됨 (' + digest.weekLabel + ')',
      body, url: '/admin', tag: 'kwmath-weekly-digest',
    });
    sent = (res && res.sent) || 0;
  } catch (e) { 발송오류 = String((e && e.message) || e); }

  // 🔁 도달했을 때만 "이번 주 보냄"으로 닫는다. 0대면 tries만 올려 다음 틱(5분 뒤)에 재시도.
  let 재시도예정 = false;
  const nextState = { lastWeek: state.lastWeek, tries: Number(state.tries) || 0, at: new Date().toISOString() };
  if (sent > 0) { nextState.lastWeek = weekKey; nextState.tries = 0; }
  else {
    const t = (Number(state.tries) || 0) + 1;
    if (t >= MAX_PUSH_TRIES) { nextState.lastWeek = weekKey; nextState.tries = 0; nextState.undelivered = weekKey; }
    else { nextState.tries = t; 재시도예정 = true; }
  }

  await logAudit(env, null, {
    action: 발송오류 ? 'reminder.weekly.fail' : 'reminder.weekly.push',
    actor: 'system', actorRole: 'system', actorName: '자동 리마인드(주간 요약 초안)',
    target: weekKey,
    path: 'cron runWeeklyDigestReminder() ← /api/notices-flush',
    summary: '주간 요약 초안 알림 ' + (발송오류 ? '발송 실패' : '발송') + ' — ' + digest.weekLabel
      + ' · 대상 학생 ' + digest.count + '명 · 기기 ' + sent + '대',
    detail: {
      주간: digest.weekLabel + ' (' + digest.from + '~' + digest.to + ')',
      대상학생수: digest.count,
      기록없는학생수: digest.noDataCount,
      받는사람: ADMIN_PUSH_USERS,
      보낸기기수: sent,
      발송오류: 발송오류 || '없음',
      알림본문: body,
      효과: sent
        ? '원장 폰에 "재료 준비됨" 알림만 갔다. **학부모에게는 아무것도 가지 않았다** — 초안을 채우고 관리자 화면에서 눌러야 나간다.'
        : (재시도예정
          ? '한 대도 도착하지 않았다. "이번 주 보냄"으로 찍지 않았으므로 5분 뒤 다음 틱에 다시 시도한다.'
          : '한 대도 도착하지 않았고 재시도 한도(' + MAX_PUSH_TRIES + '회)를 다 썼다. 폰의 알림 구독이 살아 있는지 확인이 필요하다.'),
      재시도: sent ? '불필요(도달함)' : (재시도예정 ? '예정 — 다음 5분 틱' : '없음 — 한도 소진'),
      비고: '이 알림은 재료 존재만 알린다. 발송 기록은 실제로 보낼 때 notify.* 로그로 따로 남는다.',
    },
  });

  try {
    await env.BUCKET.put(STATE_KEY, JSON.stringify(nextState), { httpMetadata: { contentType: 'application/json' } });
  } catch (_) {}

  return { ok: true, fired: true, weekKey, count: digest.count, sent, retry: 재시도예정 };
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return Response.json({ ok: false, error: 'GET only' }, { status: 405 });
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const auth = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = !!env.ADMIN_PASSWORD && auth === env.ADMIN_PASSWORD;
  const isCron = !!env.CRON_KEY && !!key && key === env.CRON_KEY;
  if (!isAdmin && !isCron) return Response.json({ ok: false, error: '인증이 필요합니다.' }, { status: 401 });

  // 🔒 원장 전용. 이 초안은 학원·반을 가리지 않고 전 학생을 훑고,
  //    여기서 나온 문구는 그대로 학부모 알림(type:'manual' — 원장만 가능)으로 나간다.
  //    조교에게 전체 명단·점수를 펼쳐 보일 이유가 없다.
  if (isAdmin) {
    const scope = await staffScopeAcademy(env, request);
    if (scope !== null) return Response.json({ ok: false, error: '원장만 볼 수 있어요.' }, { status: 403 });
  }

  // ?run=1 : 토요일 알림 게이트를 수동으로 돌려 본다(점검용). 조건이 안 맞으면 fired:false와 이유가 나온다.
  if (url.searchParams.get('run') === '1') {
    const r = await runWeeklyDigestReminder(env);
    return Response.json({ ok: true, reminder: r });
  }

  // ?detail=1 : 오답 상세까지. 관리자 카드와 Claude 만 쓴다.
  //   홈 「오늘 확인할 것」은 인원수만 필요하므로 detail 없이 부른다(주말 홈 로드에 조회 비용 안 얹기).
  const wantDetail = url.searchParams.get('detail') === '1';
  try {
    const digest = await buildWeeklyDigest(env, { detail: wantDetail });
    if (!digest.ok) return Response.json(digest, { status: 500 });
    return Response.json(digest);
  } catch (e) {
    return Response.json({ ok: false, error: '주간 요약을 만들지 못했습니다.' }, { status: 500 });
  }
}
