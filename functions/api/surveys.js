// /api/surveys — 앱 내장 설문/조사 시스템
// ───────────────────────────────────────────────────────────
// 구글폼/네이버폼을 앱 밖에 두는 대신, 로그인한 학생·학부모에게
// 앱 안에서 바로 설문을 띄우고 응답을 우리 D1에 쌓는다.
//   · 데이터 주권: 응답이 구글/네이버가 아니라 우리 DB에 남고, 로그인 신원(휴대폰)과 묶여
//     학생·성적·출결과 교차분석 가능. 원장 앱으로 새 응답 즉시 푸시.
//   · iOS 안정성: 외부 브라우저로 안 튐(앱 안에서 처리).
//
// D1 tables (없으면 자동 생성):
//   surveys(id, title, description, audience, anonymous, status, questions[JSON], created_at, updated_at)
//   survey_responses(id, survey_id, respondent_phone, respondent_name, answers[JSON], created_at, ua)
//
//  ── 원장(관리자) : Authorization: Bearer <ADMIN_PASSWORD> (미들웨어가 adm_세션→번역) ──
//   GET    /api/surveys?admin=1           설문 목록 + 응답수
//   GET    /api/surveys?admin=1&id=X      설문 1개 + 응답 전체
//   POST   /api/surveys                   설문 생성 { title, description?, audience?, anonymous?, status?, questions[] }
//   PATCH  /api/surveys?id=X              설문 수정 { title?, description?, audience?, anonymous?, status?, questions? }
//   DELETE /api/surveys?id=X              설문 삭제(+응답 전체)
//
//  ── 응답자(로그인 학생·학부모) : Authorization: Bearer <학생토큰> ──
//   GET    /api/surveys?mine=1            나에게 열린 설문 목록(대상 매칭) + 응답여부 플래그
//   GET    /api/surveys?id=X              설문 1개(응답용) — 열려있고 대상이 맞아야
//   POST   /api/surveys?id=X&respond=1    응답 제출 { name?, answers:{qid:value} }
//
//  ※ 조교(ast_) : 퀴즈(quiz=1)만 열람·생성·수정·삭제·결과 가능. X-Staff-Phone 헤더로 판별.
//     일반 설문·모든 응답(학생·학부모 개인정보)은 원장 전용. (미들웨어는 /api/surveys를 조교에 허용,
//     실제 퀴즈전용 제한은 여기 surveys.js에서 X-Staff-Phone 존재로 강제.)
// ───────────────────────────────────────────────────────────
import { sendPushToUsers } from './_push.js';
import { requireStudentAccess } from './_auth.js';
import { upsertTestScore, TEST_KINDS } from './_scores.js';   // 테스트 종류 퀴즈 → 성적 자동 반영

// 새 응답 알림을 받을 관리자 푸시 userId (inquiry.js와 동일 규약)
const ADMIN_PUSH_USERS = ['__admin__'];

const MAX_TITLE = 120;
const MAX_DESC = 1000;
const MAX_QUESTIONS = 40;
const MAX_OPTIONS = 30;
const MAX_LABEL = 300;
const MAX_OPTION = 200;
const MAX_ANSWER = 3000;
const MAX_NAME = 60;
// (MAX_POINTS 폐지 — 배점은 sanitizeQuestions가 총 100점으로 자동 배분)

const AUDIENCES = new Set(['all', 'student', 'parent']);
const STATUSES = new Set(['draft', 'open', 'closed']);
const QTYPES = new Set(['single', 'multi', 'short', 'long', 'scale', 'dropdown', 'math']);

function jsonOk(data, status = 200) { return Response.json(data, { status }); }
function jsonErr(msg, status = 400) { return Response.json({ error: msg }, { status }); }

// 저장형 XSS 방지 — 원장 결과화면·응답자 설문화면 모두 textContent로 렌더하지만
// 서버에서도 위험문자 제거(이중 방어).
function clean(v, max) {
  return String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, max);
}

let _surveysReady = false;
async function ensureTables(env) {
  if (_surveysReady) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS surveys (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'title TEXT, description TEXT, ' +
    "audience TEXT NOT NULL DEFAULT 'all', " +
    'anonymous INTEGER NOT NULL DEFAULT 0, ' +
    "status TEXT NOT NULL DEFAULT 'draft', " +
    'questions TEXT, ' +
    'created_at TEXT, updated_at TEXT)'
  ).run();
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS survey_responses (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'survey_id INTEGER NOT NULL, ' +
    'respondent_phone TEXT, respondent_name TEXT, ' +
    'answers TEXT, ua TEXT, created_at TEXT)'
  ).run();
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_sr_survey ON survey_responses(survey_id)').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_sr_phone ON survey_responses(survey_id, respondent_phone)').run(); } catch (_) {}
  // 퀴즈 기능(정답·자동채점) — 기존 테이블에 컬럼 추가(이미 있으면 무시)
  try { await env.DB.prepare('ALTER TABLE surveys ADD COLUMN quiz INTEGER NOT NULL DEFAULT 0').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE survey_responses ADD COLUMN score INTEGER').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE survey_responses ADD COLUMN max_score INTEGER').run(); } catch (_) {}
  // 장문형 수동채점(O·X) 결과 — { qid: 1|0 } JSON. O=배점 합산, X=0점. (2026-07-09)
  try { await env.DB.prepare('ALTER TABLE survey_responses ADD COLUMN manual TEXT').run(); } catch (_) {}
  // 쌍둥이(오답 재도전) — 클리닉 때 틀린 문항의 쌍둥이 답을 재입력. 원본 성적과 별개 기록. (2026-07-14)
  //   answers_twin={qid:답} JSON · score_twin=맞은 개수 · max_score_twin=재도전 대상 개수.
  try { await env.DB.prepare('ALTER TABLE survey_responses ADD COLUMN answers_twin TEXT').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE survey_responses ADD COLUMN score_twin INTEGER').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE survey_responses ADD COLUMN max_score_twin INTEGER').run(); } catch (_) {}
  // 학원별·반별 대상 지정(선택) — JSON 배열 문자열로 저장. 비어있으면 전체 학원·반.
  try { await env.DB.prepare('ALTER TABLE surveys ADD COLUMN aud_academy TEXT').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE surveys ADD COLUMN aud_class TEXT').run(); } catch (_) {}
  // 테스트 종류(일일/주간/월말테스트) — 지정된 퀴즈만 채점 결과가 성적표에 자동 반영. 빈값=일반 퀴즈.
  try { await env.DB.prepare('ALTER TABLE surveys ADD COLUMN test_kind TEXT').run(); } catch (_) {}
  _surveysReady = true;
}

function nowIso() { return new Date().toISOString(); }

// ── 질문 정의 살균 — 관리자가 만든 questions[] 를 안전한 형태로 정규화 ──
//   quiz=true면 배점을 자동 배분(수동 배점 폐지 — 2026-07-09 관우T 지시).
function sanitizeQuestions(raw, quiz) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.slice(0, MAX_QUESTIONS).forEach((q, i) => {
    if (!q || typeof q !== 'object') return;
    const type = QTYPES.has(q.type) ? q.type : 'short';
    const label = clean(q.label, MAX_LABEL);
    if (!label) return; // 라벨 없는 질문은 버림
    const item = {
      id: clean(q.id, 40) || ('q' + (i + 1)),
      type,
      label,
      required: q.required === true || q.required === 1,
    };
    if (type === 'single' || type === 'multi' || type === 'dropdown') {
      const opts = Array.isArray(q.options) ? q.options : [];
      item.options = opts.slice(0, MAX_OPTIONS)
        .map(o => clean(o, MAX_OPTION)).filter(Boolean);
      if (!item.options.length) return; // 선택지 없는 선택형은 버림
    }
    if (type === 'scale') {
      let mn = parseInt(q.scaleMin, 10); if (!Number.isFinite(mn)) mn = 1;
      let mx = parseInt(q.scaleMax, 10); if (!Number.isFinite(mx)) mx = 5;
      mn = Math.max(0, Math.min(10, mn));
      mx = Math.max(mn + 1, Math.min(10, mx));
      item.scaleMin = mn; item.scaleMax = mx;
      item.scaleMinLabel = clean(q.scaleMinLabel, 40);
      item.scaleMaxLabel = clean(q.scaleMaxLabel, 40);
    }
    // ── 퀴즈: 정답(있을 때만 저장) ──
    //   single/dropdown = 정답 1개(선택지 중), multi = 정답 여러개(선택지 부분집합),
    //   short = 정답 텍스트(대소문자·공백 무시 비교).
    //   scale은 채점 제외. long(장문형)은 정답 없이 배점만 받아 제출 후 수동 O·X 채점.
    if (type === 'single' || type === 'dropdown') {
      const c = clean(q.correct, MAX_OPTION);
      if (c && item.options.includes(c)) item.correct = c;
    } else if (type === 'multi') {
      const cs = Array.isArray(q.correct)
        ? q.correct.map(x => clean(x, MAX_OPTION)).filter(x => item.options.includes(x))
        : [];
      if (cs.length) item.correct = Array.from(new Set(cs));
    } else if (type === 'short' || type === 'math') {
      // short=텍스트 정답, math=수식(LaTeX) 정답 — 둘 다 문자열로 저장(서버 채점 시 비교)
      const c = clean(q.correct, MAX_ANSWER);
      if (c) item.correct = c;
    }
    // ── 쌍둥이 정답(오답 재도전용) — 채점 대상(정답 有) 문항에만 저장. 문자열 1개. ──
    //   재도전 시 쌍둥이 문제는 종이(매쓰홀릭)에 있고 앱엔 답만 입력하므로 타입 무관 문자열.
    if (item.correct !== undefined) {
      const ctw = clean(q.correctTwin, MAX_ANSWER);
      if (ctw) item.correctTwin = ctw;
    }
    out.push(item);
  });
  // ── 퀴즈 자동 배점 — 총 100점을 채점 문항에 배분. 장문형=가중치 2배, 나머지=1. ──
  //   예) 단답 4 + 장문 3 → 단위 4+3×2=10 → 단답 10점 · 장문 20점.
  //   정수 배분(큰 나머지 우선)이라 합계는 항상 정확히 100점.
  if (quiz) {
    const idxs = [], weights = [];
    out.forEach((item, i) => {
      if (item.type === 'long') { idxs.push(i); weights.push(2); }
      else if (item.correct !== undefined) { idxs.push(i); weights.push(1); }
    });
    const units = weights.reduce((a, b) => a + b, 0);
    if (units > 0) {
      const raw100 = weights.map(w => w * 100 / units);
      const base = raw100.map(Math.floor);
      let left = 100 - base.reduce((a, b) => a + b, 0);
      raw100.map((v, i) => ({ i, frac: v - Math.floor(v) }))
        .sort((a, b) => b.frac - a.frac || a.i - b.i)
        .forEach(o => { if (left > 0) { base[o.i]++; left--; } });
      idxs.forEach((qi, k) => { out[qi].points = base[k]; });
    }
  }
  return out;
}

// ── 응답 살균 + 필수문항 검증 ──
//   반환: { ok, answers } 또는 { ok:false, error }
function validateAnswers(questions, rawAnswers) {
  const src = (rawAnswers && typeof rawAnswers === 'object') ? rawAnswers : {};
  const out = {};
  for (const q of questions) {
    const v = src[q.id];
    let val;
    if (q.type === 'multi') {
      const arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
      const opts = new Set(q.options || []);
      val = arr.map(x => clean(x, MAX_OPTION)).filter(x => opts.has(x)).slice(0, MAX_OPTIONS);
      if (q.required && !val.length) return { ok: false, error: '"' + q.label + '" 문항에 답해 주세요.' };
    } else if (q.type === 'single' || q.type === 'dropdown') {
      val = clean(v, MAX_OPTION);
      const opts = new Set(q.options || []);
      if (val && !opts.has(val)) val = '';
      if (q.required && !val) return { ok: false, error: '"' + q.label + '" 문항에 답해 주세요.' };
    } else if (q.type === 'scale') {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n >= q.scaleMin && n <= q.scaleMax) val = n;
      else val = '';
      if (q.required && val === '') return { ok: false, error: '"' + q.label + '" 문항에 답해 주세요.' };
    } else { // short | long
      val = clean(v, MAX_ANSWER);
      if (q.required && !val) return { ok: false, error: '"' + q.label + '" 문항에 답해 주세요.' };
    }
    out[q.id] = val;
  }
  return { ok: true, answers: out };
}

function parseQuestions(json) {
  try { const q = JSON.parse(json || '[]'); return Array.isArray(q) ? q : []; }
  catch (_) { return []; }
}

// 응답 전 학생에게 보낼 문항 — 정답(correct·correctTwin)은 절대 노출하지 않음(치팅 방지). 배점(points)은 남김.
function stripCorrect(questions) {
  return (questions || []).map(q => {
    const c = Object.assign({}, q);
    delete c.correct;
    delete c.correctTwin;
    return c;
  });
}

// 텍스트 정답 비교용 정규화(대소문자·앞뒤·연속공백 무시)
function normText(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── math(수식) 정답 채점 — 순수 JS, 외부 의존성 없음(Cloudflare Worker 안전, eval 미사용) ──
//   형태가 달라도 수학적으로 같으면 정답: 2/4=1/2, √8=2√2, 0.5=1/2, ∛8=2 등.
//   지원: 정수·소수, + - * / ^, ( ), \frac, \sqrt(및 \sqrt[n]), \cdot·\times, \pi, 암묵적 곱(2\sqrt2).
//   숫자로 환원 불가(변수 포함 등)하면 정규화 문자열 비교로 폴백. 대수적 전개((x+1)^2=x^2+2x+1)는 v1 미지원.
function normTextLatex(s) {
  return String(s == null ? '' : s)
    .replace(/\\left|\\right/g, '')
    .replace(/\\dfrac|\\tfrac/g, '\\frac')
    .replace(/\\cdot|\\times/g, '*')
    .replace(/\s+/g, '')
    .toLowerCase();
}
function latexToNumber(src) {
  if (src == null) return null;
  const s = String(src); const tokens = []; let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
    if (ch === '\\') {
      let j = i + 1, name = '';
      while (j < s.length && /[a-zA-Z]/.test(s[j])) { name += s[j]; j++; }
      if (name === '') { if (s[j] === ',' || s[j] === ' ' || s[j] === ';' || s[j] === '!') { i = j + 1; continue; } return null; }
      i = j;
      switch (name) {
        case 'left': case 'right': continue;
        case 'frac': case 'dfrac': case 'tfrac': tokens.push({ type: 'frac' }); continue;
        case 'sqrt': tokens.push({ type: 'sqrt' }); continue;
        case 'cdot': case 'times': tokens.push({ type: '*' }); continue;
        case 'pi': tokens.push({ type: 'num', value: Math.PI }); continue;
        default: return null;
      }
    }
    if (/[0-9.]/.test(ch)) { let num = ''; while (i < s.length && /[0-9.]/.test(s[i])) { num += s[i]; i++; } const v = parseFloat(num); if (!isFinite(v)) return null; tokens.push({ type: 'num', value: v }); continue; }
    if ('+-*/^(){}[]'.includes(ch)) { tokens.push({ type: ch }); i++; continue; }
    if (/[a-zA-Z]/.test(ch)) return null;
    return null;
  }
  let p = 0; let failed = false;
  const peek = () => tokens[p]; const next = () => tokens[p++];
  const NUM_START = new Set(['num', '(', '{', 'frac', 'sqrt']);
  const fail = () => { failed = true; return 0; };
  function parseExpr() { let v = parseTerm(); while (peek() && (peek().type === '+' || peek().type === '-')) { const op = next().type; const r = parseTerm(); v = op === '+' ? v + r : v - r; } return v; }
  function parseTerm() { let v = parseFactor(); while (peek()) { const t = peek().type; if (t === '*' || t === '/') { next(); const r = parseFactor(); v = t === '*' ? v * r : v / r; } else if (NUM_START.has(t)) { const r = parseFactor(); v = v * r; } else break; } return v; }
  function parseFactor() { let sign = 1; while (peek() && (peek().type === '-' || peek().type === '+')) { if (next().type === '-') sign = -sign; } let base = parseAtom(); if (peek() && peek().type === '^') { next(); const exp = parseFactor(); base = Math.pow(base, exp); } return sign * base; }
  function parseAtom() {
    const t = peek(); if (!t) return fail();
    if (t.type === 'num') { next(); return t.value; }
    if (t.type === '(') { next(); const v = parseExpr(); if (peek() && peek().type === ')') next(); else return fail(); return v; }
    if (t.type === '{') { next(); const v = parseExpr(); if (peek() && peek().type === '}') next(); else return fail(); return v; }
    if (t.type === 'frac') { next(); const a = parseGroup(); const b = parseGroup(); return a / b; }
    if (t.type === 'sqrt') { next(); if (peek() && peek().type === '[') { next(); const n = parseExpr(); if (peek() && peek().type === ']') next(); else return fail(); const a = parseGroup(); return Math.pow(a, 1 / n); } const a = parseGroup(); return Math.sqrt(a); }
    return fail();
  }
  function parseGroup() { const t = peek(); if (t && t.type === '{') { next(); const v = parseExpr(); if (peek() && peek().type === '}') next(); else return fail(); return v; } return parseAtom(); }
  const result = parseExpr();
  if (failed) return null;
  if (p !== tokens.length) return null;
  if (typeof result !== 'number' || !isFinite(result)) return null;
  return result;
}
function mathEqual(studentLatex, correctLatex) {
  if (studentLatex == null || String(studentLatex).trim() === '') return false;
  const a = latexToNumber(studentLatex), b = latexToNumber(correctLatex);
  if (a != null && b != null) { const scale = Math.max(1, Math.abs(a), Math.abs(b)); return Math.abs(a - b) <= 1e-9 * scale; }
  const na = normTextLatex(studentLatex), nb = normTextLatex(correctLatex);
  return na !== '' && na === nb;
}

// ── 자동 채점 ──
//   반환: { score, maxScore, detail:{ qid:{ correct:bool, answer(정답), points } } }
//   correct가 정의된 문항 = 자동 채점(maxScore에 합산).
//   long(장문형) + 배점 有 = 채점 대상이지만 제출 시점엔 미채점(pending, 0점) —
//     조교/원장이 결과 화면에서 O·X 판정하면 점수에 합산(PATCH ?grade=1).
//     배점 없는 옛 장문형(자동배점 도입 전 퀴즈)은 기존대로 채점 제외.
function gradeAnswers(questions, answers) {
  let score = 0, maxScore = 0;
  const detail = {};
  for (const q of questions) {
    if (q.type === 'long') {
      if (!Number.isFinite(q.points)) continue;
      maxScore += q.points;
      detail[q.id] = { pending: true, points: q.points };
      continue;
    }
    if (q.correct === undefined || q.correct === null) continue;
    const pts = Number.isFinite(q.points) ? q.points : 1;
    maxScore += pts;
    const a = answers[q.id];
    let ok = false;
    if (q.type === 'single' || q.type === 'dropdown') {
      ok = a === q.correct;
    } else if (q.type === 'multi') {
      const as = new Set(Array.isArray(a) ? a : []);
      const cs = Array.isArray(q.correct) ? q.correct : [];
      ok = as.size === cs.length && cs.every(x => as.has(x));
    } else if (q.type === 'short') {
      ok = !!normText(a) && normText(a) === normText(q.correct);
    } else if (q.type === 'math') {
      ok = mathEqual(a, q.correct);
    }
    if (ok) score += pts;
    detail[q.id] = { correct: ok, answer: q.correct, points: pts };
  }
  return { score, maxScore, detail };
}

// 설문 목록/상세용 row 변환(응답 없이)
function surveyOut(r, responseCount) {
  return {
    id: r.id,
    title: r.title || '',
    description: r.description || '',
    audience: r.audience || 'all',
    audAcademy: parseList(r.aud_academy),
    audClass: parseList(r.aud_class),
    anonymous: r.anonymous === 1,
    quiz: r.quiz === 1,
    status: r.status || 'draft',
    testKind: r.test_kind || '',   // 테스트 종류(일일/주간/월말테스트) — 빈값=일반 퀴즈
    questions: parseQuestions(r.questions),
    createdAt: r.created_at || '',
    updatedAt: r.updated_at || '',
    responseCount: (typeof responseCount === 'number') ? responseCount : undefined,
  };
}

// 응답 row 변환 — anonymous면 신원 가림
function responseOut(r, anonymous) {
  let answers = {};
  try { answers = JSON.parse(r.answers || '{}'); } catch (_) {}
  let manual = null;
  try { manual = r.manual ? JSON.parse(r.manual) : null; } catch (_) {}
  return {
    id: r.id,
    respondentName: anonymous ? '' : (r.respondent_name || ''),
    respondentPhone: anonymous ? '' : (r.respondent_phone || ''),
    answers,
    score: (r.score == null ? undefined : r.score),
    maxScore: (r.max_score == null ? undefined : r.max_score),
    manual: manual || undefined,   // 장문형 O·X 판정 { qid: 1|0 }
    createdAt: r.created_at || '',
  };
}

// JSON 배열 문자열 → 문자열 배열(안전 파싱)
function parseList(v) {
  if (Array.isArray(v)) return v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []; }
  catch (_) { return []; }
}

// 관리자 입력 대상 목록 살균 — 최대 50개, 각 60자
function cleanList(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const v of arr) {
    const s = clean(v, 60);
    if (s && out.indexOf(s) < 0) out.push(s);
    if (out.length >= 50) break;
  }
  return out;
}

// 로그인 응답자가 이 설문 대상인지 — 역할(all/student/parent) + 학원 + 반 매칭.
//   학원/반 목록이 비어있으면 그 축은 제한 없음(전체). 지정돼 있으면 응답자의 학생 중
//   하나라도 그 학원/반에 속하면 통과.
function audienceMatchesStudents(s, students) {
  const list = students || [];
  const roles = new Set(list.map(x => x.role));
  const audience = s.audience || 'all';
  if (audience === 'student' && !roles.has('student')) return false;
  if (audience === 'parent' && !roles.has('parent')) return false;
  const acs = parseList(s.aud_academy);
  if (acs.length && !list.some(x => acs.indexOf(x.academy) >= 0)) return false;
  const cls = parseList(s.aud_class);
  if (cls.length && !list.some(x => cls.indexOf(x.className) >= 0)) return false;
  return true;
}

// 새 응답 → 원장 앱 푸시 (best-effort, 절대 throw 안 함)
function notifyAdmin(context, env, survey, who) {
  try {
    const title = (survey.title || '설문').toString().slice(0, 30);
    const scoreTxt = (survey.quiz && typeof survey.maxScore === 'number')
      ? (' · ' + survey.score + '/' + survey.maxScore + '점') : '';
    const p = sendPushToUsers(env, ADMIN_PUSH_USERS, {
      title: (survey.quiz ? '📝 새 퀴즈 응답이 도착했어요' : '🗳️ 새 설문 응답이 도착했어요'),
      body: title + (who ? (' · ' + who) : '') + scoreTxt,
      url: '/admin-surveys.html?id=' + survey.id,
      tag: 'kwmath-survey-resp',
    });
    if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
    else if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* best-effort */ }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  // 조교(ast_)는 미들웨어가 Bearer ADMIN_PASSWORD로 번역하되 검증된 X-Staff-Phone를 실어 보낸다.
  //   → 이 헤더가 있으면 '조교'로 보고 퀴즈(quiz=1) 전용으로만 허용(일반 설문·응답은 원장 전용).
  const staffPhone = (request.headers.get('x-staff-phone') || '').trim();
  const isStaff = isAdmin && !!staffPhone;   // 퀴즈만 가능한 제한 관리자

  try { await ensureTables(env); }
  catch (e) { return jsonErr('설문 DB 초기화에 실패했습니다.', 500); }

  try {
    // ═══════════════ 관리자 경로 ═══════════════
    if (isAdmin) {
      // ── GET (목록 or 상세+응답) ──
      if (method === 'GET') {
        const id = url.searchParams.get('id');
        if (id) {
          const s = await env.DB.prepare('SELECT * FROM surveys WHERE id=?').bind(id).first();
          if (!s) return jsonErr('설문을 찾을 수 없습니다.', 404);
          if (isStaff && s.quiz !== 1) return jsonErr('조교는 퀴즈만 볼 수 있어요.', 403);
          const { results } = await env.DB.prepare(
            'SELECT * FROM survey_responses WHERE survey_id=? ORDER BY created_at DESC, id DESC'
          ).bind(id).all();
          const anon = s.anonymous === 1;
          return jsonOk({
            ok: true,
            survey: surveyOut(s, (results || []).length),
            responses: (results || []).map(r => responseOut(r, anon)),
          });
        }
        const { results } = await env.DB.prepare(
          isStaff
            ? 'SELECT * FROM surveys WHERE quiz=1 ORDER BY id DESC'   // 조교: 퀴즈만
            : 'SELECT * FROM surveys ORDER BY id DESC'
        ).all();
        const rows = results || [];
        // 응답수 집계
        const counts = {};
        try {
          const { results: cnt } = await env.DB.prepare(
            'SELECT survey_id, COUNT(*) AS n FROM survey_responses GROUP BY survey_id'
          ).all();
          (cnt || []).forEach(c => { counts[c.survey_id] = c.n; });
        } catch (_) {}
        const list = rows.map(r => surveyOut(r, counts[r.id] || 0));
        return jsonOk({ ok: true, surveys: list });
      }

      // ── POST (설문 생성) ──
      if (method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const title = clean(body.title, MAX_TITLE);
        if (!title) return jsonErr('설문 제목을 입력해 주세요.');
        const description = clean(body.description, MAX_DESC);
        const audience = AUDIENCES.has(body.audience) ? body.audience : 'all';
        const audAcademy = cleanList(body.audAcademy);
        const audClass = cleanList(body.audClass);
        const anonymous = (body.anonymous === true || body.anonymous === 1) ? 1 : 0;
        // 조교는 퀴즈만 생성 가능 — quiz=1 강제
        const quiz = isStaff ? 1 : ((body.quiz === true || body.quiz === 1) ? 1 : 0);
        const status = STATUSES.has(body.status) ? body.status : 'draft';
        const questions = sanitizeQuestions(body.questions, quiz === 1);
        if (!questions.length) return jsonErr('질문을 하나 이상 추가해 주세요.');
        // 테스트 종류: 퀴즈일 때만 유효(일일/주간/월말테스트). 지정 시 채점 결과가 성적표에 자동 반영.
        const testKind = (quiz === 1 && TEST_KINDS.has(body.testKind)) ? body.testKind : '';
        const now = nowIso();
        const res = await env.DB.prepare(
          'INSERT INTO surveys (title, description, audience, aud_academy, aud_class, anonymous, quiz, status, questions, test_kind, created_at, updated_at) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
        ).bind(title, description, audience, JSON.stringify(audAcademy), JSON.stringify(audClass), anonymous, quiz, status, JSON.stringify(questions), testKind, now, now).run();
        return jsonOk({ ok: true, id: res.meta && res.meta.last_row_id });
      }

      // ── PATCH ?grade=1 (장문형 수동 채점 O·X) — 원장 + 조교(퀴즈) ──
      //   body { responseId, marks:{ qid: true|false|null } } — null이면 판정 취소.
      //   점수 재계산 = 자동채점 점수 + (O 판정된 장문형 배점 합). 결과를 응답 row에 저장.
      if (method === 'PATCH' && url.searchParams.get('grade') === '1') {
        const id = url.searchParams.get('id');
        if (!id) return jsonErr('id가 필요합니다.');
        const s = await env.DB.prepare('SELECT * FROM surveys WHERE id=?').bind(id).first();
        if (!s) return jsonErr('설문을 찾을 수 없습니다.', 404);
        if (s.quiz !== 1) return jsonErr('퀴즈가 아닌 설문은 채점할 수 없어요.');
        const body = await request.json().catch(() => ({}));
        const rid = parseInt(body.responseId, 10);
        if (!Number.isFinite(rid)) return jsonErr('responseId가 필요합니다.');
        const resp = await env.DB.prepare(
          'SELECT * FROM survey_responses WHERE id=? AND survey_id=?'
        ).bind(rid, id).first();
        if (!resp) return jsonErr('응답을 찾을 수 없습니다.', 404);
        const questions = parseQuestions(s.questions);
        const longIds = new Set(
          questions.filter(q => q.type === 'long' && Number.isFinite(q.points)).map(q => q.id)
        );
        let manual = {};
        try { manual = JSON.parse(resp.manual || '{}') || {}; } catch (_) {}
        const marks = (body.marks && typeof body.marks === 'object') ? body.marks : {};
        for (const qid of Object.keys(marks)) {
          if (!longIds.has(qid)) continue;   // 배점 있는 장문형 문항만 판정 가능
          const v = marks[qid];
          if (v === null || v === undefined || v === '') delete manual[qid];
          else manual[qid] = (v === true || v === 1) ? 1 : 0;
        }
        let answers = {};
        try { answers = JSON.parse(resp.answers || '{}'); } catch (_) {}
        const graded = gradeAnswers(questions, answers);   // 장문형은 pending(0점)으로 계산됨
        let manualScore = 0;
        for (const q of questions) {
          if (q.type === 'long' && manual[q.id] === 1 && Number.isFinite(q.points)) manualScore += q.points;
        }
        const score = graded.score + manualScore;
        await env.DB.prepare('UPDATE survey_responses SET score=?, max_score=?, manual=? WHERE id=?')
          .bind(score, graded.maxScore, JSON.stringify(manual), rid).run();

        // 장문형 O·X 확정으로 점수가 바뀌면 성적표도 같은 값으로 덮어쓴다(테스트 종류 지정 퀴즈만).
        if (s.test_kind && s.anonymous !== 1 && resp.respondent_name) {
          const p = upsertTestScore(env, {
            survey: { id: s.id, title: s.title, testKind: s.test_kind, anonymous: s.anonymous === 1 },
            respondentName: resp.respondent_name, score, maxScore: graded.maxScore,
          });
          if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
          else if (p && typeof p.catch === 'function') p.catch(() => {});
        }
        return jsonOk({ ok: true, responseId: rid, score, maxScore: graded.maxScore, manual });
      }

      // ── PATCH (설문 수정) ──
      if (method === 'PATCH') {
        const id = url.searchParams.get('id');
        if (!id) return jsonErr('id가 필요합니다.');
        const ex = await env.DB.prepare('SELECT id, quiz FROM surveys WHERE id=?').bind(id).first();
        if (!ex) return jsonErr('설문을 찾을 수 없습니다.', 404);
        if (isStaff && ex.quiz !== 1) return jsonErr('조교는 퀴즈만 수정할 수 있어요.', 403);
        const body = await request.json().catch(() => ({}));
        const sets = [], vals = [];
        if (body.title !== undefined) {
          const t = clean(body.title, MAX_TITLE);
          if (!t) return jsonErr('설문 제목을 입력해 주세요.');
          sets.push('title=?'); vals.push(t);
        }
        if (body.description !== undefined) { sets.push('description=?'); vals.push(clean(body.description, MAX_DESC)); }
        if (body.audience !== undefined) { sets.push('audience=?'); vals.push(AUDIENCES.has(body.audience) ? body.audience : 'all'); }
        if (body.audAcademy !== undefined) { sets.push('aud_academy=?'); vals.push(JSON.stringify(cleanList(body.audAcademy))); }
        if (body.audClass !== undefined) { sets.push('aud_class=?'); vals.push(JSON.stringify(cleanList(body.audClass))); }
        if (body.anonymous !== undefined) { sets.push('anonymous=?'); vals.push((body.anonymous === true || body.anonymous === 1) ? 1 : 0); }
        // 조교는 퀴즈 해제 불가(quiz=0 전환 차단). 원장만 quiz 토글 가능.
        if (body.quiz !== undefined && !isStaff) { sets.push('quiz=?'); vals.push((body.quiz === true || body.quiz === 1) ? 1 : 0); }
        if (body.status !== undefined) { sets.push('status=?'); vals.push(STATUSES.has(body.status) ? body.status : 'draft'); }
        // 테스트 종류 수정 — 유효 값만 저장, 그 외(없음 선택 등)는 ''.
        if (body.testKind !== undefined) { sets.push('test_kind=?'); vals.push(TEST_KINDS.has(body.testKind) ? body.testKind : ''); }
        if (body.questions !== undefined) {
          // 자동 배점은 퀴즈에만 — 이번 요청 반영 후의 quiz 상태 기준
          const effQuiz = isStaff ? true
            : (body.quiz !== undefined ? (body.quiz === true || body.quiz === 1) : ex.quiz === 1);
          const qs = sanitizeQuestions(body.questions, effQuiz);
          if (!qs.length) return jsonErr('질문을 하나 이상 추가해 주세요.');
          sets.push('questions=?'); vals.push(JSON.stringify(qs));
        }
        if (!sets.length) return jsonOk({ ok: true, id });
        sets.push('updated_at=?'); vals.push(nowIso());
        vals.push(id);
        await env.DB.prepare('UPDATE surveys SET ' + sets.join(', ') + ' WHERE id=?').bind(...vals).run();
        return jsonOk({ ok: true, id });
      }

      // ── DELETE (설문+응답 삭제) ──
      if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) return jsonErr('id가 필요합니다.');
        if (isStaff) {
          const ex = await env.DB.prepare('SELECT quiz FROM surveys WHERE id=?').bind(id).first();
          if (!ex) return jsonErr('설문을 찾을 수 없습니다.', 404);
          if (ex.quiz !== 1) return jsonErr('조교는 퀴즈만 삭제할 수 있어요.', 403);
        }
        await env.DB.prepare('DELETE FROM survey_responses WHERE survey_id=?').bind(id).run();
        await env.DB.prepare('DELETE FROM surveys WHERE id=?').bind(id).run();
        return jsonOk({ ok: true, removed: 1 });
      }

      return jsonErr('지원하지 않는 메소드입니다.', 405);
    }

    // ═══════════════ 응답자(로그인 학생·학부모) 경로 ═══════════════
    // 관리자 파라미터가 붙었는데 관리자 인증이 아니면 차단
    if (url.searchParams.get('admin') === '1') return jsonErr('관리자 인증이 필요합니다.', 401);

    const access = await requireStudentAccess(env, request);
    if (!access.ok) return access.response;
    const roles = new Set((access.students || []).map(s => s.role));

    // ── POST ?respond=1&twin=1 (쌍둥이 오답 재도전 제출 — 클리닉) ──
    //   원본 시험을 이미 제출한 학생이, 자기가 틀린 문항의 쌍둥이(종이) 답을 앱에 재입력.
    //   • 원본 성적과 완전 별개(answers_twin/score_twin/max_score_twin 컬럼) — 시험 점수 불변.
    //   • 어떤 문항이 '틀림'인지는 서버가 원본 답을 재채점해 결정(맞은 문항은 재도전 불가).
    //   • 설문이 종료(closed)된 뒤에도 가능(클리닉은 시험 후) — status open 요구 안 함.
    //   • 재입력은 병합(이미 낸 것 유지) — 미입력 문항의 정답은 절대 반환 안 함(치팅 방지).
    if (method === 'POST' && url.searchParams.get('respond') === '1' && url.searchParams.get('twin') === '1') {
      const id = url.searchParams.get('id');
      if (!id) return jsonErr('id가 필요합니다.');
      const s = await env.DB.prepare('SELECT * FROM surveys WHERE id=?').bind(id).first();
      if (!s) return jsonErr('설문을 찾을 수 없습니다.', 404);
      if (s.quiz !== 1) return jsonErr('퀴즈가 아니에요.', 400);
      const resp = await env.DB.prepare(
        'SELECT * FROM survey_responses WHERE survey_id=? AND respondent_phone=?'
      ).bind(id, access.phone).first();
      if (!resp) return jsonErr('먼저 원본 시험을 제출해 주세요.', 409);

      const questions = parseQuestions(s.questions);
      let origAnswers = {};
      try { origAnswers = JSON.parse(resp.answers || '{}'); } catch (_) {}
      const graded = gradeAnswers(questions, origAnswers);
      // 재도전 대상 = 자동채점에서 '틀린' + 쌍둥이 정답이 등록된 문항.
      const eligible = questions.filter(q => {
        const d = graded.detail[q.id];
        return d && d.correct === false && q.correctTwin != null && q.correctTwin !== '';
      });
      if (!eligible.length) return jsonErr('재도전할 오답 문항이 없어요.', 400);

      // 병합: 이미 낸 쌍둥이 답 유지 + 이번에 낸 것 덮어쓰기.
      let prevTwin = {};
      try { prevTwin = JSON.parse(resp.answers_twin || '{}') || {}; } catch (_) {}
      const body = await request.json().catch(() => ({}));
      const src = (body && body.answers && typeof body.answers === 'object') ? body.answers : {};
      const twinAnswers = Object.assign({}, prevTwin);
      for (const q of eligible) {
        if (Object.prototype.hasOwnProperty.call(src, q.id)) {
          twinAnswers[q.id] = clean(src[q.id], MAX_ANSWER);
        }
      }
      // 채점(전체 eligible 대상). 미입력 문항은 pending — 정답 미반환(치팅 방지).
      let tScore = 0; const detail = {};
      for (const q of eligible) {
        const a = twinAnswers[q.id];
        const attempted = (a != null && String(a) !== '');
        let ok = false;
        if (attempted) {
          ok = (q.type === 'math')
            ? mathEqual(a, q.correctTwin)
            : (!!normText(a) && normText(a) === normText(q.correctTwin));
        }
        if (ok) tScore++;
        if (!attempted) detail[q.id] = { pending: true };
        else detail[q.id] = ok ? { correct: true } : { correct: false, answer: q.correctTwin };
      }
      const tMax = eligible.length;
      await env.DB.prepare(
        'UPDATE survey_responses SET answers_twin=?, score_twin=?, max_score_twin=? WHERE id=?'
      ).bind(JSON.stringify(twinAnswers), tScore, tMax, resp.id).run();
      return jsonOk({ ok: true, twin: true, score: tScore, maxScore: tMax, detail });
    }

    // ── POST ?respond=1 (응답 제출) ──
    if (method === 'POST' && url.searchParams.get('respond') === '1' && url.searchParams.get('twin') !== '1') {
      const id = url.searchParams.get('id');
      if (!id) return jsonErr('id가 필요합니다.');
      const s = await env.DB.prepare('SELECT * FROM surveys WHERE id=?').bind(id).first();
      if (!s) return jsonErr('설문을 찾을 수 없습니다.', 404);
      if (s.status !== 'open') return jsonErr('지금은 응답할 수 없는 설문이에요.', 403);
      if (!audienceMatchesStudents(s, access.students)) return jsonErr('이 설문의 응답 대상이 아니에요.', 403);

      // 중복 응답 차단 — 휴대폰 1개당 설문 1회
      const dup = await env.DB.prepare(
        'SELECT id FROM survey_responses WHERE survey_id=? AND respondent_phone=?'
      ).bind(id, access.phone).first();
      if (dup) return jsonErr('이미 응답한 설문이에요. 감사합니다!', 409);

      const questions = parseQuestions(s.questions);
      const body = await request.json().catch(() => ({}));
      const v = validateAnswers(questions, body.answers);
      if (!v.ok) return jsonErr(v.error);

      // 퀴즈면 자동 채점 → 점수 저장 + 즉시 결과 반환(정답+점수 노출)
      const isQuiz = s.quiz === 1;
      let graded = null;
      if (isQuiz) graded = gradeAnswers(questions, v.answers);

      const name = clean(body.name, MAX_NAME) || (access.student && access.student.name) || '';
      const ua = clean(request.headers.get('user-agent') || '', 200);
      const now = nowIso();
      await env.DB.prepare(
        'INSERT INTO survey_responses (survey_id, respondent_phone, respondent_name, answers, score, max_score, ua, created_at) ' +
        'VALUES (?,?,?,?,?,?,?,?)'
      ).bind(
        id, access.phone, name, JSON.stringify(v.answers),
        graded ? graded.score : null, graded ? graded.maxScore : null,
        ua, now
      ).run();

      const anon = s.anonymous === 1;
      const who = anon ? '' : name;
      notifyAdmin(context, env, { id: s.id, title: s.title, quiz: isQuiz, score: graded && graded.score, maxScore: graded && graded.maxScore }, who);

      // 테스트 종류가 지정된 퀴즈면 채점 결과를 성적표(exam_scores)에 자동 반영.
      //   best-effort(제출 흐름을 막지 않음) — 익명·미매칭은 헬퍼가 알아서 스킵.
      if (isQuiz && graded && s.test_kind && !anon) {
        const p = upsertTestScore(env, {
          survey: { id: s.id, title: s.title, testKind: s.test_kind, anonymous: anon },
          respondentName: name, score: graded.score, maxScore: graded.maxScore,
        });
        if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
        else if (p && typeof p.catch === 'function') p.catch(() => {});
      }
      const out = { ok: true, message: '응답이 제출됐어요. 감사합니다!' };
      if (isQuiz && graded) {
        out.quiz = true;
        out.score = graded.score;
        out.maxScore = graded.maxScore;
        out.detail = graded.detail;   // { qid:{correct, answer(정답), points} }
      }
      return jsonOk(out);
    }

    // ── GET ?results=1 (내 퀴즈 결과 다시보기 — 학생·학부모) ──
    //   /test-results 페이지용. 내(이 계정 휴대폰)가 제출한 퀴즈 응답 +
    //   내 계정에 연결된 자녀 이름으로 제출된 퀴즈 응답(익명 설문 제외)을 모두 반환.
    //   (응답은 제출한 기기의 계정 휴대폰으로 저장되므로, 학부모 계정에서는
    //    자녀가 자기 폰으로 제출한 응답을 이름 매칭으로 찾아야 함 — 2026-07-09)
    //   문항별로 O/X/채점대기 + 내 답 + (틀린 문항만) 정답을 담아 단답/서술 점수를 분리 계산.
    if (method === 'GET' && url.searchParams.get('results') === '1') {
      const names = Array.from(new Set(
        (access.students || []).map(x => (x.name || '').trim()).filter(Boolean)
      )).slice(0, 10);
      let sql =
        'SELECT r.id, r.survey_id, r.respondent_name, r.answers, r.manual, r.created_at, ' +
        'r.answers_twin, r.score_twin, r.max_score_twin, ' +
        's.title, s.questions, s.anonymous ' +
        'FROM survey_responses r JOIN surveys s ON s.id = r.survey_id ' +
        'WHERE s.quiz = 1 AND (r.respondent_phone = ?';
      const binds = [access.phone];
      if (names.length) {
        sql += ' OR (s.anonymous = 0 AND r.respondent_name IN (' + names.map(() => '?').join(',') + '))';
        binds.push(...names);
      }
      sql += ') ORDER BY r.created_at DESC, r.id DESC LIMIT 100';
      const { results } = await env.DB.prepare(sql).bind(...binds).all();
      const items = (results || []).map(r => {
        const questions = parseQuestions(r.questions);
        let answers = {};
        try { answers = JSON.parse(r.answers || '{}'); } catch (_) {}
        let manual = {};
        try { manual = JSON.parse(r.manual || '{}') || {}; } catch (_) {}
        let answersTwin = {};
        try { answersTwin = JSON.parse(r.answers_twin || '{}') || {}; } catch (_) {}
        const twinDone = r.score_twin != null;   // 쌍둥이 재도전 제출 여부
        const graded = gradeAnswers(questions, answers);
        let autoScore = 0, autoMax = 0, essayScore = 0, essayMax = 0, pendingCount = 0;
        let twinEligible = 0;                     // 재도전 대상(오답+쌍둥이정답 有) 개수
        const qs = [];
        for (const q of questions) {
          const d = graded.detail[q.id];
          const a = answers[q.id];
          const mine = Array.isArray(a) ? a.join(', ') : (a == null ? '' : String(a));
          const item = { id: q.id, label: q.label, type: q.type, mine };
          if (d && d.pending) {                       // 서술형(장문) — 수동 O·X
            essayMax += d.points;
            item.points = d.points;
            const m = manual[q.id];
            if (m === 1) { essayScore += d.points; item.status = 'o'; }
            else if (m === 0) { item.status = 'x'; }
            else { item.status = 'pending'; pendingCount++; }
          } else if (d) {                             // 자동 채점 문항
            autoMax += d.points;
            item.points = d.points;
            if (d.correct) { autoScore += d.points; item.status = 'o'; }
            else {
              item.status = 'x';
              item.answer = Array.isArray(d.answer) ? d.answer.join(', ') : String(d.answer == null ? '' : d.answer);
            }
          }                                            // 채점 제외(척도 등)는 status 없음
          // ── 쌍둥이 재도전: 오답(status 'x') + 쌍둥이 정답이 등록된 문항만 대상 ──
          //   미입력 문항엔 정답을 절대 포함하지 않음(치팅 방지) — 시도 후 오답일 때만 노출.
          if (item.status === 'x' && q.type !== 'long' && q.correctTwin != null && q.correctTwin !== '') {
            twinEligible++;
            const ta = answersTwin[q.id];
            const tmine = Array.isArray(ta) ? ta.join(', ') : (ta == null ? '' : String(ta));
            if (tmine !== '') {                        // 재도전 답 입력함 → 채점 결과 표시
              const tok = (q.type === 'math')
                ? mathEqual(ta, q.correctTwin)
                : (!!normText(ta) && normText(ta) === normText(q.correctTwin));
              item.twin = { has: true, mine: tmine, status: tok ? 'o' : 'x' };
              if (!tok) item.twin.answer = String(q.correctTwin);
            } else {                                   // 아직 재도전 안 함
              item.twin = { has: true, status: 'todo' };
            }
          }
          qs.push(item);
        }
        return {
          responseId: r.id,
          surveyId: r.survey_id,
          title: r.title || '',
          respondentName: r.respondent_name || '',
          createdAt: r.created_at || '',
          score: autoScore + essayScore,
          maxScore: autoMax + essayMax,
          auto: { score: autoScore, max: autoMax },
          essay: { score: essayScore, max: essayMax, pending: pendingCount },
          twin: { eligible: twinEligible, attempted: twinDone, score: r.score_twin, maxScore: r.max_score_twin },
          questions: qs,
        };
      });
      return jsonOk({ ok: true, results: items });
    }

    // ── GET ?mine=1 (나에게 열린 설문 목록) ──
    if (method === 'GET' && url.searchParams.get('mine') === '1') {
      const { results } = await env.DB.prepare(
        "SELECT * FROM surveys WHERE status='open' ORDER BY id DESC"
      ).all();
      const rows = (results || []).filter(r => audienceMatchesStudents(r, access.students));
      // 이미 응답한 설문 표시
      let answered = new Set();
      if (rows.length) {
        try {
          const { results: mine } = await env.DB.prepare(
            'SELECT survey_id FROM survey_responses WHERE respondent_phone=?'
          ).bind(access.phone).all();
          answered = new Set((mine || []).map(m => m.survey_id));
        } catch (_) {}
      }
      const list = rows.map(r => ({
        id: r.id,
        title: r.title || '',
        description: r.description || '',
        anonymous: r.anonymous === 1,
        quiz: r.quiz === 1,
        questionCount: parseQuestions(r.questions).length,
        answered: answered.has(r.id),
        createdAt: r.created_at || '',
      }));
      return jsonOk({ ok: true, surveys: list });
    }

    // ── GET ?id=X (응답용 설문 1개) ──
    if (method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) return jsonErr('id가 필요합니다.');
      const s = await env.DB.prepare('SELECT * FROM surveys WHERE id=?').bind(id).first();
      if (!s) return jsonErr('설문을 찾을 수 없습니다.', 404);
      if (s.status !== 'open') return jsonErr('지금은 응답할 수 없는 설문이에요.', 403);
      if (!audienceMatchesStudents(s, access.students)) return jsonErr('이 설문의 응답 대상이 아니에요.', 403);
      const dup = await env.DB.prepare(
        'SELECT id FROM survey_responses WHERE survey_id=? AND respondent_phone=?'
      ).bind(id, access.phone).first();
      return jsonOk({
        ok: true,
        survey: {
          id: s.id,
          title: s.title || '',
          description: s.description || '',
          anonymous: s.anonymous === 1,
          quiz: s.quiz === 1,
          questions: stripCorrect(parseQuestions(s.questions)),   // 정답 노출 금지
        },
        answered: !!dup,
      });
    }

    return jsonErr('지원하지 않는 요청입니다.', 400);
  } catch (e) {
    return jsonErr('설문 처리 중 오류가 발생했습니다.', 500);
  }
}
