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
const MAX_POINTS = 1000;

const AUDIENCES = new Set(['all', 'student', 'parent']);
const STATUSES = new Set(['draft', 'open', 'closed']);
const QTYPES = new Set(['single', 'multi', 'short', 'long', 'scale', 'dropdown']);

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
  _surveysReady = true;
}

function nowIso() { return new Date().toISOString(); }

// ── 질문 정의 살균 — 관리자가 만든 questions[] 를 안전한 형태로 정규화 ──
function sanitizeQuestions(raw) {
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
    // ── 퀴즈: 정답·배점(있을 때만 저장) ──
    //   single/dropdown = 정답 1개(선택지 중), multi = 정답 여러개(선택지 부분집합),
    //   short = 정답 텍스트(대소문자·공백 무시 비교). scale/long은 채점 대상 아님.
    if (type === 'single' || type === 'dropdown') {
      const c = clean(q.correct, MAX_OPTION);
      if (c && item.options.includes(c)) item.correct = c;
    } else if (type === 'multi') {
      const cs = Array.isArray(q.correct)
        ? q.correct.map(x => clean(x, MAX_OPTION)).filter(x => item.options.includes(x))
        : [];
      if (cs.length) item.correct = Array.from(new Set(cs));
    } else if (type === 'short') {
      const c = clean(q.correct, MAX_ANSWER);
      if (c) item.correct = c;
    }
    if (item.correct !== undefined) {
      let p = parseInt(q.points, 10);
      if (!Number.isFinite(p) || p < 0) p = 1;
      item.points = Math.min(MAX_POINTS, p);
    }
    out.push(item);
  });
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

// 응답 전 학생에게 보낼 문항 — 정답(correct)은 절대 노출하지 않음(치팅 방지). 배점(points)은 남김.
function stripCorrect(questions) {
  return (questions || []).map(q => {
    const c = Object.assign({}, q);
    delete c.correct;
    return c;
  });
}

// 텍스트 정답 비교용 정규화(대소문자·앞뒤·연속공백 무시)
function normText(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── 자동 채점 ──
//   반환: { score, maxScore, detail:{ qid:{ correct:bool, answer(정답), points } } }
//   correct가 정의된 문항만 채점 대상(maxScore에 합산).
function gradeAnswers(questions, answers) {
  let score = 0, maxScore = 0;
  const detail = {};
  for (const q of questions) {
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
    anonymous: r.anonymous === 1,
    quiz: r.quiz === 1,
    status: r.status || 'draft',
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
  return {
    id: r.id,
    respondentName: anonymous ? '' : (r.respondent_name || ''),
    respondentPhone: anonymous ? '' : (r.respondent_phone || ''),
    answers,
    score: (r.score == null ? undefined : r.score),
    maxScore: (r.max_score == null ? undefined : r.max_score),
    createdAt: r.created_at || '',
  };
}

// 로그인 응답자가 이 설문 대상인지 — audience 매칭
function audienceMatches(audience, roles) {
  if (audience === 'all' || !audience) return true;
  if (audience === 'student') return roles.has('student');
  if (audience === 'parent') return roles.has('parent');
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
        const anonymous = (body.anonymous === true || body.anonymous === 1) ? 1 : 0;
        // 조교는 퀴즈만 생성 가능 — quiz=1 강제
        const quiz = isStaff ? 1 : ((body.quiz === true || body.quiz === 1) ? 1 : 0);
        const status = STATUSES.has(body.status) ? body.status : 'draft';
        const questions = sanitizeQuestions(body.questions);
        if (!questions.length) return jsonErr('질문을 하나 이상 추가해 주세요.');
        const now = nowIso();
        const res = await env.DB.prepare(
          'INSERT INTO surveys (title, description, audience, anonymous, quiz, status, questions, created_at, updated_at) ' +
          'VALUES (?,?,?,?,?,?,?,?,?)'
        ).bind(title, description, audience, anonymous, quiz, status, JSON.stringify(questions), now, now).run();
        return jsonOk({ ok: true, id: res.meta && res.meta.last_row_id });
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
        if (body.anonymous !== undefined) { sets.push('anonymous=?'); vals.push((body.anonymous === true || body.anonymous === 1) ? 1 : 0); }
        // 조교는 퀴즈 해제 불가(quiz=0 전환 차단). 원장만 quiz 토글 가능.
        if (body.quiz !== undefined && !isStaff) { sets.push('quiz=?'); vals.push((body.quiz === true || body.quiz === 1) ? 1 : 0); }
        if (body.status !== undefined) { sets.push('status=?'); vals.push(STATUSES.has(body.status) ? body.status : 'draft'); }
        if (body.questions !== undefined) {
          const qs = sanitizeQuestions(body.questions);
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

    // ── POST ?respond=1 (응답 제출) ──
    if (method === 'POST' && url.searchParams.get('respond') === '1') {
      const id = url.searchParams.get('id');
      if (!id) return jsonErr('id가 필요합니다.');
      const s = await env.DB.prepare('SELECT * FROM surveys WHERE id=?').bind(id).first();
      if (!s) return jsonErr('설문을 찾을 수 없습니다.', 404);
      if (s.status !== 'open') return jsonErr('지금은 응답할 수 없는 설문이에요.', 403);
      if (!audienceMatches(s.audience, roles)) return jsonErr('이 설문의 응답 대상이 아니에요.', 403);

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
      const out = { ok: true, message: '응답이 제출됐어요. 감사합니다!' };
      if (isQuiz && graded) {
        out.quiz = true;
        out.score = graded.score;
        out.maxScore = graded.maxScore;
        out.detail = graded.detail;   // { qid:{correct, answer(정답), points} }
      }
      return jsonOk(out);
    }

    // ── GET ?mine=1 (나에게 열린 설문 목록) ──
    if (method === 'GET' && url.searchParams.get('mine') === '1') {
      const { results } = await env.DB.prepare(
        "SELECT * FROM surveys WHERE status='open' ORDER BY id DESC"
      ).all();
      const rows = (results || []).filter(r => audienceMatches(r.audience, roles));
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
      if (!audienceMatches(s.audience, roles)) return jsonErr('이 설문의 응답 대상이 아니에요.', 403);
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
