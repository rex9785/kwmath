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
//   PATCH  /api/surveys?id=X&editAnswers=1  학생 답 직접 수정 { responseId, answers:{qid:value} } — 재채점+성적 반영
//   GET    /api/surveys?admin=1&id=X&scoreCount=1  이 테스트로 성적표에 올라간 점수가 몇 명분인지(삭제 확인창용)
//   DELETE /api/surveys?id=X              설문 삭제(+응답 전체) — 성적표는 **기본으로 남긴다**
//   DELETE /api/surveys?id=X&deleteScores=1  위와 같되 성적표의 그 테스트 점수도 함께 삭제
//   DELETE /api/surveys?id=X&responseId=Y 응답 1건 삭제(재제출 허용) — 성적표 잔재도 정리
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
import { upsertTestScore, deleteTestScore, TEST_KINDS } from './_scores.js';   // 테스트 종류 퀴즈 → 성적 자동 반영
import { logAudit, diffFields } from './_auditlog.js';

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

// ── 감사로그에 넣을 '답 1개' 요약 (2026-07-31) ──
//   📓 답에는 학생이 직접 쓴 글이 들어온다. 로그에 통째로 박으면 두 가지가 터진다:
//     ① detail 은 20000자에서 잘리는데, 잘리면 JSON 자체가 깨져 나머지 기록까지 못 읽는다.
//     ② 사진·서명 같은 base64 가 섞이면 답 하나로 로그 한 칸이 다 찬다.
//   → 그래서 값은 잘라 넣되 **원본 길이는 항상 같이 남긴다**(얼마나 긴 답이었는지는 안 사라진다).
//     base64로 보이는 값은 내용 대신 길이만 남긴다.
function logAnswer(v, max = 3000) {
  const s = Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v);
  if (/^data:[^;]*;base64,/i.test(s) || (s.length > 800 && /^[A-Za-z0-9+/=\r\n]+$/.test(s))) {
    return { 길이: s.length, 값: '(이미지·base64 추정 — 내용 대신 길이만 기록)' };
  }
  return { 길이: s.length, 값: s.slice(0, max), 잘림: s.length > max };
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
  // 재제출 허용 목록 — 관리자가 응답을 삭제(재제출 허용)하면 그 학생(휴대폰)을 여기 담아,
  //   설문이 종료(closed)됐어도 이 학생만 다시 들어와 재제출할 수 있게 한다. JSON 배열(휴대폰 문자열).
  //   재제출을 성공적으로 마치면 해당 휴대폰을 목록에서 제거(소비 — 1회성). (2026-07-23)
  try { await env.DB.prepare('ALTER TABLE surveys ADD COLUMN resubmit_allow TEXT').run(); } catch (_) {}
  _surveysReady = true;
}

function nowIso() { return new Date().toISOString(); }

// 재제출 허용 목록(휴대폰) 파싱 — surveys.resubmit_allow(JSON 배열 문자열). 컬럼이 없거나 깨져도 []. (2026-07-23)
function resubmitPhones(s) {
  try { const a = JSON.parse((s && s.resubmit_allow) || '[]'); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}

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
  let t = String(s == null ? '' : s)
    .replace(/[−‒–—―]/g, '-')   // 유니코드 마이너스/대시 → ASCII '-' (문자열 폴백 일관성)
    .replace(/\\left|\\right/g, '')
    .replace(/\\dfrac|\\tfrac/g, '\\frac')
    .replace(/\\cdot|\\times/g, '*')
    .replace(/\s+/g, '')
    .toLowerCase();
  // MathLive(0.110)는 한 글자 인수의 중괄호를 생략해 내보낸다: \frac{1}{2} → \frac12, x^{2} → x^2.
  // 문자·변수가 섞여 숫자로 못 줄이는 답(문자열 폴백)에서 두 표기가 달라 보이지 않도록,
  // '한 글자만 감싼 중괄호'만 벗긴다. {12} 같은 두 글자 이상은 건드리지 않는다(오인 방지).
  let prev;
  do { prev = t; t = t.replace(/\{([^{}])\}/g, '$1'); } while (t !== prev);
  return t;
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
        case 'div': tokens.push({ type: '/' }); continue;
        case 'lparen': tokens.push({ type: '(' }); continue;
        case 'rparen': tokens.push({ type: ')' }); continue;
        case 'pi': tokens.push({ type: 'num', value: Math.PI }); continue;
        default: return null;
      }
    }
    // raw(원문 자릿수)를 함께 보관 — \frac12처럼 중괄호가 생략된 인수를 한 글자씩 떼어내기 위해 필요.
    if (/[0-9.]/.test(ch)) { let num = ''; while (i < s.length && /[0-9.]/.test(s[i])) { num += s[i]; i++; } const v = parseFloat(num); if (!isFinite(v)) return null; tokens.push({ type: 'num', value: v, raw: num }); continue; }
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
    if (t.type === 'frac') { next(); const a = parseGroup(true); const b = parseGroup(true); return a / b; }
    if (t.type === 'sqrt') { next(); if (peek() && peek().type === '[') { next(); const n = parseExpr(); if (peek() && peek().type === ']') next(); else return fail(); const a = parseGroup(); return Math.pow(a, 1 / n); } const a = parseGroup(); return Math.sqrt(a); }
    return fail();
  }
  // single=true면 중괄호 없는 인수를 LaTeX 규칙대로 '한 글자'만 취한다.
  //   MathLive 0.110은 한 글자 인수의 중괄호를 생략해 내보낸다: \frac{1}{2} → \frac12 (2026-07-31 크롬 실측).
  //   이 규칙이 없으면 12를 숫자 하나로 읽어 분모가 사라지고 파싱 실패 → -1/2, 3/4 같은 답이 전부 오답 처리됐다.
  //   \sqrt에는 적용하지 않는다: 학생이 평문으로 'sqrt12'(=√12)라 쓰면 preLatex가 \sqrt12로 바꾸는데,
  //   MathLive는 두 글자 이상이면 \sqrt{12}처럼 중괄호를 유지하므로 양쪽 다 올바르게 읽힌다.
  function parseGroup(single) {
    const t = peek();
    if (t && t.type === '{') { next(); const v = parseExpr(); if (peek() && peek().type === '}') next(); else return fail(); return v; }
    if (single && t && t.type === 'num' && /^[0-9]{2,}$/.test(t.raw || '')) {
      const head = parseFloat(t.raw[0]);
      t.raw = t.raw.slice(1); t.value = parseFloat(t.raw);
      return head;
    }
    return parseAtom();
  }
  const result = parseExpr();
  if (failed) return null;
  if (p !== tokens.length) return null;
  if (typeof result !== 'number' || !isFinite(result)) return null;
  return result;
}
// 일반 키보드 수식 표기 → LaTeX 동의어(숫자 환원 시도에만 사용 — 문자·한글 답 비교엔 영향 없음).
//   UI 안내가 "sqrt(2)처럼 입력"이라 플레인 sqrt/pi/√/×/÷도 받아줘야 함 (2026-07-22).
function preLatex(s) {
  return String(s == null ? '' : s)
    .replace(/√/g, '\\sqrt').replace(/π/g, '\\pi')
    .replace(/[−‒–—―]/g, '-')   // 유니코드 마이너스/대시 → ASCII '-' (MathLive 키패드가 U+2212 삽입)
    .replace(/⁄/g, '/')          // 분수 슬래시 ⁄(U+2044) → /
    .replace(/\{([^{}]*)\}\s*\\over\s*\{([^{}]*)\}/g, '\\frac{$1}{$2}')  // {a}\over{b} → \frac{a}{b}
    .replace(/×/g, '*').replace(/÷/g, '/')
    .replace(/(^|[^\\a-zA-Z])sqrt/gi, '$1\\sqrt')
    .replace(/(^|[^\\a-zA-Z])pi($|[^a-zA-Z])/gi, '$1\\pi$2');
}
function mathEqual(studentLatex, correctLatex) {
  if (studentLatex == null || String(studentLatex).trim() === '') return false;
  const a = latexToNumber(preLatex(studentLatex)), b = latexToNumber(preLatex(correctLatex));
  if (a != null && b != null) { const scale = Math.max(1, Math.abs(a), Math.abs(b)); return Math.abs(a - b) <= 1e-9 * scale; }
  const na = normTextLatex(studentLatex), nb = normTextLatex(correctLatex);
  return na !== '' && na === nb;
}

// ── 단위 무시 채점 (2026-08-14 관우T 확정) ──
//   "정답 5 / 학생 5cm"도, "정답 5cm / 학생 5"도 정답 — 단위를 쓰든 안 쓰든 같은 답으로 본다.
//   ✅ 기각안 "숫자 뒤 글자는 전부 무시": 정답이 3x인 문항에 3만 쓴 답까지 정답이 돼 문자식이 무너진다.
//      그래서 아래 목록(화이트리스트)에 있는 꼬리만 뗀다.
//   ✅ 목록에서 뺀 것 — 소문자 t·s·h·l: 톤·초·시간·리터보다 변수 t·s·h·l로 쓰일 때가 훨씬 많아
//      "정답 2t / 학생 2"를 정답으로 둔갑시킨다. 초·시간·리터는 한글과 대문자 L로 받는다.
//   ✅ 만·억·조도 뺐다 — 단위가 아니라 자릿수다(3조 → 3이 되면 안 된다).
//   ✅ 떼고 남은 쪽에 숫자가 없으면 떼지 않는다 — "두 배"·"cm"·"원"(도형 이름) 같은 낱말 답 보호.
//   ⚠️ 같은 코드가 세 곳에 있다: 이 파일 · admin-report.html · admin-surveys.html.
//      한 곳만 고치면 "결과 화면은 O인데 리포트는 X"가 난다 — 고칠 땐 세 곳 다.
const UNIT_TOKENS = [
  'km/h', 'm/s', 'cm/s', 'km/s', 'm/min', 'km/min',
  '제곱센티미터', '세제곱센티미터', '제곱킬로미터', '세제곱미터', '제곱미터',
  '밀리리터', '밀리미터', '센티미터', '킬로미터', '킬로그램', '밀리그램',
  '라디안', '퍼센트', '리터', '미터', '그램', '시간', '개월', '주일',
  '가지', '자리', '켤레', '송이', '상자', '그루', '마리', '자루', '다스', '인분', '묶음',
  '달러', '위안', '포기', '바퀴', '걸음', '문제', '프로',
  '초', '분', '시', '일', '주', '달', '년', '도', '개', '명', '권', '장', '쪽', '번', '회',
  '통', '대', '벌', '판', '줄', '칸', '팀', '점', '층', '편', '채', '병', '잔', '컵', '알',
  '쌍', '원', '엔', '배', '할', '푼', '톤',
  'cm', 'mm', 'km', 'kg', 'mg', 'mL', 'ml', 'L', 'ℓ', 'm', 'g',
  '㎜', '㎝', '㎞', '㎟', '㎠', '㎡', '㎢', '㎣', '㎤', '㎥', '㎖', '㎗', '㎏', '㎎', '㏄', '℃', '℉',
  '%', '％', '°', 'º', '˚', '∘',
];
const UNIT_RE = new RegExp(
  '(?:' + UNIT_TOKENS.map(function (u) { return u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')'
  + '(?:\\^?\\{?\\s*[23]\\s*\\}?|[²³])?\\s*$'
);
function normPlain(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}
function stripUnit(s) {
  const t = String(s == null ? '' : s)
    .replace(/\\(?:text|textrm|textsf|mathrm|operatorname)\s*\{([^{}]*)\}/g, '$1')  // \text{cm} → cm
    .replace(/\^\s*\{?\s*\\circ\s*\}?/g, '°')                                       // ^\circ → °
    .replace(/\\(?:circ|degree)/g, '°')
    .replace(/\\%/g, '%')
    .replace(/[\s,]+$/, '');
  const m = t.match(UNIT_RE);
  if (!m) return t;
  const head = t.slice(0, t.length - m[0].length).replace(/\s+$/, '');
  if (!/[0-9]/.test(head)) return t;   // 숫자가 없으면 단위가 아니라 낱말 답이다
  return head;
}
// 정답 비교의 단일 출처 — 텍스트 일치 · 수식 동치 · 단위만 다른 경우.
//   mathOnly=true면 텍스트 일치는 건너뛴다(math 문항은 수식 동치로만 판정).
function sameAnswer(student, correct, mathOnly) {
  const a = String(student == null ? '' : student);
  if (a.trim() === '') return false;                     // 무응답은 언제나 오답
  const cmp = function (x, y) {
    if (!mathOnly && !!normPlain(x) && normPlain(x) === normPlain(y)) return true;
    return mathEqual(x, y);
  };
  if (cmp(a, correct)) return true;
  const sa = stripUnit(a), sc = stripUnit(correct);
  if (sa === a.trim() && sc === String(correct == null ? '' : correct).trim()) return false;  // 뗀 게 없으면 위가 결론
  return sa.trim() !== '' && cmp(sa, sc);
}

// ── 자동 채점 ──
//   반환: { score, maxScore, detail:{ qid:{ correct:bool, answer(정답), points } } }
//   correct가 정의된 문항 = 자동 채점(maxScore에 합산).
//   long(장문형) + 배점 有 = 채점 대상이지만 제출 시점엔 미채점(pending, 0점) —
//     조교/원장이 결과 화면에서 O·X 판정하면 점수에 합산(PATCH ?grade=1).
//     배점 없는 옛 장문형(자동배점 도입 전 퀴즈)은 기존대로 채점 제외.
// 📤 export 이유 — weekly-digest.js(주말 오답 뽑기)가 **같은 채점 규칙**을 써야 하기 때문.
//   여기 로직을 복사해 두면 수식 동치(mathEqual)·복수정답 규칙이 조용히 갈라져서
//   "결과 화면에선 O인데 주간 피드백에선 X"가 난다. 채점의 단일 출처는 이 함수 하나다.
export function gradeAnswers(questions, answers) {
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
      // 단답도 수식 키패드(LaTeX) 입력 허용 — 텍스트 일치 또는 수식 동치(예: \frac34 = 3/4 = 0.75)면 정답 (2026-07-22)
      // 단위(5 vs 5cm)는 sameAnswer가 무시한다 (2026-08-14)
      ok = sameAnswer(a, q.correct);
    } else if (q.type === 'math') {
      ok = sameAnswer(a, q.correct, true);
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
//   학원/반 목록이 비어있으면 그 축은 제한 없음(전체).
//   ⚠️ 2026-07-16 수정: 반 이름은 학원 간에 겹칠 수 있다(세정·대치 둘 다 "썸머 공통수학2반").
//     · aud_class 항목은 이제 "학원|반" 쌍으로 저장(admin-surveys.html) — 그 학원의 그 반만 매칭.
//       구형 항목(반 이름만, '|' 없음)은 종전대로 반 이름만 비교(하위호환).
//     · 학원·반 검사를 같은 학생에 대해 함께 평가(AND) — 예전엔 축별로 따로 검사해서
//       자녀 여럿인 계정이 교차 매칭(A학원 자녀 + B반 자녀)으로 잘못 통과할 수 있었음.
function audienceMatchesStudents(s, students) {
  const list = students || [];
  const roles = new Set(list.map(x => x.role));
  const audience = s.audience || 'all';
  if (audience === 'student' && !roles.has('student')) return false;
  if (audience === 'parent' && !roles.has('parent')) return false;
  const acs = parseList(s.aud_academy);
  const cls = parseList(s.aud_class);
  if (!acs.length && !cls.length) return true;   // 대상 지정 없음 = 전체
  return list.some(x => {
    const okAcad = !acs.length || acs.indexOf(x.academy) >= 0;
    const okClass = !cls.length || cls.some(c => {
      const p = c.indexOf('|');
      if (p >= 0) return c.slice(0, p) === x.academy && c.slice(p + 1) === x.className;
      return c === x.className;   // 구형(반 이름만) — 하위호환
    });
    return okAcad && okClass;
  });
}

// 새 응답 → 원장 앱 푸시 (best-effort, 절대 throw 안 함)
function notifyAdmin(context, env, survey, who) {
  try {
    const title = (survey.title || (survey.quiz ? '테스트' : '설문')).toString().slice(0, 30);
    const scoreTxt = (survey.quiz && typeof survey.maxScore === 'number')
      ? (' · ' + survey.score + '/' + survey.maxScore + '점') : '';
    const p = sendPushToUsers(env, ADMIN_PUSH_USERS, {
      title: (survey.quiz ? '📝 새 테스트 응답이 도착했어요' : '🗳️ 새 설문 응답이 도착했어요'),
      body: title + (who ? (' · ' + who) : '') + scoreTxt,
      url: '/admin-surveys.html?id=' + survey.id,
      tag: 'kwmath-survey-resp',
    });
    if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
    else if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* best-effort */ }
}

// 📓 2026-07-31 — 테스트 퀴즈 점수가 성적표(exam_scores)에 어떻게 반영됐는지를 남긴다.
//   왜 여기(호출부)에서 남기나: _scores.js 는 request 를 모른다. 거기서 로그를 부르면
//   행위자·기기·경로·IP가 전부 NULL 로 박혀서 "어떤 조교가 이 점수를 바꿨나"를 영영 못 읽는다.
//   → _scores.js 는 before/after 만 돌려주고, request 를 쥔 여기서 기록한다.
//   성적은 학생·학부모에게 아무 알림 없이 조용히 바뀐다 — 바뀐 사실을 아는 건 이 로그뿐이다.
//   ★ 반영이 **안 된 경우도** 남긴다. "시험 봤는데 성적표에 없어요"의 답(이름 오타·익명 설정)이 거기 있다.
async function logScoreSync(env, request, r, ctx) {
  try {
    const 설문 = (ctx && ctx.survey) || {};
    const 공통 = {
      경로: (ctx && ctx.경로) || '',
      설문id: 설문.id, 설문제목: 설문.title || '', 테스트종류: 설문.test_kind || '',
      응답id: (ctx && ctx.responseId != null) ? ctx.responseId : null,
      응답자이름: (ctx && ctx.respondentName) || '',
      원점수: ctx && ctx.score, 만점: ctx && ctx.maxScore,
      // 🔎 2026-07-31 — 이 경로만 학생을 **이름으로** 찾는다(_scores.js → listStudentsByName).
      //   설문 응답 행에는 student_id 가 아예 안 실려서 지금은 폴백 말고 방법이 없다.
      //   attendance.js·clinic-roster.js·makeup.js 와 **같은 칸 이름**으로 못 박아 둔다 —
      //   나중에 동명이인 사고가 터졌을 때 '이름으로 꽂힌 기록'만 한 번에 골라낼 수 있어야 하기 때문.
      지목방식: 'name 폴백',
      지목방식사유: '설문 응답에 student_id 가 없어 이름으로만 학생을 찾는다 — 같은 이름이 2명 이상이면 '
        + '(2026-07-31부터) 아무에게도 넣지 않고 skip 사유를 남긴다. 예전엔 먼저 등록된 학생(id 작은 쪽)에 조용히 꽂혔다',
    };
    if (!r || r.ok !== true) {
      await logAudit(env, request, {
        action: 'score.quiz.skip',
        target: 'survey/' + (설문.id || '') + '/response/' + ((ctx && ctx.responseId) || ''),
        targetName: (ctx && ctx.respondentName) || '',
        summary: '[' + ((ctx && ctx.respondentName) || '이름없음') + '] 「' + (설문.title || 설문.id)
          + '」 점수가 성적표에 반영 안 됨 — ' + ((r && (r.skipped || r.error)) || '사유 미상'),
        detail: {
          ...공통,
          반영: '안 됨',
          사유: (r && (r.skipped || r.error)) || '헬퍼가 아무 값도 돌려주지 않음',
          결과: '성적표(exam_scores)에 이 학생의 이 테스트 점수는 없다 — 학생 이름 표기부터 확인해야 한다',
        },
      });
      return;
    }
    const d = diffFields(r.before, r.after);
    await logAudit(env, request, {
      action: r.created ? 'score.quiz.create' : 'score.quiz.update',
      target: 'student/' + r.studentId + '/' + (r.sourceKey || ''),
      targetName: r.studentName || (ctx && ctx.respondentName) || '',
      summary: '[' + (r.studentName || '이름없음') + '] 성적표 ' + (r.examType || '') + ' 「' + (r.label || '') + '」 '
        + (r.created ? '신규 반영' : '덮어씀') + ' — ' + r.rawScore + '/' + r.maxScore + '점 → 100점 환산 ' + r.pct + '점'
        + (r.created ? '' : (d.요약 ? ' · ' + d.요약 : ' · 바뀐 값 없음')),
      detail: {
        ...공통,
        학생: { id: r.studentId, 이름: r.studentName || '' },
        성적행id: r.rowId, 성적표키: r.sourceKey,
        신규여부: r.created ? '새 행 생성' : '기존 행 덮어쓰기',
        환산점수: r.pct,
        전: r.before, 후: r.after,
        바뀐칸: d.바뀐칸, 변경: d.변경,
        이전수정시각: r.previousUpdatedAt || '(신규)', 새수정시각: r.updatedAt,
        이름매칭주의: '학생을 id가 아니라 **이름**으로 찾는다 — 동명이인이 있으면 먼저 등록된 학생(id 작은 쪽)에 반영된다',
        결과: '이 점수는 학생·학부모 성적표 화면에 바로 보인다(알림은 따로 안 감)',
      },
    });
  } catch (_) { /* 로깅 실패가 채점·제출을 막지 않게 */ }
}

// ⚠️ 2026-07-31 — 성적표에서 테스트 점수가 통째로 사라지는 경우(응답 삭제 → 재제출 허용).
//   지운 값을 안 남기면 "성적표에 있던 점수가 왜 없어졌지"에 답할 근거가 하나도 없다.
async function logScoreDelete(env, request, r, ctx) {
  try {
    const 설문 = (ctx && ctx.survey) || {};
    const 공통 = {
      경로: (ctx && ctx.경로) || '',
      설문id: 설문.id, 설문제목: 설문.title || '', 테스트종류: 설문.test_kind || '',
      응답id: (ctx && ctx.responseId != null) ? ctx.responseId : null,
      응답자이름: (ctx && ctx.respondentName) || '',
      // ⚠️ 2026-07-31 — 삭제도 이름으로 학생을 찾아서 지운다(_scores.js → listStudentsByName).
      //   동명이인이면 **엉뚱한 학생의 성적이 지워질 수 있는** 자리라 반영 때보다 위험이 크다.
      //   → 그래서 같은 이름이 2명 이상이면 **아무것도 지우지 않고** skip 사유만 남긴다.
      //   지운 뒤에는 되돌릴 근거가 아래 '지워진성적'뿐이므로, 어떤 방식으로 지목했는지도 같이 남긴다.
      지목방식: 'name 폴백',
      지목방식사유: '설문 응답에 student_id 가 없어 이름으로만 학생을 찾는다 — 같은 이름이 2명 이상이면 '
        + '(2026-07-31부터) 아무것도 지우지 않는다. 예전엔 먼저 등록된 학생(id 작은 쪽)의 성적이 지워졌다',
    };
    if (!r || r.ok !== true) {
      await logAudit(env, request, {
        action: 'score.quiz.skip',
        target: 'survey/' + (설문.id || '') + '/response/' + ((ctx && ctx.responseId) || ''),
        targetName: (ctx && ctx.respondentName) || '',
        summary: '[' + ((ctx && ctx.respondentName) || '이름없음') + '] 「' + (설문.title || 설문.id)
          + '」 연동 성적 삭제 안 됨 — ' + ((r && (r.skipped || r.error)) || '사유 미상'),
        detail: {
          ...공통,
          삭제: '안 함',
          사유: (r && (r.skipped || r.error)) || '헬퍼가 아무 값도 돌려주지 않음',
          결과: '성적표에 점수가 남아 있을 수 있다 — 응답은 지워졌는데 점수만 남으면 둘이 어긋난다',
        },
      });
      return;
    }
    await logAudit(env, request, {
      action: 'score.quiz.delete',
      target: 'student/' + r.studentId + '/' + (r.sourceKey || ''),
      targetName: r.studentName || (ctx && ctx.respondentName) || '',
      summary: '[' + (r.studentName || '이름없음') + '] 성적표에서 「' + (설문.title || 설문.id) + '」 테스트 점수 삭제 — '
        + (r.before ? (r.before.점수 + '점(' + (r.before.종류 || '') + ') 사라짐') : '지울 행이 없었음(0건)'),
      detail: {
        ...공통,
        학생: { id: r.studentId, 이름: r.studentName || '' },
        성적행id: r.rowId, 성적표키: r.sourceKey,
        지워진성적: r.before,          // ★ 되돌리려면 이 값 그대로 다시 넣으면 된다
        삭제행수: r.removed,
        결과: r.removed
          ? '학생·학부모 성적표에서 이 테스트 점수가 사라졌다(응답 삭제에 딸린 정리)'
          : '지울 행이 없었다 — 애초에 성적표에 안 올라간 응답이었다',
      },
    });
  } catch (_) { /* 로깅 실패가 삭제를 막지 않게 */ }
}

// ⚠️ 2026-07-31 — 조교가 자기 권한 밖(일반 설문)을 고치거나 지우려다 막힌 순간.
//   막히면 DB가 안 바뀌니 지금까진 흔적이 0이었다. 그런데 "권한 밖을 건드리려 했다"는 사실 자체가 정보다 —
//   일반 설문 응답에는 학생·학부모 개인정보가 들어 있어서, 누가 어디까지 손을 뻗었는지 되짚을 때
//   이 줄이 출발점이 된다. 기록이 없으면 "그 설문은 열어본 적도 없다"와 구분할 방법이 아예 없다.
//   행위자는 미들웨어가 실어 보낸 X-Staff-Phone 로 logAudit 이 자동 식별한다(어느 조교인지까지 남는다).
async function logStaffBlocked(env, request, ctx) {
  try {
    const s = (ctx && ctx.survey) || {};
    await logAudit(env, request, {
      action: 'survey.staff.denied',
      target: 'survey/' + ((ctx && ctx.surveyId) || ''),
      targetName: s.title || '',
      summary: '조교 권한 거부(403) — [' + (s.title || (ctx && ctx.surveyId) || '') + ']에 '
        + ((ctx && ctx.행위) || '') + ' 시도, 테스트가 아닌 일반 설문이라 막힘',
      detail: {
        설문id: (ctx && ctx.surveyId) != null ? ctx.surveyId : null,
        제목: s.title || '', 퀴즈: s.quiz === 1, 상태: s.status || '',
        응답id: (ctx && ctx.responseId) != null ? ctx.responseId : null,
        시도한행위: (ctx && ctx.행위) || '',
        조교휴대폰: (ctx && ctx.staffPhone) || '',
        사유: '조교는 테스트(quiz=1)만 다룰 수 있다 — 일반 설문과 그 응답은 원장 전용(학생·학부모 개인정보)',
        결과: 'DB는 전혀 바뀌지 않았다(403 반환). 정말 필요한 작업이면 원장이 직접 해야 한다',
      },
    });
  } catch (_) { /* 로깅 실패가 응답을 막지 않게 */ }
}

// 📓 2026-07-31 — 학생·학부모가 제출을 눌렀는데 서버가 되돌려보낸 경우.
//   성공했을 때만 로그가 남으면 "냈는데 안 들어갔다"와 "아예 안 냈다"를 끝내 구분할 수 없다.
//   막힌 것도 사건이다. 특히 '응답 대상이 아님'은 대상(학원·반) 지정이 잘못됐다는 신호라,
//   공지 오배송 때처럼 "왜 우리 애만 못 내냐"를 추적할 때 유일한 단서가 된다.
//   ⚠️ 행위자는 학생·학부모 토큰이라 헤더(actorOf)로는 절대 못 알아낸다 → actor 를 직접 넘긴다.
async function logSubmitBlocked(env, request, access, ctx) {
  try {
    const s = (ctx && ctx.survey) || {};
    const st = (access && access.student) || {};
    await logAudit(env, request, {
      action: (ctx && ctx.action) || 'survey.response.blocked',
      actor: (access && access.phone) || '',
      actorRole: st.role || 'student',
      actorName: st.name || '',
      target: 'survey/' + ((ctx && ctx.surveyId) || ''),
      targetName: st.name || '',
      summary: '[' + (st.name || (access && access.phone) || '이름없음') + '] '
        + (s.quiz === 1 ? '테스트' : '설문') + ' [' + (s.title || (ctx && ctx.surveyId) || '') + '] '
        + ((ctx && ctx.행위) || '응답 제출') + ' 막힘(' + ((ctx && ctx.코드) || '') + ') — '
        + ((ctx && ctx.사유) || ''),
      detail: {
        설문id: (ctx && ctx.surveyId) != null ? ctx.surveyId : null,
        제목: s.title || '', 퀴즈: s.quiz === 1, 설문상태: s.status || '',
        학생id: st.id != null ? st.id : null,      // 동명이인 대비 — 이름 말고 id로 특정
        학생이름: st.name || '', 역할: st.role || '',
        로그인휴대폰: (access && access.phone) || '',
        학원: st.academy || '', 반: st.className || '',
        시도한행위: (ctx && ctx.행위) || '응답 제출',
        막힌사유: (ctx && ctx.사유) || '',
        응답코드: (ctx && ctx.코드) != null ? ctx.코드 : null,
        ...((ctx && ctx.추가) || {}),
        결과: (ctx && ctx.결과) || 'DB는 전혀 바뀌지 않았다 — 이 제출은 저장되지 않았다',
      },
    });
  } catch (_) { /* 로깅 실패가 응답을 막지 않게 */ }
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
          if (isStaff && s.quiz !== 1) return jsonErr('조교는 테스트만 볼 수 있어요.', 403);

          // ── GET ?id=X&scoreCount=1 — 「이 테스트를 지우면 성적표에서 같이 지울 수 있는 점수가 몇 명분인가」
          //   2026-08-02 관우T 확정(§11 6번, 원문 "물어봐"): 테스트를 지울 때 성적을 같이 지울지
          //   **그 자리에서 고르신다.** 확인창에 진짜 인원수·이름을 보여주려면 삭제 전에 세어야 한다.
          //   ⚠️ 이름이 아니라 **source_key 로만** 찾는다 — 동명이인 오삭제가 원천적으로 불가능하다
          //      (deleteTestScore 는 이름 매칭이라 동명이인이면 아예 포기한다. 이 경로는 그 한계가 없다).
          if (url.searchParams.get('scoreCount') === '1') {
            let scoreRows = [];
            try {
              const q = await env.DB.prepare(
                'SELECT e.id, e.student_id, e.label, e.raw_score, e.exam_date, st.name AS student_name ' +
                'FROM exam_scores e LEFT JOIN students st ON st.id = e.student_id ' +
                'WHERE e.source_key=? ORDER BY e.id'
              ).bind('quiz:' + id).all();
              scoreRows = q.results || [];
            } catch (_) { /* exam_scores 가 아직 없을 수 있다 — 0건으로 본다 */ }
            return jsonOk({
              ok: true,
              count: scoreRows.length,
              names: scoreRows.slice(0, 20).map(x => x.student_name || ('학생#' + x.student_id)),
              more: Math.max(0, scoreRows.length - 20),
            });
          }

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
        const newId = res.meta && res.meta.last_row_id;

        // 📓 2026-07-31 — surveys 표에는 '만든 사람' 칸이 아예 없다. 그래서 지금까지는
        //   원장이 만든 설문인지 조교가 만든 테스트인지 DB만 봐선 영원히 구분이 안 됐다.
        //   (공지 오배송 때처럼 "누가 이 대상으로 만들었냐"를 물으면 답할 근거가 없었다.)
        //   → 만든 사람과 **만들 당시 설정(대상 학원·반 포함)** 을 여기서 함께 남긴다.
        await logAudit(env, request, {
          action: quiz === 1 ? 'quiz.create' : 'survey.create',
          target: String(newId || ''),
          targetName: title,
          summary: (quiz === 1 ? '테스트' : '설문') + ' [' + title + '] 생성 — 상태 ' + status
            + ' · 대상 ' + audience + ' · 문항 ' + questions.length + '개'
            + (testKind ? ' · ' + testKind + '(성적표 자동반영)' : ''),
          detail: {
            설문id: newId || null, 제목: title, 설명: description || '(없음)',
            상태: status, 퀴즈: quiz === 1, 익명: anonymous === 1,
            대상역할: audience,
            대상학원: audAcademy.length ? audAcademy : '(전체)',
            대상반: audClass.length ? audClass : '(전체)',
            테스트종류: testKind || '(일반 — 성적표 반영 안 함)',
            문항수: questions.length,
            // 문항 전문은 surveys.questions 에 그대로 살아 있으므로 여기선 요약만 남긴다.
            //   (지워질 때는 DELETE 로그가 전문을 통째로 보관한다)
            문항: questions.slice(0, 40).map(q => ({
              id: q.id, 종류: q.type, 질문: String(q.label || '').slice(0, 150),
              배점: q.points, 필수: !!q.required, 정답등록: q.correct !== undefined,
            })),
            생성시각: now,
            결과: status === 'open'
              ? '바로 열림 — 대상 학생·학부모에게 즉시 노출된다'
              : '아직 안 열림(' + status + ') — 학생에겐 안 보인다',
          },
        });
        return jsonOk({ ok: true, id: newId });
      }

      // ── PATCH ?grade=1 (장문형 수동 채점 O·X) — 원장 + 조교(퀴즈) ──
      //   body { responseId, marks:{ qid: true|false|null } } — null이면 판정 취소.
      //   점수 재계산 = 자동채점 점수 + (O 판정된 장문형 배점 합). 결과를 응답 row에 저장.
      if (method === 'PATCH' && url.searchParams.get('grade') === '1') {
        const id = url.searchParams.get('id');
        if (!id) return jsonErr('id가 필요합니다.');
        const s = await env.DB.prepare('SELECT * FROM surveys WHERE id=?').bind(id).first();
        if (!s) return jsonErr('설문을 찾을 수 없습니다.', 404);
        if (s.quiz !== 1) return jsonErr('테스트가 아닌 설문은 채점할 수 없어요.');
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
        // 🔎 2026-07-31 — 바로 아래 for 문이 manual 을 **제자리에서** 고친다.
        //   깊은 복사를 안 하면 로그의 '전'과 '후'가 같은 객체를 가리켜 "안 바뀐 것처럼" 찍힌다
        //   (다른 API에서 실제로 한 번 당한 사고라 여기선 미리 떠 둔다).
        const manualBefore = JSON.parse(JSON.stringify(manual));
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

        // 🔎 2026-07-31 — 서술형 O·X 는 사람이 눈으로 매기는 점수다(조교도 매길 수 있다).
        //   예전엔 결과값만 덮어써서 "누가 O 줬다가 X로 바꿨는지 · 언제 점수가 내려갔는지"가
        //   아무 데도 안 남았다. 이 판정은 성적표(exam_scores)까지 같이 바꾸므로,
        //   나중에 점수 이의가 들어오면 이 로그가 유일한 판단 근거다.
        const markLabel = (mv) => (mv === 1 ? 'O(정답)' : (mv === 0 ? 'X(오답)' : '미채점'));
        const qLabel = new Map(questions.map(q => [q.id, String(q.label || '')]));
        const gradeChanges = [];
        for (const qid of Object.keys(marks)) {
          if (!longIds.has(qid)) continue;
          if (manualBefore[qid] === manual[qid]) continue;
          gradeChanges.push({
            문항id: qid, 문항: (qLabel.get(qid) || '').slice(0, 150),
            전: markLabel(manualBefore[qid]), 후: markLabel(manual[qid]),
          });
        }
        await logAudit(env, request, {
          action: 'survey.response.grade',
          target: 'survey/' + id + '/response/' + rid,
          targetName: resp.respondent_name || '',
          summary: '[' + (resp.respondent_name || '이름없음') + '] 테스트 [' + (s.title || id) + '] 서술형 채점 — '
            + (gradeChanges.length
                ? gradeChanges.map(c => c.문항id + ' ' + c.전 + '→' + c.후).join(' · ')
                : '판정 변경 없음')
            + ' · 점수 ' + (resp.score == null ? '-' : resp.score) + '→' + score + '/' + graded.maxScore,
          detail: {
            설문id: id, 설문제목: s.title || '', 응답id: rid,
            응답자: resp.respondent_name || '', 응답자전화: resp.respondent_phone || '',
            판정변경: gradeChanges,
            판정변경없음: gradeChanges.length === 0,   // 헛클릭·취소도 남긴다(관우T: 사소한 것까지 전부)
            보낸판정칸: Object.keys(marks).slice(0, 40),
            점수: { 전: resp.score, 후: score },
            만점: { 전: resp.max_score, 후: graded.maxScore },
            내역: { 자동채점: graded.score, 서술형가산: manualScore },
            판정전체: { 전: manualBefore, 후: manual },
            테스트종류: s.test_kind || '(일반)',
            성적표반영: !!(s.test_kind && s.anonymous !== 1 && resp.respondent_name),
          },
        });

        // 장문형 O·X 확정으로 점수가 바뀌면 성적표도 같은 값으로 덮어쓴다(테스트 종류 지정 퀴즈만).
        if (s.test_kind && s.anonymous !== 1 && resp.respondent_name) {
          // 📓 2026-07-31 — 성적표에 어떻게 반영됐는지를 여기서 남긴다(_scores.js 는 request 를 몰라
          //   거기서 남기면 "누가 했나"가 통째로 빈다). waitUntil 로 뒤에서 도는 구조는 그대로 두고
          //   .then 으로 로그만 이어 붙였다 — 학생·조교가 체감하는 응답 속도는 변하지 않는다.
          const p = upsertTestScore(env, {
            survey: { id: s.id, title: s.title, testKind: s.test_kind, anonymous: s.anonymous === 1 },
            respondentName: resp.respondent_name, score, maxScore: graded.maxScore,
          }).then((sr) => logScoreSync(env, request, sr, {
            survey: s, responseId: rid, respondentName: resp.respondent_name,
            score, maxScore: graded.maxScore,
            경로: '장문형 O·X 수동 채점(PATCH ?grade=1)',
          })).catch(() => {});
          if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
          else if (p && typeof p.catch === 'function') p.catch(() => {});
        }
        return jsonOk({ ok: true, responseId: rid, score, maxScore: graded.maxScore, manual });
      }

      // ── PATCH ?editAnswers=1 (학생 답 직접 수정 — 원장 + 조교(퀴즈)) ──
      //   body { responseId, answers:{ qid: value } } — 보낸 문항만 덮어씀(부분 수정).
      //   · 타입별 살균은 하되 필수(required) 검사는 안 함 — 관리자 보정이라 빈 답으로 비우기도 허용.
      //   · 답이 바뀐 장문형은 기존 O·X 판정을 무효화(미채점으로 되돌림) — 새 답 기준으로 재판정.
      //   · 퀴즈면 재채점하고, 테스트 종류 지정 시 성적표(exam_scores)도 같은 값으로 덮어씀.
      if (method === 'PATCH' && url.searchParams.get('editAnswers') === '1') {
        const id = url.searchParams.get('id');
        if (!id) return jsonErr('id가 필요합니다.');
        const s = await env.DB.prepare('SELECT * FROM surveys WHERE id=?').bind(id).first();
        if (!s) return jsonErr('설문을 찾을 수 없습니다.', 404);
        if (isStaff && s.quiz !== 1) {
          await logStaffBlocked(env, request, {
            survey: s, surveyId: id, staffPhone,
            행위: '학생 답 직접 수정(PATCH ?editAnswers=1)',
          });
          return jsonErr('조교는 테스트만 수정할 수 있어요.', 403);
        }
        const body = await request.json().catch(() => ({}));
        const rid = parseInt(body.responseId, 10);
        if (!Number.isFinite(rid)) return jsonErr('responseId가 필요합니다.');
        const resp = await env.DB.prepare(
          'SELECT * FROM survey_responses WHERE id=? AND survey_id=?'
        ).bind(rid, id).first();
        if (!resp) return jsonErr('응답을 찾을 수 없습니다.', 404);

        const questions = parseQuestions(s.questions);
        const qById = new Map(questions.map(q => [q.id, q]));
        let answers = {};
        try { answers = JSON.parse(resp.answers || '{}') || {}; } catch (_) {}
        let manual = {};
        try { manual = JSON.parse(resp.manual || '{}') || {}; } catch (_) {}
        // 🔴 2026-07-31 — 여기서 덮어쓰는 건 **학생이 자기 손으로 쓴 답**이다.
        //   원본은 어디에도 백업되지 않아 덮어쓰는 순간 영영 사라지고(점수까지 같이 바뀐다),
        //   지금까지는 관리자가 답을 고쳐도 "원래 뭐라고 썼었는지"를 되찾을 방법이 없었다.
        //   아래 for 문이 answers·manual 을 제자리에서 고치므로 지금 복제해 둔다 — 이 스냅샷이 유일한 사본.
        const answersBefore = JSON.parse(JSON.stringify(answers));
        const manualBefore = JSON.parse(JSON.stringify(manual));

        const patch = (body.answers && typeof body.answers === 'object') ? body.answers : {};
        let touched = 0;
        for (const qid of Object.keys(patch)) {
          const q = qById.get(qid);
          if (!q) continue;                     // 설문에 없는 문항은 무시
          const v = patch[qid];
          let val;
          if (q.type === 'multi') {
            const arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
            const opts = new Set(q.options || []);
            val = arr.map(x => clean(x, MAX_OPTION)).filter(x => opts.has(x)).slice(0, MAX_OPTIONS);
          } else if (q.type === 'single' || q.type === 'dropdown') {
            val = clean(v, MAX_OPTION);
            const opts = new Set(q.options || []);
            if (val && !opts.has(val)) val = '';
          } else if (q.type === 'scale') {
            const n = parseInt(v, 10);
            val = (Number.isFinite(n) && n >= q.scaleMin && n <= q.scaleMax) ? n : '';
          } else { // short | long | math
            val = clean(v, MAX_ANSWER);
          }
          answers[qid] = val;
          touched++;
          if (q.type === 'long') delete manual[qid];   // 답이 바뀌었으니 기존 O·X 무효
        }
        if (!touched) {
          // 📓 2026-07-31 — 아무것도 안 바뀐 헛손질(설문에 없는 문항 id만 보냄 등)도 남긴다.
          //   관우T 지시: "아주 사소한 거 하나까지도 로그에 다 남겨."
          //   "분명 고쳤는데 그대로다" 문의가 왔을 때, 요청 자체가 무효였음을 보여주는 유일한 증거가 된다.
          await logAudit(env, request, {
            action: 'survey.response.edit.noop',
            target: 'survey/' + id + '/response/' + rid,
            targetName: resp.respondent_name || '',
            summary: '[' + (resp.respondent_name || '이름없음') + '] 응답 수정 시도했으나 바뀐 답 없음 — 설문 ['
              + (s.title || id) + ']',
            detail: {
              설문id: id, 설문제목: s.title || '', 응답id: rid,
              응답자: resp.respondent_name || '',
              보낸문항id: Object.keys(patch).slice(0, 40),
              설문의문항id: questions.map(q => q.id).slice(0, 40),
              사유: '보낸 문항 id 가 이 설문의 문항과 하나도 안 맞음 — DB는 건드리지 않았다',
            },
          });
          return jsonErr('수정할 답이 없습니다.');
        }

        // 재채점 — 퀴즈일 때만(일반 설문은 score/max_score NULL 유지)
        let score = null, maxScore = null;
        if (s.quiz === 1) {
          const graded = gradeAnswers(questions, answers);   // 장문형은 pending(0점)
          let manualScore = 0;
          for (const q of questions) {
            if (q.type === 'long' && manual[q.id] === 1 && Number.isFinite(q.points)) manualScore += q.points;
          }
          score = graded.score + manualScore;
          maxScore = graded.maxScore;
        }
        await env.DB.prepare(
          'UPDATE survey_responses SET answers=?, score=?, max_score=?, manual=? WHERE id=?'
        ).bind(JSON.stringify(answers), score, maxScore, JSON.stringify(manual), rid).run();

        // 🔴 2026-07-31 — 관리자·조교가 학생 답안을 직접 고치는 자리. **덮어쓴 옛 답은 이 로그에만 남는다.**
        //   퀴즈면 점수와 성적표(exam_scores)까지 함께 바뀌므로, 학부모가 점수를 물어올 때
        //   "누가 · 어느 문항을 · 뭐라고 쓴 걸 뭘로 바꿔서 · 몇 점이 됐는지"가 한 번에 읽혀야 한다.
        //   답 전문 보존이 목적이라 한두 문항 수정이면 3000자까지 통째로 남기고,
        //   한꺼번에 여러 문항을 고칠 때만 20000자 detail 한도에 맞춰 앞부분 + 길이로 줄인다.
        const editedIds = Object.keys(patch).filter(qid => qById.has(qid));
        const per = editedIds.length <= 3 ? 3000 : (editedIds.length <= 10 ? 600 : 150);
        const editedList = editedIds.slice(0, 40).map(qid => {
          const q = qById.get(qid);
          const b = logAnswer(answersBefore[qid], per), a2 = logAnswer(answers[qid], per);
          return {
            문항id: qid, 문항: String(q.label || '').slice(0, 120), 종류: q.type,
            전: b, 후: a2, 실제변경: b.값 !== a2.값 || b.길이 !== a2.길이,
            서술형판정초기화: q.type === 'long' && manualBefore[qid] !== undefined,
          };
        });
        await logAudit(env, request, {
          action: 'survey.response.edit',
          target: 'survey/' + id + '/response/' + rid,
          targetName: resp.respondent_name || '',
          summary: '[' + (resp.respondent_name || '이름없음') + '] ' + (s.quiz === 1 ? '테스트' : '설문') + ' ['
            + (s.title || id) + '] 학생 답 ' + editedList.length + '문항 직접 수정'
            + (s.quiz === 1 ? (' · 점수 ' + (resp.score == null ? '-' : resp.score) + '→' + score + '/' + maxScore) : '')
            + ' (덮어쓴 옛 답은 이 로그가 유일한 사본)',
          detail: {
            설문id: id, 설문제목: s.title || '', 응답id: rid,
            응답자: resp.respondent_name || '', 응답자전화: resp.respondent_phone || '',
            수정문항수: editedList.length,
            수정내역: editedList,
            점수: { 전: resp.score, 후: score },
            만점: { 전: resp.max_score, 후: maxScore },
            서술형판정: { 전: manualBefore, 후: manual },
            테스트종류: s.test_kind || '(일반)',
            성적표반영: !!(s.quiz === 1 && s.test_kind && s.anonymous !== 1 && resp.respondent_name),
            비고: '학생·학부모에게는 아무 알림도 안 간다 — 바뀐 사실을 아는 건 이 로그뿐',
          },
        });

        // 테스트 종류 퀴즈면 성적표도 수정된 점수로 덮어씀(같은 행 upsert — 중복 안 쌓임)
        if (s.quiz === 1 && s.test_kind && s.anonymous !== 1 && resp.respondent_name) {
          // 📓 2026-07-31 — 관리자가 학생 답을 직접 고쳐 점수가 바뀐 경우. 학생에게는 아무 알림도 안 간다.
          //   성적표가 몇 점에서 몇 점으로 바뀌었는지는 이 로그가 유일한 근거다.
          const p = upsertTestScore(env, {
            survey: { id: s.id, title: s.title, testKind: s.test_kind, anonymous: s.anonymous === 1 },
            respondentName: resp.respondent_name, score, maxScore,
          }).then((sr) => logScoreSync(env, request, sr, {
            survey: s, responseId: rid, respondentName: resp.respondent_name,
            score, maxScore,
            경로: '관리자가 학생 답 직접 수정 후 재채점(PATCH ?editAnswers=1)',
          })).catch(() => {});
          if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
          else if (p && typeof p.catch === 'function') p.catch(() => {});
        }
        return jsonOk({ ok: true, responseId: rid, answers, score, maxScore, manual });
      }

      // ── PATCH (설문 수정) ──
      if (method === 'PATCH') {
        const id = url.searchParams.get('id');
        if (!id) return jsonErr('id가 필요합니다.');
        // 🔎 2026-07-31 — 어차피 하던 존재확인 SELECT 를 **넓히기만** 하면 '고치기 전 값'이 공짜로 생긴다
        //   (쿼리 수는 그대로). 예전엔 id·quiz만 읽어서, 제목·대상·문항이 무엇에서 무엇으로 바뀌었는지
        //   남길 방법 자체가 없었다 — "왜 우리 반엔 안 떴냐"는 질문에 답할 근거가 통째로 비어 있었다.
        const ex = await env.DB.prepare('SELECT * FROM surveys WHERE id=?').bind(id).first();
        if (!ex) return jsonErr('설문을 찾을 수 없습니다.', 404);
        if (isStaff && ex.quiz !== 1) {
          await logStaffBlocked(env, request, {
            survey: ex, surveyId: id, staffPhone,
            행위: '설문 설정 수정(PATCH — 제목·대상·상태·문항)',
          });
          return jsonErr('조교는 테스트만 수정할 수 있어요.', 403);
        }
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
        if (!sets.length) {
          // 📓 2026-07-31 — 고칠 칸이 하나도 안 넘어온 '빈 수정'도 남긴다(관우T: 사소한 것까지 전부).
          //   화면은 "저장됨"이라고 뜨는데 DB는 그대로인 경우라, 이 기록이 없으면
          //   "저장했는데 왜 안 바뀌었냐"를 영영 설명할 수 없다.
          await logAudit(env, request, {
            action: 'survey.update.noop',
            target: String(id), targetName: ex.title || '',
            summary: (ex.quiz === 1 ? '테스트' : '설문') + ' [' + (ex.title || id) + '] 수정 요청 — 변경 없음(DB 손 안 댐)',
            detail: {
              설문id: id, 제목: ex.title || '',
              보낸칸: Object.keys(body || {}).slice(0, 30),
              사유: '수정 대상 칸이 하나도 안 넘어옴 — UPDATE 자체를 실행하지 않았다',
            },
          });
          return jsonOk({ ok: true, id });
        }
        sets.push('updated_at=?'); vals.push(nowIso());
        vals.push(id);
        await env.DB.prepare('UPDATE surveys SET ' + sets.join(', ') + ' WHERE id=?').bind(...vals).run();

        // 📓 2026-07-31 — 설문/테스트 설정 변경은 학생 화면에 즉시 반영되는 변화다(대상·상태·문항).
        //   지금까진 updated_at 만 갱신돼 "언젠가 바뀌었다"만 알 수 있었고, 무엇이 어떻게 바뀌었는지는
        //   아무 흔적도 없었다. 특히 대상(학원·반)은 오배송 사고의 직접 원인이 되는 칸이라 칸별 전/후로 남긴다.
        const COL_KO = {
          title: '제목', description: '설명', audience: '대상역할', aud_academy: '대상학원',
          aud_class: '대상반', anonymous: '익명', quiz: '퀴즈여부', status: '상태',
          test_kind: '테스트종류', questions: '문항',
        };
        const beforeKo = {}, afterKo = {};
        sets.forEach((sq, i) => {
          const col = sq.replace('=?', '');
          if (col === 'updated_at') return;          // 항상 바뀌는 칸이라 diff에서 뺀다(잡음)
          const k = COL_KO[col] || col;
          beforeKo[k] = ex[col];
          afterKo[k] = vals[i];
        });
        const d = diffFields(beforeKo, afterKo, Object.keys(afterKo));
        await logAudit(env, request, {
          action: ex.quiz === 1 ? 'quiz.update' : 'survey.update',
          target: String(id), targetName: ex.title || '',
          summary: (ex.quiz === 1 ? '테스트' : '설문') + ' [' + (ex.title || id) + '] 수정 — '
            + (d.요약 || '값은 그대로(같은 값으로 덮어씀)'),
          detail: {
            설문id: id, 제목: ex.title || '',
            바뀐칸: d.바뀐칸, 변경: d.변경,
            보낸칸: Object.keys(body || {}).slice(0, 30),
            // 문항을 통째로 갈아끼우면 옛 문항(정답 포함)은 사라진다 → 전문을 남긴다.
            문항교체: body.questions !== undefined ? {
              이전문항: String(ex.questions || '').slice(0, 3000),
              새문항: String(afterKo['문항'] || '').slice(0, 3000),
              이전문항길이: String(ex.questions || '').length,
              새문항길이: String(afterKo['문항'] || '').length,
            } : null,
            결과: body.questions !== undefined && ex.quiz === 1
              ? '문항이 바뀐 테스트라 아래 quiz.regrade 로그처럼 기존 응답이 전부 재채점된다'
              : '기존 응답 점수는 그대로',
          },
        });

        // 📓 2026-07-31 — 열림/종료는 "학생이 지금 낼 수 있냐"를 가르는 스위치라, 수정 로그에 섞어 두면
        //   나중에 "언제 닫혔냐"를 찾기 어렵다. 상태 전환만 별도 한 줄로 더 남겨 검색되게 한다.
        if (Object.prototype.hasOwnProperty.call(afterKo, '상태') && String(ex.status || '') !== String(afterKo['상태'])) {
          const st = String(afterKo['상태']);
          await logAudit(env, request, {
            action: st === 'closed' ? 'survey.close' : (st === 'open' ? 'survey.open' : 'survey.draft'),
            target: String(id), targetName: ex.title || '',
            summary: (ex.quiz === 1 ? '테스트' : '설문') + ' [' + (ex.title || id) + '] '
              + (st === 'closed' ? '종료 — 이제 학생은 제출할 수 없다'
                 : st === 'open' ? '열림 — 대상 학생·학부모에게 즉시 노출된다'
                 : '초안으로 되돌림 — 학생 화면에서 사라진다'),
            detail: {
              설문id: id, 제목: ex.title || '', 퀴즈: ex.quiz === 1,
              상태: { 전: ex.status || '', 후: st },
              대상역할: ex.audience || '', 테스트종류: ex.test_kind || '(일반)',
              예외: st === 'closed'
                ? '재제출 허용(resubmit_allow)을 받은 학생만 종료 후에도 제출 가능'
                : '해당 없음',
            },
          });
        }

        // ── 문항이 바뀐 퀴즈는 기존 응답 전체를 "가장 최근 문항" 기준으로 재채점 (2026-07-16 관우T 확정) ──
        //   문항 수정 전 제출한 학생도 새 기준으로 점수 통일 — 성적 불일치 방지.
        //   장문형 O·X 판정(manual)은 문항 id가 살아 있으면 유지, 삭제된 문항 것은 자동 무시.
        let regraded = 0;
        if (body.questions !== undefined) {
          const s2 = await env.DB.prepare('SELECT * FROM surveys WHERE id=?').bind(id).first();
          if (s2 && s2.quiz === 1) {
            const nq = parseQuestions(s2.questions);
            const { results: resps } = await env.DB.prepare(
              'SELECT * FROM survey_responses WHERE survey_id=?'
            ).bind(id).all();
            const regradeRows = [], regradeFailed = [];
            for (const r of (resps || [])) {
              let answers = {}; try { answers = JSON.parse(r.answers || '{}') || {}; } catch (_) {}
              let manual = {};  try { manual = JSON.parse(r.manual || '{}') || {}; } catch (_) {}
              const graded = gradeAnswers(nq, answers);
              let manualScore = 0;
              for (const q of nq) {
                if (q.type === 'long' && manual[q.id] === 1 && Number.isFinite(q.points)) manualScore += q.points;
              }
              const score = graded.score + manualScore;
              try {
                await env.DB.prepare('UPDATE survey_responses SET score=?, max_score=? WHERE id=?')
                  .bind(score, graded.maxScore, r.id).run();
                regraded++;
                // 로그용 수집 — 학생별 점수 전/후. 아래 for 문 끝난 뒤 한 줄로 묶어 남긴다.
                regradeRows.push({
                  응답id: r.id, 응답자: r.respondent_name || '',
                  전: r.score, 후: score, 만점전: r.max_score, 만점후: graded.maxScore,
                });
              } catch (_) { regradeFailed.push({ 응답id: r.id, 응답자: r.respondent_name || '' }); continue; }
              // 테스트 종류 퀴즈면 성적표(exam_scores)도 새 점수로 덮어씀(best-effort)
              if (s2.test_kind && s2.anonymous !== 1 && r.respondent_name) {
                // 📓 2026-07-31 — 문항을 고치면 **이미 제출한 학생 전원**의 성적표가 조용히 새 점수로 덮여쓰인다.
                //   한 번의 문항 수정이 반 전체 성적을 건드리는 셈인데 그 흔적이 하나도 없었다.
                //   → 학생 1명당 1줄씩 남긴다(누구 점수가 몇 점에서 몇 점으로 바뀌었는지).
                //   ⚠️ .then 의 인자 이름을 sr 로 둔다 — r 로 쓰면 바깥 응답 행(r)을 가려버린다.
                const p = upsertTestScore(env, {
                  survey: { id: s2.id, title: s2.title, testKind: s2.test_kind, anonymous: false },
                  respondentName: r.respondent_name, score, maxScore: graded.maxScore,
                }).then((sr) => logScoreSync(env, request, sr, {
                  survey: s2, responseId: r.id, respondentName: r.respondent_name,
                  score, maxScore: graded.maxScore,
                  경로: '문항 수정에 따른 기존 응답 전체 재채점(PATCH 설문수정)',
                })).catch(() => {});
                if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
                else if (p && typeof p.catch === 'function') p.catch(() => {});
              }
            }

            // ⚠️ 2026-07-31 — 문항을 고치면 **이미 제출한 학생들 점수가 조용히 다시 매겨진다.**
            //   학생·학부모에겐 알림이 안 가고 성적표(exam_scores)까지 덮어써지는데,
            //   지금까진 응답 수(regraded)만 응답 JSON으로 돌려주고 끝이라 흔적이 0이었다.
            //   → "어제 80점이었는데 오늘 60점"의 원인을 대는 유일한 근거로 학생별 전/후를 남긴다.
            //   대상이 0명이어도 남긴다(관우T: 사소한 것까지 전부) — 재채점이 안 돈 것도 사실이다.
            const scoreMoved = regradeRows.filter(x => String(x.전) !== String(x.후));
            await logAudit(env, request, {
              action: 'quiz.regrade',
              target: String(id), targetName: s2.title || '',
              summary: '테스트 [' + (s2.title || id) + '] 문항 수정에 따른 일괄 재채점 — 대상 '
                + (resps || []).length + '명 · 반영 ' + regraded + '명 · 점수 바뀐 학생 ' + scoreMoved.length + '명'
                + (regradeFailed.length ? ' · 실패 ' + regradeFailed.length + '명' : '')
                + ((resps || []).length === 0 ? ' (아직 응답자가 없어 재채점 대상 0명)' : ''),
              detail: {
                설문id: id, 제목: s2.title || '',
                대상응답수: (resps || []).length,
                재채점성공: regraded,
                점수바뀐인원: scoreMoved.length,
                재채점내역: regradeRows.slice(0, 200),     // 200명 넘으면 앞부분만(detail 20000자 한도)
                일부만저장: regradeRows.length > 200,
                실패: regradeFailed.slice(0, 50),
                테스트종류: s2.test_kind || '(일반)',
                성적표반영: !!(s2.test_kind && s2.anonymous !== 1),
                비고: '학생·학부모에게 알림은 안 나간다 — 점수가 바뀐 사실을 아는 건 이 로그뿐',
              },
            });
          }
        }
        return jsonOk({ ok: true, id, regraded });
      }

      // ── DELETE ?id=X&responseId=Y (응답 1건 삭제 = 재제출 허용) ──
      //   잘못 제출한 학생의 응답을 지우면 중복 차단(휴대폰당 1회)이 풀려 다시 제출할 수 있다.
      //   테스트 퀴즈로 성적표에 올라간 점수(source_key='quiz:<id>')도 함께 정리(best-effort).
      if (method === 'DELETE' && url.searchParams.get('responseId')) {
        const id = url.searchParams.get('id');
        if (!id) return jsonErr('id가 필요합니다.');
        const rid = parseInt(url.searchParams.get('responseId'), 10);
        if (!Number.isFinite(rid)) return jsonErr('responseId가 필요합니다.');
        const s = await env.DB.prepare('SELECT * FROM surveys WHERE id=?').bind(id).first();
        if (!s) return jsonErr('설문을 찾을 수 없습니다.', 404);
        if (isStaff && s.quiz !== 1) {
          await logStaffBlocked(env, request, {
            survey: s, surveyId: id, responseId: rid,
            staffPhone, 행위: '학생 응답 1건 삭제(DELETE ?responseId=)',
          });
          return jsonErr('조교는 테스트만 관리할 수 있어요.', 403);
        }
        // 🔎 어차피 하던 존재확인 SELECT를 **넓히기만** 하면 before 가 공짜로 생긴다(쿼리 수 동일).
        //    지워지는 건 학생의 답안 + 점수다. 무엇이 사라졌는지 남겨야 재제출 분쟁에 답할 수 있다.
        const resp = await env.DB.prepare(
          'SELECT id, respondent_name, respondent_phone, answers, answers_twin, score, max_score, ' +
          'score_twin, max_score_twin, created_at FROM survey_responses WHERE id=? AND survey_id=?'
        ).bind(rid, id).first();
        if (!resp) return jsonErr('응답을 찾을 수 없습니다.', 404);
        const dOne = await env.DB.prepare('DELETE FROM survey_responses WHERE id=?').bind(rid).run();
        await logAudit(env, request, {
          action: 'survey.response.delete',
          target: 'survey/' + id + '/response/' + rid,
          targetName: resp.respondent_name || '',
          summary: '[' + (resp.respondent_name || '이름없음') + '] ' + (s.quiz === 1 ? '테스트' : '설문')
            + ' [' + (s.title || id) + '] 응답 삭제 (점수 '
            + (resp.score == null ? '-' : resp.score) + '/' + (resp.max_score == null ? '-' : resp.max_score) + ') → 재제출 허용',
          detail: {
            설문id: id, 설문제목: s.title || '', 응답id: rid,
            응답자: resp.respondent_name || '', 응답자전화: resp.respondent_phone || '',
            점수: { 원본: resp.score, 만점: resp.max_score, 쌍둥이: resp.score_twin, 쌍둥이만점: resp.max_score_twin },
            지워진답안: String(resp.answers || '').slice(0, 4000),
            지워진쌍둥이답안: String(resp.answers_twin || '').slice(0, 2000),
            응답일: resp.created_at || '',
            삭제행수: (dOne.meta && dOne.meta.changes) || 0,
            연동성적삭제: !!(s.test_kind && resp.respondent_name),   // deleteTestScore 로 exam_scores 도 지움
          },
        });
        // 재제출 허용 grant 기록 — 이 학생(휴대폰)은 설문이 종료(closed)됐어도 다시 들어와 재제출 가능.
        //   (열린 설문은 응답 삭제만으로 중복차단이 풀려 재입장되지만, 종료된 테스트는 grant가 없으면 막힌다.)
        if (resp.respondent_phone) {
          const grants = resubmitPhones(s);
          if (!grants.includes(resp.respondent_phone)) {
            grants.push(resp.respondent_phone);
            let granted = false;
            try { await env.DB.prepare('UPDATE surveys SET resubmit_allow=? WHERE id=?').bind(JSON.stringify(grants), id).run(); granted = true; } catch (_) {}
            // 📓 2026-07-31 — 위 삭제 로그와 별개인 **두 번째 쓰기**다(설문 행이 바뀐다).
            //   이건 "종료된 시험에 이 학생만 다시 들어올 수 있게" 여는 예외 허가인데,
            //   설문 상태(closed)는 그대로라 화면만 봐서는 누구에게 문이 열렸는지 알 길이 없었다.
            //   → 누구에게 언제 열어줬는지 따로 남긴다(회수는 survey.resubmit.consume 과 짝).
            await logAudit(env, request, {
              action: 'survey.resubmit.grant',
              target: 'survey/' + id,
              targetName: resp.respondent_name || '',
              summary: '[' + (resp.respondent_name || '이름없음') + '] 재제출 허용 부여 — '
                + (s.quiz === 1 ? '테스트' : '설문') + ' [' + (s.title || id) + ']'
                + (s.status === 'closed' ? ' (종료됐지만 이 학생만 다시 제출 가능)' : '')
                + (granted ? '' : ' ※ 저장 실패'),
              detail: {
                설문id: id, 제목: s.title || '', 설문상태: s.status || '',
                대상자: resp.respondent_name || '', 대상전화: resp.respondent_phone,
                허용목록: { 전: resubmitPhones(s), 후: grants },
                저장성공: granted,
                결과: '이 학생이 다시 제출하면 허가는 1회성으로 소비된다(survey.resubmit.consume)',
              },
            });
          }
        }
        if (s.test_kind && resp.respondent_name) {
          // ⚠️ 2026-07-31 — 응답을 지우면 성적표의 그 테스트 점수도 딸려서 사라진다.
          //   위 응답삭제 로그(survey.response.delete)에는 '연동성적삭제: true' 한 줄뿐이라
          //   **몇 점이 지워졌는지**는 안 남았다 → 지워진 성적값 자체를 여기서 남긴다(되돌릴 근거).
          const p = deleteTestScore(env, { surveyId: s.id, respondentName: resp.respondent_name })
            .then((sr) => logScoreDelete(env, request, sr, {
              survey: s, responseId: rid, respondentName: resp.respondent_name,
              경로: '응답 1건 삭제(재제출 허용) — DELETE ?responseId=',
            })).catch(() => {});
          if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
          else if (p && typeof p.catch === 'function') p.catch(() => {});
        }
        return jsonOk({ ok: true, removed: 1, responseId: rid });
      }

      // ── DELETE (설문+응답 삭제) ──
      if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) return jsonErr('id가 필요합니다.');
        if (isStaff) {
          // 🔎 2026-07-31 — 어차피 하던 존재확인 SELECT 를 몇 칸 넓히기만 하면(쿼리 수 그대로)
          //   막힌 로그에 "무슨 설문을 지우려 했는지"를 제목까지 적을 수 있다. quiz 한 칸만 읽으면
          //   나중에 로그에 id 숫자만 남아 그게 어떤 설문이었는지 되짚을 수가 없다(이미 지워졌을 수도 있고).
          const ex = await env.DB.prepare('SELECT id, title, quiz, status, test_kind FROM surveys WHERE id=?').bind(id).first();
          if (!ex) return jsonErr('설문을 찾을 수 없습니다.', 404);
          if (ex.quiz !== 1) {
            await logStaffBlocked(env, request, {
              survey: ex, surveyId: id, staffPhone,
              행위: '설문 통째 삭제(DELETE — 응답 전체 동반 삭제)',
            });
            return jsonErr('조교는 테스트만 삭제할 수 있어요.', 403);
          }
        }

        // ⚠️ 설문/테스트 1건 + 그 **모든 학생 응답**이 통째로 사라진다(복구 불가).
        //    예전엔 로그가 없어서 "어떤 시험이었는지 · 누가 몇 점이었는지"조차 남지 않았다.
        //    → 지우기 전에 설문 원본과 응답자 명단(이름·점수)을 먼저 읽어 둔다.
        //    ※ 원장 경로는 존재확인조차 안 했으므로(조교만 SELECT), 여기서 처음 읽는다.
        const sBefore = await env.DB.prepare('SELECT * FROM surveys WHERE id=?').bind(id).first();
        let respRows = [];
        try {
          const { results } = await env.DB.prepare(
            'SELECT id, respondent_name, respondent_phone, score, max_score, score_twin, max_score_twin, created_at ' +
            'FROM survey_responses WHERE survey_id=? ORDER BY id'
          ).bind(id).all();
          respRows = results || [];
        } catch (_) {}

        // ── 2026-08-02 §11 6번 — 성적표에 올라간 이 테스트 점수를 어떻게 할지 ──
        //   관우T 확정(원문 "물어봐"): **지울 때 그때그때 고른다.**
        //   기본은 「남긴다」 — `deleteScores=1` 이 없으면 예전과 **완전히 동일**하게 동작한다(무회귀).
        //   실수로 아이들 성적 이력이 통째로 날아가는 쪽이 훨씬 아프기 때문이다.
        //   ⚠️ 어느 쪽을 고르든 **지우기 전에** 그 성적 행들을 읽어 로그에 통째로 박는다.
        //      남긴 경우에도 남긴다 — 나중에 "원본 테스트가 없는 이 점수는 뭐지"의 답이 이 로그다.
        //   ⚠️ 이름이 아니라 source_key 로만 지운다 → 동명이인 오삭제가 원천적으로 불가능.
        //      (deleteTestScore 는 이름 매칭이라 동명이인이면 아예 포기한다. 이 경로엔 그 한계가 없다.)
        const wantDeleteScores = url.searchParams.get('deleteScores') === '1';
        // 🔒 여러 학생의 성적을 한 번에 지우는 건 원장만. 조교는 테스트만 지운다.
        //    (조교도 응답 1건 삭제로 그 학생 점수 하나는 지울 수 있다 — 여기서 막는 건 **일괄**이다.)
        //    조용히 무시하지 않고 **아무것도 지우기 전에** 403 으로 세운다.
        if (wantDeleteScores && isStaff) {
          return jsonErr('성적표 점수까지 한꺼번에 지우는 건 원장만 할 수 있어요. 테스트만 지우려면 「성적은 남기기」로 다시 시도해 주세요.', 403);
        }
        const scoreSourceKey = 'quiz:' + id;
        let scoreRows = [];
        try {
          const q = await env.DB.prepare(
            'SELECT e.id, e.student_id, e.exam_type, e.label, e.raw_score, e.exam_date, e.created_at, st.name AS student_name ' +
            'FROM exam_scores e LEFT JOIN students st ON st.id = e.student_id ' +
            'WHERE e.source_key=? ORDER BY e.id'
          ).bind(scoreSourceKey).all();
          scoreRows = q.results || [];
        } catch (_) { /* exam_scores 가 아직 없을 수 있다 — 0건으로 본다 */ }

        const dResp = await env.DB.prepare('DELETE FROM survey_responses WHERE survey_id=?').bind(id).run();
        const dSurv = await env.DB.prepare('DELETE FROM surveys WHERE id=?').bind(id).run();

        let scoreRemoved = 0;
        let scoreDeleteError = '';
        if (wantDeleteScores && scoreRows.length) {
          try {
            const dScore = await env.DB.prepare('DELETE FROM exam_scores WHERE source_key=?')
              .bind(scoreSourceKey).run();
            scoreRemoved = (dScore.meta && dScore.meta.changes) || 0;
          } catch (e) {
            // 성적 삭제 실패가 설문 삭제를 되돌리지는 못한다(이미 지워졌다) → 사유를 로그에 남긴다.
            scoreDeleteError = String((e && e.message) || e);
          }
        }

        await logAudit(env, request, {
          action: (sBefore && sBefore.quiz === 1) ? 'quiz.delete' : 'survey.delete',
          target: String(id),
          targetName: (sBefore && sBefore.title) || '',
          summary: ((sBefore && sBefore.quiz === 1) ? '테스트' : '설문') + ' [' + ((sBefore && sBefore.title) || id)
            + '] 영구 삭제 — 응답 ' + respRows.length + '명분 함께 삭제 (복구 불가)'
            + (scoreRows.length
              ? (wantDeleteScores
                ? ' · 성적표 점수 ' + scoreRemoved + '명분도 함께 삭제'
                  + (scoreDeleteError ? ' ※ 실패: ' + scoreDeleteError : '')
                : ' · 성적표 점수 ' + scoreRows.length + '명분은 원장 선택으로 남김')
              : ''),
          detail: {
            설문id: id,
            지워진설문: sBefore ? {
              제목: sBefore.title || '', 상태: sBefore.status || '', 퀴즈: sBefore.quiz === 1,
              테스트종류: sBefore.test_kind || '', 대상: sBefore.audience || '',
              문항: sBefore.questions || '', 생성일: sBefore.created_at || '',
            } : null,
            응답자수: respRows.length,
            지워진응답: respRows.slice(0, 300),          // "누구 점수가 날아갔나"의 유일한 근거
            응답일부만저장: respRows.length > 300,
            삭제행수: {
              응답: (dResp.meta && dResp.meta.changes) || 0,
              설문: (dSurv.meta && dSurv.meta.changes) || 0,
            },
            성적표처리: scoreRows.length === 0
              ? '해당 없음 (성적표에 올라간 점수 0건)'
              : (wantDeleteScores ? '원장이 「함께 삭제」를 선택' : '원장이 「남기기」를 선택 (기본)'),
            성적표대상: scoreRows.length,
            성적표삭제행수: scoreRemoved,
            성적표삭제실패: scoreDeleteError || '',
            // 지웠든 남겼든 **지우기 전 스냅샷**을 박아 둔다. 지웠으면 되살릴 근거,
            // 남겼으면 "원본 테스트 없는 이 점수는 뭔가"의 답이 된다.
            대상성적: scoreRows.slice(0, 300).map(x => ({
              학생: x.student_name || ('학생#' + x.student_id),
              학생id: String(x.student_id),
              종류: x.exam_type || '',
              제목: x.label || '',
              점수: x.raw_score,
              시험일: x.exam_date || '',
              등록시각: x.created_at || '',
            })),
            성적일부만저장: scoreRows.length > 300,
            비고: wantDeleteScores
              ? '성적표(exam_scores)의 source_key=' + scoreSourceKey + ' 행을 함께 삭제했다 — 이름이 아니라 source_key 기준이라 동명이인 오삭제 없음'
              : '성적표(exam_scores)는 남겼다 — 원본 테스트가 사라져도 학생 성적표의 그 점수는 그대로 보인다(제목은 삭제 시점 제목 그대로). 나중에 지우려면 성적 화면에서 한 줄씩 삭제',
          },
        });
        return jsonOk({
          ok: true, removed: 1,
          scoreCount: scoreRows.length,
          scoreRemoved,
          scoreKept: wantDeleteScores ? 0 : scoreRows.length,
        });
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
      if (s.quiz !== 1) return jsonErr('테스트가 아니에요.', 400);
      const resp = await env.DB.prepare(
        'SELECT * FROM survey_responses WHERE survey_id=? AND respondent_phone=?'
      ).bind(id, access.phone).first();
      if (!resp) {
        // 📓 2026-07-31 — 클리닉에서 쌍둥이 답을 넣으려는데 원본 응답이 없어 막힌 경우.
        //   원본이 '없다'는 건 안 봤거나, 이름·계정이 달라 다른 휴대폰으로 제출됐거나,
        //   조교가 응답을 지운(재제출 허용) 직후라는 뜻이다 — 셋 다 사람이 확인해야 할 상황인데
        //   지금까진 학생 화면의 안내문 한 줄로 끝나고 기록이 남지 않았다.
        await logSubmitBlocked(env, request, access, {
          survey: s, surveyId: id, 코드: 409,
          action: 'quiz.twin.blocked',
          행위: '오답 재도전(쌍둥이) 제출(POST ?respond=1&twin=1)',
          사유: '이 휴대폰으로 제출된 원본 시험 응답이 없다',
          추가: { 조회한휴대폰: access.phone },
          결과: '재도전 답은 저장되지 않았다 — 원본이 다른 계정으로 제출됐거나 응답이 삭제된 상태일 수 있다',
        });
        return jsonErr('먼저 원본 시험을 제출해 주세요.', 409);
      }

      const questions = parseQuestions(s.questions);
      let origAnswers = {};
      try { origAnswers = JSON.parse(resp.answers || '{}'); } catch (_) {}
      const graded = gradeAnswers(questions, origAnswers);
      // 재도전 대상 = 자동채점에서 '틀린' + 쌍둥이 정답이 등록된 문항.
      const eligible = questions.filter(q => {
        const d = graded.detail[q.id];
        return d && d.correct === false && q.correctTwin != null && q.correctTwin !== '';
      });
      if (!eligible.length) {
        // 🔎 2026-07-31 — 학생 화면엔 재도전 버튼이 떴는데 서버는 "대상 문항 0개"라고 되돌린 경우.
        //   대개 문항이 수정돼 재채점되면서 오답이 정답이 됐거나, 쌍둥이 정답(correctTwin)이
        //   등록 안 된 문항이라 그렇다. 학생은 "버튼은 있는데 안 된다"로 겪고 조교는 재현을 못 한다.
        //   → 서버가 본 판정 근거(오답 수·쌍둥이 정답 등록 수)를 남겨 어느 쪽이 원인인지 바로 가리게 한다.
        const 오답 = questions.filter(q => {
          const d = graded.detail[q.id];
          return d && d.correct === false;
        });
        await logSubmitBlocked(env, request, access, {
          survey: s, surveyId: id, 코드: 400,
          action: 'quiz.twin.blocked',
          행위: '오답 재도전(쌍둥이) 제출(POST ?respond=1&twin=1)',
          사유: '재도전 대상 문항이 0개 — 틀린 문항이 없거나, 틀린 문항에 쌍둥이 정답이 등록돼 있지 않다',
          추가: {
            응답id: resp.id,
            원본점수: { 점수: resp.score, 만점: resp.max_score },
            현재기준오답수: 오답.length,
            오답문항id: 오답.map(q => q.id).slice(0, 40),
            쌍둥이정답등록문항수: questions.filter(q => q.correctTwin != null && q.correctTwin !== '').length,
          },
          결과: '재도전 답은 저장되지 않았다 — 문항에 쌍둥이 정답을 등록해야 재도전이 열린다',
        });
        return jsonErr('재도전할 오답 문항이 없어요.', 400);
      }

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
          ok = sameAnswer(a, q.correctTwin, q.type === 'math');   // 단위 무시 포함(2026-08-14)
        }
        if (ok) tScore++;
        if (!attempted) detail[q.id] = { pending: true };
        else detail[q.id] = ok ? { correct: true } : { correct: false, answer: q.correctTwin };
      }
      const tMax = eligible.length;
      await env.DB.prepare(
        'UPDATE survey_responses SET answers_twin=?, score_twin=?, max_score_twin=? WHERE id=?'
      ).bind(JSON.stringify(twinAnswers), tScore, tMax, resp.id).run();

      // 🔎 2026-07-31 — 클리닉 오답 재도전(쌍둥이) 제출. 학생이 직접 쓴 답이고,
      //   같은 문항을 또 내면 앞서 낸 답이 조용히 덮어써진다(옛 답은 DB에 안 남는다).
      //   "낸 적 없다 / 다르게 냈다" 다툼이 생기면 이 로그가 유일한 사본이라 전/후를 같이 남긴다.
      //   ⚠️ 행위자는 로그인한 학생·학부모라 헤더(actorOf)로는 절대 못 알아낸다 → actor 를 직접 명시.
      const twinChanged = [];
      for (const q of eligible) {
        if (!Object.prototype.hasOwnProperty.call(src, q.id)) continue;
        const dd = detail[q.id] || {};
        twinChanged.push({
          문항id: q.id, 문항: String(q.label || '').slice(0, 100),
          전: logAnswer(prevTwin[q.id], 200), 후: logAnswer(twinAnswers[q.id], 200),
          채점: dd.pending ? '미입력' : (dd.correct ? 'O' : 'X'),
        });
      }
      await logAudit(env, request, {
        action: 'quiz.twin.submit',
        actor: access.phone,
        actorRole: (access.student && access.student.role) || 'student',
        actorName: (access.student && access.student.name) || resp.respondent_name || '',
        target: 'survey/' + id + '/response/' + resp.id,
        targetName: resp.respondent_name || '',
        summary: '[' + (resp.respondent_name || (access.student && access.student.name) || '이름없음') + '] 테스트 ['
          + (s.title || id) + '] 오답 재도전 제출 — ' + twinChanged.length + '문항 입력 · '
          + tScore + '/' + tMax + '개 정답 (원본 시험 점수는 그대로)',
        detail: {
          설문id: id, 설문제목: s.title || '', 응답id: resp.id,
          학생id: (access.student && access.student.id) || null,   // 동명이인 대비 — 이름 말고 id로 특정
          학생이름: (access.student && access.student.name) || '',
          로그인휴대폰: access.phone, 역할: (access.student && access.student.role) || '',
          재도전대상문항수: eligible.length,
          이번에입력한문항: twinChanged.slice(0, 25),
          입력문항일부만저장: twinChanged.length > 25,
          점수: { 전: { 맞은개수: resp.score_twin, 대상: resp.max_score_twin }, 후: { 맞은개수: tScore, 대상: tMax } },
          원본점수: { 점수: resp.score, 만점: resp.max_score },
          비고: '쌍둥이 재도전은 원본 성적·성적표(exam_scores)에 반영되지 않는다',
        },
      });
      return jsonOk({ ok: true, twin: true, score: tScore, maxScore: tMax, detail });
    }

    // ── POST ?respond=1 (응답 제출) ──
    if (method === 'POST' && url.searchParams.get('respond') === '1' && url.searchParams.get('twin') !== '1') {
      const id = url.searchParams.get('id');
      if (!id) return jsonErr('id가 필요합니다.');
      const s = await env.DB.prepare('SELECT * FROM surveys WHERE id=?').bind(id).first();
      if (!s) return jsonErr('설문을 찾을 수 없습니다.', 404);
      if (s.status !== 'open' && !resubmitPhones(s).includes(access.phone)) {
        // 📓 2026-07-31 — 학생이 제출 버튼까지 눌렀는데 설문이 이미 닫혀 되돌아간 경우.
        //   화면을 띄워 둔 채 시간이 지나면 학생은 낸 줄 알고, 조교는 미제출로 본다.
        //   "몇 시에 닫혔고 이 학생은 몇 시에 냈나"를 대조할 근거가 이 줄뿐이다(survey.close 로그와 짝).
        await logSubmitBlocked(env, request, access, {
          survey: s, surveyId: id, 코드: 403,
          행위: '응답 제출(POST ?respond=1)',
          사유: '설문 상태가 ' + (s.status || '') + ' — 지금은 제출을 받지 않는다',
          추가: {
            // 이 학생은 허용 목록에 없어서 막힌 것이다. 목록에 다른 사람이 몇 명 있는지를 같이 남겨,
            // "재제출 허용을 줬는데 왜 안 되냐"(= 다른 번호에 줬다)를 바로 가릴 수 있게 한다.
            재제출허용인원: resubmitPhones(s).length,
          },
          결과: '제출 내용은 저장되지 않았다. 다시 받으려면 설문을 열거나 이 번호에 재제출 허용을 줘야 한다',
        });
        return jsonErr('지금은 응답할 수 없는 설문이에요.', 403);
      }
      if (!audienceMatchesStudents(s, access.students)) {
        // ⚠️ 2026-07-31 — 대상(학원·반) 설정이 틀리면 정작 봐야 할 학생이 여기서 튕긴다.
        //   공지 오배송과 같은 뿌리의 사고인데, 지금까진 튕긴 사실이 어디에도 안 남아
        //   "우리 애는 시험을 못 봤다"는 말에 원인을 댈 수가 없었다.
        //   → 설문의 대상 지정과 이 학생의 실제 학원·반을 나란히 남겨 어긋난 지점이 바로 보이게 한다.
        await logSubmitBlocked(env, request, access, {
          survey: s, surveyId: id, 코드: 403,
          행위: '응답 제출(POST ?respond=1)',
          사유: '이 계정은 설문의 응답 대상이 아니다(역할·학원·반 불일치)',
          추가: {
            설문대상역할: s.audience || 'all',
            설문대상학원: parseList(s.aud_academy),
            설문대상반: parseList(s.aud_class),
            내계정의학생들: (access.students || []).slice(0, 20).map(x => ({
              학생id: x.id, 이름: x.name || '', 역할: x.role || '',
              학원: x.academy || '', 반: x.className || '',
            })),
          },
          결과: '제출 내용은 저장되지 않았다 — 대상 학원·반 지정이 맞는지부터 확인해야 한다',
        });
        return jsonErr('이 설문의 응답 대상이 아니에요.', 403);
      }

      // 중복 응답 차단 — 휴대폰 1개당 설문 1회
      const dup = await env.DB.prepare(
        'SELECT id FROM survey_responses WHERE survey_id=? AND respondent_phone=?'
      ).bind(id, access.phone).first();
      if (dup) {
        // 📓 2026-07-31 — 중복 제출로 막힌 것도 남긴다(관우T: 사소한 것까지 전부).
        //   학생은 "분명 냈는데 안 냈다고 나온다 / 또 내라고 한다"로 겪고, 조교는 화면만 봐선 알 수 없다.
        //   이 줄이 있어야 "이미 낸 응답이 있어서 막혔다"는 사실과 그 시각을 댈 수 있다.
        await logAudit(env, request, {
          action: 'survey.response.duplicate',
          actor: access.phone,
          actorRole: (access.student && access.student.role) || 'student',
          actorName: (access.student && access.student.name) || '',
          target: 'survey/' + id,
          targetName: (access.student && access.student.name) || '',
          summary: '[' + ((access.student && access.student.name) || access.phone) + '] '
            + (s.quiz === 1 ? '테스트' : '설문') + ' [' + (s.title || id) + '] 중복 제출 차단 — 이미 제출함(409)',
          detail: {
            설문id: id, 제목: s.title || '', 퀴즈: s.quiz === 1,
            학생id: (access.student && access.student.id) || null,
            학생이름: (access.student && access.student.name) || '',
            로그인휴대폰: access.phone,
            기존응답id: dup.id,
            결과: 'DB는 건드리지 않았다. 다시 내게 하려면 기존 응답을 삭제(재제출 허용)해야 한다',
          },
        });
        return jsonErr('이미 응답한 설문이에요. 감사합니다!', 409);
      }

      const questions = parseQuestions(s.questions);
      const body = await request.json().catch(() => ({}));
      const v = validateAnswers(questions, body.answers);
      if (!v.ok) {
        // 📓 2026-07-31 — 필수 문항을 안 채워 제출이 되돌아간 경우. 학생 입장에선 "냈다"고 기억하지만
        //   DB에는 아무것도 안 들어간다. 시험 시간이 끝난 뒤 "제출했는데 왜 없냐"가 나오면,
        //   이 줄이 "그 시각에 시도는 했으나 어느 문항이 비어 반려됐다"를 보여주는 유일한 증거다.
        //   ⚠️ 학생이 쓴 답 자체는 여기 남기지 않는다 — 반려된 시도까지 답 전문을 쌓으면
        //     로그가 답안 사본 창고가 된다. 어느 문항이 비었는지(반려 사유)만 남긴다.
        await logSubmitBlocked(env, request, access, {
          survey: s, surveyId: id, 코드: 400,
          행위: '응답 제출(POST ?respond=1)',
          사유: String(v.error || '').slice(0, 200),
          추가: {
            문항수: questions.length,
            답이넘어온문항: Object.keys((body && body.answers) || {}).slice(0, 40),
          },
          결과: '제출 내용은 저장되지 않았다 — 학생이 그대로 창을 닫았으면 응답은 없는 상태다',
        });
        return jsonErr(v.error);
      }

      // 퀴즈면 자동 채점 → 점수 저장 + 즉시 결과 반환(정답+점수 노출)
      const isQuiz = s.quiz === 1;
      let graded = null;
      if (isQuiz) graded = gradeAnswers(questions, v.answers);

      const name = clean(body.name, MAX_NAME) || (access.student && access.student.name) || '';
      const ua = clean(request.headers.get('user-agent') || '', 200);
      const now = nowIso();
      const ins = await env.DB.prepare(
        'INSERT INTO survey_responses (survey_id, respondent_phone, respondent_name, answers, score, max_score, ua, created_at) ' +
        'VALUES (?,?,?,?,?,?,?,?)'
      ).bind(
        id, access.phone, name, JSON.stringify(v.answers),
        graded ? graded.score : null, graded ? graded.maxScore : null,
        ua, now
      ).run();

      // 🔎 2026-07-31 — 제출 사실 자체가 어디에도 안 남아 있었다. 응답 행이 나중에 지워지거나
      //   관리자가 답을 고치면 "언제 · 누가 · 몇 점으로 냈는지"의 원본이 통째로 사라진다.
      //   → 제출 시점의 신원(학생 id 포함)·점수·답 요지를 독립 증거로 남긴다.
      //   답 전문은 survey_responses.answers 에 살아 있으므로 여기선 앞부분 + 길이만(로그 한도 보호).
      //   ⚠️ 행위자는 학생·학부모 토큰이라 헤더로는 못 알아낸다 → actor 직접 명시.
      const wasResubmit = resubmitPhones(s).includes(access.phone);
      await logAudit(env, request, {
        action: 'survey.response.submit',
        actor: access.phone,
        actorRole: (access.student && access.student.role) || 'student',
        actorName: (access.student && access.student.name) || name || '',
        target: 'survey/' + id + '/response/' + ((ins.meta && ins.meta.last_row_id) || ''),
        targetName: name || '',
        summary: '[' + (name || access.phone) + '] ' + (isQuiz ? '테스트' : '설문') + ' [' + (s.title || id) + '] 응답 제출'
          + (isQuiz && graded ? (' — ' + graded.score + '/' + graded.maxScore + '점') : '')
          + (wasResubmit ? ' (재제출 허용분)' : '')
          + (s.anonymous === 1 ? ' · 익명' : ''),
        detail: {
          설문id: id, 제목: s.title || '', 퀴즈: isQuiz, 익명: s.anonymous === 1,
          응답id: (ins.meta && ins.meta.last_row_id) || null,
          학생id: (access.student && access.student.id) || null,   // 동명이인 대비 — 이름 말고 id로 특정
          학생이름: (access.student && access.student.name) || '',
          제출이름: name || '', 로그인휴대폰: access.phone,
          역할: (access.student && access.student.role) || '',
          학원: (access.student && access.student.academy) || '', 반: (access.student && access.student.className) || '',
          점수: graded ? graded.score : null, 만점: graded ? graded.maxScore : null,
          문항수: questions.length,
          답요지: questions.slice(0, 40).map(q => ({
            문항id: q.id, 문항: String(q.label || '').slice(0, 60), 답: logAnswer(v.answers[q.id], 150),
          })),
          재제출: wasResubmit,
          설문상태: s.status || '',
          테스트종류: s.test_kind || '(일반)',
          성적표반영: !!(isQuiz && graded && s.test_kind && s.anonymous !== 1),
          제출시각: now,
        },
      });

      // 재제출 grant 소비 — 이 학생이 다시 제출했으니 허용 목록에서 제거(1회성). (2026-07-23)
      if (resubmitPhones(s).includes(access.phone)) {
        const left = resubmitPhones(s).filter(p => p !== access.phone);
        let consumed = false;
        try { await env.DB.prepare('UPDATE surveys SET resubmit_allow=? WHERE id=?').bind(JSON.stringify(left), id).run(); consumed = true; } catch (_) {}
        // 📓 2026-07-31 — 설문 행을 고치는 **별도의 쓰기**다. 1회성 재제출 허가를 여기서 회수한다.
        //   허가(survey.resubmit.grant)와 회수가 짝이 안 맞으면 "왜 또 못 내냐 / 왜 또 낼 수 있냐"가
        //   미궁이 된다. 저장 실패까지 같이 남겨야 목록이 안 지워진 경우를 잡아낼 수 있다.
        await logAudit(env, request, {
          action: 'survey.resubmit.consume',
          actor: access.phone,
          actorRole: (access.student && access.student.role) || 'student',
          actorName: (access.student && access.student.name) || name || '',
          target: 'survey/' + id,
          targetName: name || '',
          summary: '[' + (name || access.phone) + '] 재제출 허용 1회 소비 — ' + (s.quiz === 1 ? '테스트' : '설문')
            + ' [' + (s.title || id) + ']' + (consumed ? '' : ' ※ 목록 저장 실패(허가가 안 지워졌을 수 있음)'),
          detail: {
            설문id: id, 제목: s.title || '', 설문상태: s.status || '',
            학생id: (access.student && access.student.id) || null,
            로그인휴대폰: access.phone,
            허용목록: { 전: resubmitPhones(s), 후: left },
            저장성공: consumed,
            결과: consumed ? '이제 이 학생은 종료된 설문에 다시 못 들어온다' : '허가가 남아 또 제출될 수 있다 — 확인 필요',
          },
        });
      }

      const anon = s.anonymous === 1;
      const who = anon ? '' : name;
      notifyAdmin(context, env, { id: s.id, title: s.title, quiz: isQuiz, score: graded && graded.score, maxScore: graded && graded.maxScore }, who);

      // 테스트 종류가 지정된 퀴즈면 채점 결과를 성적표(exam_scores)에 자동 반영.
      //   best-effort(제출 흐름을 막지 않음) — 익명·미매칭은 헬퍼가 알아서 스킵.
      if (isQuiz && graded && s.test_kind && !anon) {
        // 📓 2026-07-31 — 학생이 제출한 그 순간 성적표에 점수가 꽂힌다. 예전엔 이 자동 반영이
        //   성공했는지 실패했는지(이름이 명단과 안 맞아 그냥 스킵됐는지) 아무 데도 안 남아서,
        //   "시험 봤는데 성적표에 없어요" 문의가 오면 원인을 짚을 수가 없었다.
        const p = upsertTestScore(env, {
          survey: { id: s.id, title: s.title, testKind: s.test_kind, anonymous: anon },
          respondentName: name, score: graded.score, maxScore: graded.maxScore,
        }).then((sr) => logScoreSync(env, request, sr, {
          survey: s, responseId: null, respondentName: name,
          score: graded.score, maxScore: graded.maxScore,
          경로: '학생 응답 제출 → 자동 채점(POST ?respond=1)',
        })).catch(() => {});
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
              // 쌍둥이 채점도 본채점과 같은 규칙 — 수식 동치·단위 무시 포함(2026-08-14).
              //   예전엔 여기만 mathEqual이 빠져 "결과 화면 O / 내 성적 화면 X"가 났다.
              const tok = sameAnswer(ta, q.correctTwin, q.type === 'math');
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
        "SELECT * FROM surveys WHERE status='open' OR (resubmit_allow IS NOT NULL AND resubmit_allow != '[]') ORDER BY id DESC"
      ).all();
      // 종료된 설문은 '재제출 허용'을 받은 학생(휴대폰)에게만 목록에 노출. (2026-07-23)
      const rows = (results || [])
        .filter(r => r.status === 'open' || resubmitPhones(r).includes(access.phone))
        .filter(r => audienceMatchesStudents(r, access.students));
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
      if (s.status !== 'open' && !resubmitPhones(s).includes(access.phone)) return jsonErr('지금은 응답할 수 없는 설문이에요.', 403);
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
