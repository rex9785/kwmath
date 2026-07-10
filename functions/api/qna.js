// /api/qna — 질문방 (학생 질문 + AI 답변 / 선생님·조교 답변)
// ───────────────────────────────────────────────────────────
// D1 table: qna (없으면 자동 생성). 학생 식별 = author_phone(+student_id).
// 인증: admin(Bearer ADMIN_PASSWORD) = 전체 / 학생·학부모(토큰) = 본인·자녀
//
//  GET  /api/qna                공개 답변글 + 본인 질문(비밀글 포함) + 오늘 AI 사용량
//  GET  /api/qna?mine=1         본인이 올린 질문만
//  GET  /api/qna?admin=1        admin. 전체 (status=pending 필터 가능)
//  POST /api/qna                토큰. 질문 작성
//       body: { mode:'ai'|'teacher', isPrivate?:bool, title?:string, question:string, image?:dataURL }
//       - mode='ai'      : 하루 제한(기본 10개) 내에서 Gemini 즉시 답변 → status='answered'
//       - mode='teacher' : 선생님/조교 답변 대기 → status='pending'
//       - image          : "data:image/jpeg;base64,..." 형태(선택). 첨부 시 Gemini가 사진을 읽고 답변.
//                          사진만 올려도(질문 글 없이) 질문 가능. 사진은 image 컬럼에 저장돼 본인/관리자만 봄.
//  PATCH /api/qna?id=...        admin. 선생님/조교 답변 등록 { answer, answeredBy?('선생님'|'조교') }
//  DELETE /api/qna?id=...       본인 질문(또는 admin) 삭제
//
//  ⚙️ 환경변수: GEMINI_API_KEY(필수, AI 답변용) ·
//     GEMINI_MODEL(선택, 기본 gemini-2.5-flash) · QNA_AI_DAILY_LIMIT(선택, 기본 10)
// ───────────────────────────────────────────────────────────
import { requireStudentAccess } from './_auth.js';
import { sendPushToUsers } from './_push.js';

// 새 질문(선생님 답변 대기) 알림을 받을 관리자 푸시 userId 목록.
// 학생 userId는 휴대폰번호라 '__admin__'과 충돌하지 않음. admin-qna.html이 이 값으로 구독.
// (나중에 조교용 id를 배열에 추가하면 조교에게도 동시 발송됨)
const ADMIN_PUSH_USERS = ['__admin__'];

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_DAILY_LIMIT = 10;  // 6/23 3→5→10 상향(학생 수 적어 토큰 비용 영향 미미, 나중에 조정 가능)
const MAX_Q_LEN = 1200;     // 질문 글자 제한
const MAX_A_LEN = 20000;    // 저장 답변 글자 제한. 출력토큰 여유(maxOutputTokens-thinking≈1만토큰≈2만자)에 맞춤 —
                            // 모델이 끝까지 완성한 답(finishReason STOP)이 여기서 잘려 \boxed·LaTeX가 깨지지 않게.
const MAX_IMG_B64 = 2_600_000;  // 첨부 사진 base64 최대 길이(약 1.9MB 바이너리). 클라이언트가 리사이즈해 보내므로 보통 그 한참 아래.

// ── 토큰 사용량/비용 추정용 상수 (6/23 추가) ──
// Gemini 2.5 Flash 단가(2026-06 기준, USD per 1M tokens). 바뀌면 여기만 수정.
const PRICE_IN_PER_M = 0.30;   // 입력 토큰
const PRICE_OUT_PER_M = 2.50;  // 출력(+사고) 토큰
const USD_KRW = 1350;          // 환율 대략치(비용은 추정)
const DEFAULT_MONTHLY_TOKEN_BUDGET = 2_000_000; // 월 토큰 예산 기본값(참고용)
// 무료 등급은 돈이 아니라 '하루 요청수(RPD)'로 제한됨. 2.5 Flash 무료 일일 한도 대략치(프로젝트/시점마다 다름·AI Studio가 정답).
const DEFAULT_DAILY_REQUEST_LIMIT = 250;
// 하루 토큰 예산(soft budget) — 우리가 실제 쓴 토큰(정확히 집계됨) 대비 남은 토큰 표시용.
// 무료등급 실측 잔량은 API가 안 주므로(AI Studio가 정답) 이 값은 관우T가 설정하는 참고 예산이다.
const DEFAULT_DAILY_TOKEN_LIMIT = 1_000_000;

// 데이터URL("data:image/jpeg;base64,...") → { mimeType, data(base64), dataUrl } 또는 null
function parseImage(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/^data:(image\/(?:jpeg|jpg|png|webp|heic|heif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return null;
  let mimeType = m[1].toLowerCase();
  if (mimeType === 'image/jpg') mimeType = 'image/jpeg';
  const data = m[2].replace(/\s+/g, '');
  if (!data) return null;
  return { mimeType, data, dataUrl: 'data:' + mimeType + ';base64,' + data };
}

function jsonOk(data, status = 200) { return Response.json(data, { status }); }
function jsonErr(msg, status = 400)  { return Response.json({ error: msg }, { status }); }

async function ensureTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS qna (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'student_id INTEGER, author_phone TEXT, author_name TEXT, ' +
    'mode TEXT NOT NULL, is_private INTEGER DEFAULT 0, ' +
    'title TEXT, question TEXT NOT NULL, ' +
    'answer TEXT, answered_by TEXT, status TEXT NOT NULL, ' +
    'qdate TEXT, created_at TEXT, answered_at TEXT)'
  ).run();
  // 사진 첨부(6/23 추가) — 기존 테이블이면 컬럼만 추가. 이미 있으면 throw → 무시.
  try { await env.DB.prepare('ALTER TABLE qna ADD COLUMN image TEXT').run(); } catch (_) {}
  // 질문/문의 구분(kind) — 'question'(수학 질문) | 'inquiry'(학원·수업 문의). 기존 테이블이면 컬럼만 추가.
  try { await env.DB.prepare("ALTER TABLE qna ADD COLUMN kind TEXT DEFAULT 'question'").run(); } catch (_) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_qna_phone ON qna(author_phone)').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_qna_created ON qna(created_at)').run(); } catch (_) {}
  // 토큰 사용량(6/23 추가) — AI 답변 1건당 사용 토큰. 기존 테이블이면 컬럼만 추가.
  try { await env.DB.prepare('ALTER TABLE qna ADD COLUMN tokens_total INTEGER').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE qna ADD COLUMN tokens_in INTEGER').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE qna ADD COLUMN tokens_out INTEGER').run(); } catch (_) {}
  // 앱 설정(키-값) — 월 토큰 예산 등
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS qna_settings (key TEXT PRIMARY KEY, value TEXT)').run(); } catch (_) {}
}

// KST 기준 날짜 문자열 (일일 제한 카운트용 — UTC와 9시간 차이 보정)
function kstDateStr(d) {
  const base = d ? new Date(d) : new Date();
  const kst = new Date(base.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

// 이름 마스킹 (가운데 1글자 O) — 공개글에서 남의 이름 보호
function maskName(name) {
  const n = (name || '').toString().trim();
  if (!n) return '익명';
  if (n.length === 1) return n;
  if (n.length === 2) return n[0] + 'O';
  const mid = Math.floor(n.length / 2);
  return n.slice(0, mid) + 'O' + n.slice(mid + 1);
}

function rowOut(r, opts = {}) {
  const mine = opts.mine === true;
  const isAdmin = opts.isAdmin === true;
  const priv = r.is_private === 1 || r.is_private === true;
  // 공개 목록에서 남의 글이면 작성자 이름 마스킹 (본인/관리자는 실명)
  const showName = (mine || isAdmin) ? (r.author_name || '') : maskName(r.author_name);
  // 첨부 사진은 본인/관리자에게만 — 공개 피드에서 남의 사진은 노출 안 함
  const showImage = (mine || isAdmin) ? (r.image || '') : '';
  return {
    id: r.id,
    authorName: showName,
    mode: r.mode || 'teacher',
    kind: r.kind || 'question',
    isPrivate: priv,
    title: r.title || '',
    question: r.question || '',
    image: showImage,
    answer: r.answer || '',
    answeredBy: r.answered_by || '',
    status: r.status || 'pending',
    createdAt: r.created_at || '',
    answeredAt: r.answered_at || '',
    mine,
  };
}

// ── Gemini 호출 → 답변 텍스트(string) 또는 { error } ──
// image: { mimeType, data(base64) } 또는 null (선택). 있으면 멀티모달로 사진을 함께 보냄.
async function askGemini(env, question, studentMeta, image) {
  if (!env.GEMINI_API_KEY) return { error: 'AI 답변 기능이 아직 설정되지 않았어요. (관리자: GEMINI_API_KEY 등록 필요)' };
  const model = (env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  // 기본 호출 경로 = Cloudflare AI Gateway(kwmath) 경유 → google-ai-studio.
  // 이유: 구글 직통이면 Cloudflare가 차단지역 PoP에서 나가 "User location is not supported"가 뜸.
  //       게이트웨이를 거치면 지원 지역에서 나가 우회됨. (구글 API 키는 그대로 x-goog-api-key로 전달)
  // 되돌리려면 env GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com' (직통).
  const DEFAULT_BASE = 'https://gateway.ai.cloudflare.com/v1/8a4345aa80570af6f8c1d2b3e04eb638/kwmath/google-ai-studio';
  const base = (env.GEMINI_BASE_URL || DEFAULT_BASE).trim().replace(/\/+$/, '');
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const sys =
    '너는 "이관우 수학연구소"의 친절한 수학 조교 AI야. 한국 중·고등학생과 학부모의 수학 질문에 답한다.\n' +
    '아래 규칙을 반드시 지켜라.\n' +
    '\n' +
    '[교육과정 — 매우 중요]\n' +
    '1) 한국 고등학교 교육과정(고1 공통수학, 수학Ⅰ·수학Ⅱ, 미적분, 확률과 통계, 기하) 안의 개념·기법으로만 풀어라.\n' +
    '2) 교육과정 밖 도구는 절대 쓰지 마라. 특히 역삼각함수(arcsin, arccos, arctan, sin^{-1} 등)·로피탈 정리·테일러 전개·복소수 지수 표현·부호함수(sgn, signum, \\operatorname{sgn})는 금지.\n' +
    '3) 삼각방정식은 단위원·그래프·대칭성·주기로 설명해라. 예: sin x = k 의 해는 "sin α = k 를 만족하는 기준각 α"와 그 대칭각(π−α 등), 주기 2nπ 로 나타내라. "arcsin" 같은 표기 대신 "$\\sin\\alpha=k$ 인 각 $\\alpha$" 처럼 교육과정 표현을 써라.\n' +
    '3-1) $|x|$가 든 함수의 미분은 sgn을 쓰지 말고 $x>0$·$x<0$ 두 경우로 나눠 설명해라. 예: $y=f(|x|+t)$이면 "$x>0$일 때 $y\'=f\'(x+t)$, $x<0$일 때 $y\'=-f\'(-x+t)$" 처럼 서술해라.\n' +
    '\n' +
    '[수식 표기 — LaTeX]\n' +
    '4) 모든 수식은 LaTeX로 써라. 문장 속 수식은 $...$ 로, 따로 보여줄 핵심 수식은 줄을 바꿔 $$...$$ 로 감싸라.\n' +
    '5) 분수는 \\frac{a}{b}, 거듭제곱은 x^{2}, 첨자는 x_{1}, 근호는 \\sqrt{2}, 그리스문자는 \\pi,\\alpha,\\theta, 부등호는 \\le,\\ge, 곱은 \\times 처럼 표준 LaTeX 명령을 써라. (예: $\\sin x=-\\frac{1}{2}$)\n' +
    '\n' +
    '[풀이 형식]\n' +
    '6) 단계별로 줄을 바꿔 써라. 각 단계는 새 줄에서 시작하고, 단계 사이에는 빈 줄을 한 줄 넣어 읽기 쉽게 해라.\n' +
    '7) 생각(사고 과정)은 전부 머릿속(내부 사고)에서 끝내라. 최종 답변에는 되돌이·자기수정·"만약 …이면/아니면" 식 경우 나열·시행착오·검산 과정을 절대 쓰지 마라. 여러 경우를 따져야 하는 문제라도, 내부에서 다 따진 뒤 답변에는 정답으로 이어지는 하나의 깔끔한 풀이 흐름만 남겨라.\n' +
    '8) 답변은 짧고 콤팩트하게. 목표는 핵심 단계 5~10줄 안팎이다. 웬만한 문제는 그 안에 끝난다. 사소한 대입·계산은 결과만 적고 과정을 장황하게 늘어놓지 마라.\n' +
    '8-1) 후보(정수·경우 등)를 하나씩 전부 대입해 보는 방식은 절대 쓰지 마라. 대신 조건(부등식 범위·완전제곱수·판별식·근과 계수의 관계·정수 조건 등)으로 후보를 먼저 좁힌 뒤, 남은 소수의 경우만 확인해라. 예: "정수근 조건 → $-c$가 완전제곱수 → $c\\in\\{0,-1,-4\\}$" 처럼 한 번에 좁혀라. $c=-8,-7,\\dots$ 를 하나씩 나열하는 답은 틀린 형식이다.\n' +
    '9) 마지막 줄에는 반드시 $$\\boxed{최종답}$$ 형태로 최종 답을 분명히 적어 끝맺어라. 절대 중간에서 끊지 말고 답까지 완성해라.\n' +
    '10) 따뜻하고 격려하는 말투를 유지하되 인사·서론은 한 줄 이내로 짧게 해라.\n' +
    '\n' +
    '[기타]\n' +
    '11) 수학·학습과 무관하거나 부적절한 질문이면 정중히 거절하고 수학 질문을 부탁해라. 확실하지 않으면 솔직히 말하고 선생님(관우T)·조교에게 다시 질문하도록 권해라.\n' +
    '12) 사진이 첨부되면 사진 속 문제·풀이·그래프를 꼼꼼히 읽고, 먼저 문제를 한 줄로 다시 정리해 학생이 같은 문제인지 확인하게 한 뒤 풀이해라. 사진이 흐리거나 일부만 보이면 보이는 범위에서 최선을 다하되, 안 보이는 부분은 다시 또렷하게 찍어 달라고 정중히 안내해라.';

  // 사진(있으면)을 먼저, 그다음 질문 텍스트. 사진만 있고 글이 없으면 기본 지시문 사용.
  const userParts = [];
  if (image && image.data) userParts.push({ inlineData: { mimeType: image.mimeType || 'image/jpeg', data: image.data } });
  const qtext = String(question || '').slice(0, MAX_Q_LEN);
  userParts.push({ text: qtext || '첨부한 사진 속 수학 문제를 읽고 풀이해 주세요.' });

  const body = {
    systemInstruction: { parts: [{ text: sys }] },
    contents: [{ role: 'user', parts: userParts }],
    // 7/9: 사고예산이 2048로 작아 모델이 어려운 문제를 '답변 본문'에서 경우 나열로 헤매다
    //      8000자 캡에 걸려 LaTeX 중간에 잘리던 문제 수정. 사고예산을 넉넉히(10240) 줘서
    //      경우 따지기는 전부 '내부 사고'에서 끝내게 하고, 출력 상한도 20480으로 올려
    //      (사고 빼고도 ~1만 토큰 가용) 정상 답변(짧고 콤팩트)이 끝까지 완성되게 함.
    generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 20480, thinkingConfig: { thinkingBudget: 10240 } },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
  };

  // 과부하(429/503 · "high demand") 시 짧게 재시도 — Gemini가 일시적으로 몰릴 때
  const RETRY_WAITS = [800, 1600]; // ms, 최대 2회 추가 시도
  const isOverload = (status, msg) =>
    status === 429 || status === 503 || status === 500 ||
    /high demand|overloaded|unavailable|resource_exhausted/i.test(msg || '');
  let lastMsg = '';
  for (let attempt = 0; attempt <= RETRY_WAITS.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        if (data && data.promptFeedback && data.promptFeedback.blockReason) {
          return { error: '질문이 안전 정책에 걸려 답변할 수 없어요. 수학 질문으로 다시 작성해 주세요.' };
        }
        const cand = data && data.candidates && data.candidates[0];
        const parts = cand && cand.content && cand.content.parts;
        let text = (parts || []).map(p => p && p.text ? p.text : '').join('').trim();
        if (!text) return { error: 'AI가 답변을 만들지 못했어요. 잠시 후 다시 시도하거나 선생님께 질문해 주세요.' };
        // 출력 한도 등으로 답이 끝까지 안 나왔으면(finishReason이 STOP이 아님) 잘린 답을 저장하지 않는다.
        // → error로 돌려 '선생님 대기글'로 보존(횟수 차감 X). 중간에 잘린 LaTeX가 학생 화면을 깨뜨리는 것 방지.
        const fr = cand && cand.finishReason;
        if (fr && fr !== 'STOP' && fr !== 'FINISH_REASON_UNSPECIFIED') {
          return { error: '문제가 복잡해 AI 답변이 끝까지 완성되지 못했어요.' };
        }
        // 안전망: 혹시 $ 개수가 홀수(수식이 안 닫힘)면 렌더가 깨지지 않게 하나 닫아준다.
        if (((text.match(/\$/g) || []).length % 2) === 1) text += '$';
        // 사용 토큰 집계용 — usageMetadata(있으면). 사고 토큰은 출력 단가로 청구되므로 out에 합산.
        const um = (data && data.usageMetadata) || {};
        const tIn = Number(um.promptTokenCount) || 0;
        const tOut = (Number(um.candidatesTokenCount) || 0) + (Number(um.thoughtsTokenCount) || 0);
        const tTotal = Number(um.totalTokenCount) || (tIn + tOut);
        return { text: text.slice(0, MAX_A_LEN), usage: { in: tIn, out: tOut, total: tTotal } };
      }
      lastMsg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      if (isOverload(res.status, lastMsg) && attempt < RETRY_WAITS.length) {
        await new Promise(r => setTimeout(r, RETRY_WAITS[attempt]));
        continue;
      }
      if (isOverload(res.status, lastMsg)) {
        return { error: '지금 AI 사용이 몰려 답변이 잠시 어려워요. 1~2분 뒤 다시 시도해 주세요.' };
      }
      // 지역 차단(Cloudflare가 미지원 지역 PoP에서 호출) — 학생에겐 깔끔한 한글로, 영어 원문 노출 안 함
      if (/user location is not supported/i.test(lastMsg)) {
        return { error: '지금 AI 답변이 어려워요.' };
      }
      return { error: 'AI 답변 생성 실패: ' + lastMsg };
    } catch (e) {
      lastMsg = (e && e.message) || '통신 오류';
      if (attempt < RETRY_WAITS.length) {
        await new Promise(r => setTimeout(r, RETRY_WAITS[attempt]));
        continue;
      }
      return { error: 'AI 서버 통신 오류. 잠시 후 다시 시도해 주세요.' };
    }
  }
  return { error: '지금 AI 사용이 몰려 답변이 잠시 어려워요. 1~2분 뒤 다시 시도해 주세요.' };
}

// ── 새 질문(선생님 답변 대기)이 생기면 관리자에게 푸시 알림 (best-effort, 절대 throw 안 함) ──
//   비밀글은 내용 미리보기를 빼고 이름만. AI 자동답변(answered)은 알림 안 함.
function notifyAdminNewQuestion(context, env, q) {
  try {
    const who = (q.authorName || '학생').toString().slice(0, 20);
    const isInquiry = (q.kind === 'inquiry');
    let detail;
    if (q.isPrivate && !isInquiry) {
      detail = '🔒 비밀 질문이 등록됐어요';
    } else {
      const t = (q.title || '').toString().trim();
      const qbody = (q.question && q.question !== '[사진으로 질문]') ? q.question.toString().trim() : '';
      const preview = t || qbody || (q.hasImage ? '사진 질문' : (isInquiry ? '새 문의' : '새 질문'));
      detail = preview.slice(0, 50);
    }
    const p = sendPushToUsers(env, ADMIN_PUSH_USERS, {
      title: isInquiry ? '📩 새 문의가 등록됐어요' : '💬 새 질문이 등록됐어요',
      body: who + (isInquiry ? ' · ' : ' 학생 · ') + detail,
      url: '/admin-qna.html',
      tag: isInquiry ? 'kwmath-inquiry-new' : 'kwmath-qna-new',
    });
    if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
    else if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* best-effort */ }
}

// 🔔 D4: 일일 AI 토큰 사용량이 한도(daily_token_limit, 기본 100만)의 80% 도달 시 관리자 푸시.
// 멱등: qna_settings.token_alert_date 에 오늘(KST) 날짜 기록 — 하루 1회만 발송.
// 하드 차단 아님(요청은 계속 허용) — 관우T 결정(2026-07-10).
async function checkTokenBudgetAlert(env) {
  const today = kstDateStr();
  const tRow = await env.DB.prepare("SELECT value FROM qna_settings WHERE key='daily_token_limit'").first();
  const dailyTokenLimit = (tRow && tRow.value != null && tRow.value !== '')
    ? Math.max(0, parseInt(tRow.value, 10) || 0) : DEFAULT_DAILY_TOKEN_LIMIT;
  if (!dailyTokenLimit) return;  // 0 = 한도 없음 → 알림도 없음
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(tokens_total),0) AS tok FROM qna WHERE mode='ai' AND tokens_total IS NOT NULL AND qdate=?"
  ).bind(today).first();
  const usedTok = Number(row && row.tok) || 0;
  if (usedTok < dailyTokenLimit * 0.8) return;
  const sent = await env.DB.prepare("SELECT value FROM qna_settings WHERE key='token_alert_date'").first();
  if (sent && sent.value === today) return;  // 오늘 이미 발송함
  await env.DB.prepare(
    "INSERT INTO qna_settings (key, value) VALUES ('token_alert_date', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(today).run();
  const pct = Math.min(999, Math.round((usedTok / dailyTokenLimit) * 100));
  await sendPushToUsers(env, ADMIN_PUSH_USERS, {
    title: '🔔 질문방 AI 토큰 ' + pct + '% 소진',
    body: '오늘 사용 ' + usedTok.toLocaleString('en-US') + ' / 한도 ' + dailyTokenLimit.toLocaleString('en-US') + ' 토큰',
    url: '/admin-qna.html',
    tag: 'kwmath-token-budget',
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  const dailyLimit = Math.max(1, parseInt(env.QNA_AI_DAILY_LIMIT, 10) || DEFAULT_DAILY_LIMIT);

  try { await ensureTable(env); }
  catch (e) { return jsonErr('질문방 DB 초기화에 실패했습니다.', 500); }

  // 오늘 AI 사용 횟수
  async function aiUsedToday(phone) {
    const today = kstDateStr();
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM qna WHERE author_phone=? AND mode='ai' AND qdate=?"
    ).bind(phone, today).first();
    return row ? Number(row.c) || 0 : 0;
  }

  try {
    // ─────────────────────────── GET ───────────────────────────
    if (method === 'GET') {
      // 관리자 — AI 토큰 사용량 집계 (오늘/이번달/누적 + 월예산 대비)
      if (url.searchParams.get('usage') === '1') {
        if (!isAdmin) return jsonErr('관리자 인증이 필요합니다.', 401);
        const today = kstDateStr();
        const month = today.slice(0, 7);   // YYYY-MM (KST)
        const todayRow = await env.DB.prepare(
          "SELECT COUNT(*) AS q, COALESCE(SUM(tokens_total),0) AS tok " +
          "FROM qna WHERE mode='ai' AND tokens_total IS NOT NULL AND qdate=?"
        ).bind(today).first();
        const monthRow = await env.DB.prepare(
          "SELECT COUNT(*) AS q, COALESCE(SUM(tokens_total),0) AS tok, COALESCE(SUM(tokens_in),0) AS tin, COALESCE(SUM(tokens_out),0) AS tout " +
          "FROM qna WHERE mode='ai' AND tokens_total IS NOT NULL AND substr(qdate,1,7)=?"
        ).bind(month).first();
        const totalRow = await env.DB.prepare(
          "SELECT COUNT(*) AS q, COALESCE(SUM(tokens_total),0) AS tok, COALESCE(SUM(tokens_in),0) AS tin, COALESCE(SUM(tokens_out),0) AS tout " +
          "FROM qna WHERE mode='ai' AND tokens_total IS NOT NULL"
        ).first();
        // 무료 등급은 돈이 아니라 '하루 요청수(RPD)'로 제한 — 일일 한도(설정값, 기본 250) 대비 오늘 사용량.
        const lRow = await env.DB.prepare("SELECT value FROM qna_settings WHERE key='daily_request_limit'").first();
        const dailyRequestLimit = (lRow && lRow.value != null && lRow.value !== '')
          ? Math.max(0, parseInt(lRow.value, 10) || 0) : DEFAULT_DAILY_REQUEST_LIMIT;
        // 하루 토큰 예산(참고용 soft budget) — 우리가 실제 쓴 토큰은 정확히 집계됨. 무료등급 실측 잔량은 API가 안 줌(AI Studio가 정답).
        const tRow = await env.DB.prepare("SELECT value FROM qna_settings WHERE key='daily_token_limit'").first();
        const dailyTokenLimit = (tRow && tRow.value != null && tRow.value !== '')
          ? Math.max(0, parseInt(tRow.value, 10) || 0) : DEFAULT_DAILY_TOKEN_LIMIT;
        const num = (v) => Number(v) || 0;
        const usdCost = (tin, tout) => (num(tin) / 1e6) * PRICE_IN_PER_M + (num(tout) / 1e6) * PRICE_OUT_PER_M;
        const totQ = num(totalRow && totalRow.q);
        const avgTok = totQ > 0 ? Math.round(num(totalRow.tok) / totQ) : 0;
        const avgUsd = totQ > 0 ? usdCost(totalRow.tin, totalRow.tout) / totQ : 0;
        const avgKrw = Math.round(avgUsd * USD_KRW);
        const todayQ = num(todayRow && todayRow.q);
        const remTodayReq = Math.max(0, dailyRequestLimit - todayQ);
        const monthUsd = usdCost(monthRow && monthRow.tin, monthRow && monthRow.tout);
        return jsonOk({
          ok: true,
          tier: 'free',  // 현재 무료 등급(실제 청구 ₩0). 비용 값은 '유료 전환 시 예상'.
          today: { questions: todayQ, tokens: num(todayRow && todayRow.tok) },
          month: {
            questions: num(monthRow && monthRow.q), tokens: num(monthRow && monthRow.tok),
            tokensIn: num(monthRow && monthRow.tin), tokensOut: num(monthRow && monthRow.tout),
            costKrw: Math.round(monthUsd * USD_KRW), costUsd: Number(monthUsd.toFixed(4)),
          },
          total: { questions: totQ, tokens: num(totalRow && totalRow.tok) },
          avgTokensPerQuestion: avgTok,
          avgCostKrwPerQuestion: avgKrw,
          avgCostUsdPerQuestion: Number(avgUsd.toFixed(5)),
          dailyRequestLimit,
          remainingTodayRequests: remTodayReq,
          dailyTokenLimit,
          remainingTodayTokens: Math.max(0, dailyTokenLimit - num(todayRow && todayRow.tok)),
          pricing: { inPerMillionUsd: PRICE_IN_PER_M, outPerMillionUsd: PRICE_OUT_PER_M, usdKrw: USD_KRW },
        });
      }

      // admin 전체
      if (url.searchParams.get('admin') === '1') {
        if (!isAdmin) return jsonErr('관리자 인증이 필요합니다.', 401);
        const onlyPending = url.searchParams.get('status') === 'pending';
        const sql = onlyPending
          ? "SELECT * FROM qna WHERE status='pending' ORDER BY created_at DESC, id DESC"
          : 'SELECT * FROM qna ORDER BY created_at DESC, id DESC';
        const { results } = await env.DB.prepare(sql).all();
        const list = (results || []).map(r => rowOut(r, { isAdmin: true }));
        const pending = (results || []).filter(r => r.status === 'pending').length;
        return jsonOk({ ok: true, questions: list, pendingCount: pending });
      }

      // 학생/학부모 — 토큰 필요
      const access = await requireStudentAccess(env, request);
      if (!access.ok) return access.response;
      const phone = access.phone;

      const used = await aiUsedToday(phone);
      const remaining = Math.max(0, dailyLimit - used);

      if (url.searchParams.get('mine') === '1') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM qna WHERE author_phone=? ORDER BY created_at DESC, id DESC'
        ).bind(phone).all();
        const list = (results || []).map(r => rowOut(r, { mine: true }));
        return jsonOk({ ok: true, questions: list, aiUsedToday: used, aiRemaining: remaining, aiDailyLimit: dailyLimit });
      }

      // 기본: 공개글(비밀글 아님) + 본인 글(비밀글 포함)
      const { results } = await env.DB.prepare(
        'SELECT * FROM qna WHERE is_private=0 OR author_phone=? ORDER BY created_at DESC, id DESC'
      ).bind(phone).all();
      const list = (results || []).map(r => rowOut(r, { mine: r.author_phone === phone }));
      return jsonOk({ ok: true, questions: list, aiUsedToday: used, aiRemaining: remaining, aiDailyLimit: dailyLimit });
    }

    // ─────────────────────────── POST (질문 작성) ───────────────────────────
    if (method === 'POST') {
      // 관리자 — 무료 일일 요청 한도 저장 (질문 작성 흐름보다 먼저 분기)
      if (url.searchParams.get('usage') === '1') {
        if (!isAdmin) return jsonErr('관리자 인증이 필요합니다.', 401);
        const sb = await request.json().catch(() => ({}));
        const out = {};
        if (sb.dailyRequestLimit != null) {
          const val = Math.max(0, parseInt(sb.dailyRequestLimit, 10) || 0);
          await env.DB.prepare(
            "INSERT INTO qna_settings (key, value) VALUES ('daily_request_limit', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
          ).bind(String(val)).run();
          out.dailyRequestLimit = val;
        }
        if (sb.dailyTokenLimit != null) {
          const tval = Math.max(0, parseInt(sb.dailyTokenLimit, 10) || 0);
          await env.DB.prepare(
            "INSERT INTO qna_settings (key, value) VALUES ('daily_token_limit', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
          ).bind(String(tval)).run();
          out.dailyTokenLimit = tval;
        }
        return jsonOk({ ok: true, ...out });
      }

      const access = await requireStudentAccess(env, request);
      if (!access.ok) return access.response;
      const phone = access.phone;
      const student = access.student || {};

      const body = await request.json().catch(() => ({}));
      const kind = (body.kind === 'inquiry') ? 'inquiry' : 'question';
      let mode = (body.mode === 'ai') ? 'ai' : 'teacher';
      if (kind === 'inquiry') mode = 'teacher';                 // 문의는 AI 없이 항상 선생님/관우T가 답변
      let isPrivate = body.isPrivate === true || body.isPrivate === 1 ? 1 : 0;
      if (kind === 'inquiry') isPrivate = 1;                     // 문의는 비공개(본인·관리자만 열람)
      const title = (body.title || '').toString().trim().slice(0, 80);
      const question = (body.question || '').toString().trim();

      // 첨부 사진(선택) — data URL 파싱·용량 검증
      const image = parseImage(body.image);
      if (body.image && !image) return jsonErr('사진 형식을 인식하지 못했어요. (JPG·PNG만 가능)');
      if (image && image.data.length > MAX_IMG_B64) return jsonErr('사진 용량이 너무 커요. 잠시 후 다시 시도해 주세요.');

      // 사진이 있으면 글이 짧거나 없어도 허용. 둘 다 없으면 거절.
      if (!question && !image) return jsonErr('질문 내용을 입력하거나 사진을 올려주세요.');
      if (!image && question.length < 4) return jsonErr('질문을 조금 더 자세히 적어주세요. (4자 이상)');
      if (question.length > MAX_Q_LEN) return jsonErr(`질문은 ${MAX_Q_LEN}자 이하로 작성해주세요.`);

      const storedQuestion = question || '[사진으로 질문]';
      const imageToStore = image ? image.dataUrl : null;
      const authorName = student.name || '학생';
      const now = new Date().toISOString();
      const today = kstDateStr();

      // ── AI 모드: 일일 제한 체크 → Gemini 호출 ──
      if (mode === 'ai') {
        const used = await aiUsedToday(phone);
        if (used >= dailyLimit) {
          return jsonErr(`오늘은 AI 질문을 ${dailyLimit}개까지 사용했어요. 내일 다시 이용하거나, 선생님에게 질문해 주세요.`, 429);
        }
        const ai = await askGemini(env, question, student, image);
        if (ai.error) {
          // AI 실패 시 질문이 사라지지 않게 — 선생님 대기글로 저장(횟수 차감 안 함). 사진도 함께 보존.
          const res = await env.DB.prepare(
            'INSERT INTO qna (student_id, author_phone, author_name, mode, is_private, title, question, image, answer, answered_by, status, qdate, created_at, answered_at) ' +
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
          ).bind(student.id || null, phone, authorName, 'teacher', isPrivate, title, storedQuestion, imageToStore, null, null, 'pending', today, now, null).run();
          notifyAdminNewQuestion(context, env, { authorName, title, question: storedQuestion, isPrivate, hasImage: !!imageToStore });
          return jsonOk({
            ok: true, id: res.meta && res.meta.last_row_id, mode: 'teacher', status: 'pending',
            aiFailed: true, message: ai.error + ' 대신 선생님께 질문이 전달됐어요.',
            aiRemaining: Math.max(0, dailyLimit - used),
          }, 200);
        }
        const u = ai.usage || { in: null, out: null, total: null };
        const res = await env.DB.prepare(
          'INSERT INTO qna (student_id, author_phone, author_name, mode, is_private, title, question, image, answer, answered_by, status, qdate, created_at, answered_at, tokens_total, tokens_in, tokens_out) ' +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        ).bind(student.id || null, phone, authorName, 'ai', isPrivate, title, storedQuestion, imageToStore, ai.text, 'AI', 'answered', today, now, now, u.total, u.in, u.out).run();
        // 토큰 80% 경고 체크 (응답 지연 없이 백그라운드)
        const budgetP = checkTokenBudgetAlert(env).catch(() => {});
        if (context && typeof context.waitUntil === 'function') context.waitUntil(budgetP);
        const usedAfter = used + 1;
        return jsonOk({
          ok: true, id: res.meta && res.meta.last_row_id, mode: 'ai', status: 'answered',
          answer: ai.text, answeredBy: 'AI',
          aiUsedToday: usedAfter, aiRemaining: Math.max(0, dailyLimit - usedAfter), aiDailyLimit: dailyLimit,
        });
      }

      // ── 선생님/조교 모드(질문) · 문의 모드: 대기글 저장 (사진 첨부 포함) ──
      const res = await env.DB.prepare(
        'INSERT INTO qna (student_id, author_phone, author_name, mode, kind, is_private, title, question, image, answer, answered_by, status, qdate, created_at, answered_at) ' +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(student.id || null, phone, authorName, 'teacher', kind, isPrivate, title, storedQuestion, imageToStore, null, null, 'pending', today, now, null).run();
      notifyAdminNewQuestion(context, env, { authorName, title, question: storedQuestion, isPrivate, hasImage: !!imageToStore, kind });
      return jsonOk({ ok: true, id: res.meta && res.meta.last_row_id, mode: 'teacher', kind, status: 'pending' });
    }

    // ─────────────────────────── PATCH (관리자 답변) ───────────────────────────
    if (method === 'PATCH') {
      if (!isAdmin) return jsonErr('관리자 인증이 필요합니다.', 401);
      const id = url.searchParams.get('id');
      if (!id) return jsonErr('id가 필요합니다.');
      const body = await request.json().catch(() => ({}));
      const answer = (body.answer || '').toString().trim();
      if (!answer) return jsonErr('답변 내용을 입력해주세요.');
      if (answer.length > MAX_A_LEN) return jsonErr(`답변은 ${MAX_A_LEN}자 이하로 작성해주세요.`);
      const answeredBy = (body.answeredBy === '조교') ? '조교' : '선생님';

      const ex = await env.DB.prepare('SELECT id FROM qna WHERE id=?').bind(id).first();
      if (!ex) return jsonErr('질문을 찾을 수 없습니다.', 404);

      await env.DB.prepare(
        "UPDATE qna SET answer=?, answered_by=?, status='answered', answered_at=? WHERE id=?"
      ).bind(answer, answeredBy, new Date().toISOString(), id).run();
      return jsonOk({ ok: true, id, status: 'answered', answeredBy });
    }

    // ─────────────────────────── DELETE ───────────────────────────
    if (method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return jsonErr('id가 필요합니다.');

      const row = await env.DB.prepare('SELECT author_phone FROM qna WHERE id=?').bind(id).first();
      if (!row) return jsonOk({ ok: true, removed: 0 });

      if (!isAdmin) {
        const access = await requireStudentAccess(env, request);
        if (!access.ok) return access.response;
        if (row.author_phone !== access.phone) return jsonErr('본인이 작성한 질문만 삭제할 수 있습니다.', 403);
      }
      await env.DB.prepare('DELETE FROM qna WHERE id=?').bind(id).run();
      return jsonOk({ ok: true, removed: 1 });
    }

    return jsonErr('지원하지 않는 메소드입니다.', 405);
  } catch (e) {
    return jsonErr('질문방 처리 중 오류가 발생했습니다.', 500);
  }
}
