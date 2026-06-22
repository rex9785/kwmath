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
//       - mode='ai'      : 하루 제한(기본 5개) 내에서 Gemini 즉시 답변 → status='answered'
//       - mode='teacher' : 선생님/조교 답변 대기 → status='pending'
//       - image          : "data:image/jpeg;base64,..." 형태(선택). 첨부 시 Gemini가 사진을 읽고 답변.
//                          사진만 올려도(질문 글 없이) 질문 가능. 사진은 image 컬럼에 저장돼 본인/관리자만 봄.
//  PATCH /api/qna?id=...        admin. 선생님/조교 답변 등록 { answer, answeredBy?('선생님'|'조교') }
//  DELETE /api/qna?id=...       본인 질문(또는 admin) 삭제
//
//  ⚙️ 환경변수: GEMINI_API_KEY(필수, AI 답변용) ·
//     GEMINI_MODEL(선택, 기본 gemini-2.5-flash) · QNA_AI_DAILY_LIMIT(선택, 기본 5)
// ───────────────────────────────────────────────────────────
import { requireStudentAccess } from './_auth.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_DAILY_LIMIT = 5;   // 6/23 3→5 상향(학생 수 적어 토큰 비용 영향 미미)
const MAX_Q_LEN = 1200;     // 질문 글자 제한
const MAX_A_LEN = 8000;     // 저장 답변 글자 제한
const MAX_IMG_B64 = 2_600_000;  // 첨부 사진 base64 최대 길이(약 1.9MB 바이너리). 클라이언트가 리사이즈해 보내므로 보통 그 한참 아래.

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
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_qna_phone ON qna(author_phone)').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_qna_created ON qna(created_at)').run(); } catch (_) {}
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const sys =
    '너는 "이관우 수학연구소"의 친절한 수학 조교 AI야. 중·고등학생과 학부모의 수학 질문에 답한다.\n' +
    '규칙:\n' +
    '1) 한국어로, 학생이 이해하기 쉽게 단계별로 풀이해라. 핵심 개념을 먼저 짚고, 풀이 과정을 차근차근 보여줘라.\n' +
    '2) 수식은 일반 텍스트로 또박또박 써라(예: x^2, √2, 1/2, ≤, ≥, π). 너무 복잡한 LaTeX는 피한다.\n' +
    '3) 답만 던지지 말고 "왜 그런지" 이유와 풀이 흐름을 설명해라. 마지막에 한 줄로 정답/핵심을 정리해라.\n' +
    '4) 수학·학습과 무관하거나 부적절한 질문이면 정중히 거절하고, 수학 질문을 부탁한다고 안내해라.\n' +
    '5) 확실하지 않으면 솔직히 말하고, 선생님(관우T)이나 조교에게 다시 질문하도록 권해라.\n' +
    '6) 답변은 핵심에 집중해 너무 길지 않게(보통 500자 이내, 필요시 더). 따뜻하고 격려하는 말투.\n' +
    '7) 사진이 첨부되면 사진 속 문제·풀이·그래프를 꼼꼼히 읽고 그 내용을 바탕으로 답해라. 먼저 문제를 한 줄로 다시 정리해 학생이 같은 문제인지 확인하게 한 뒤 풀이해라. 사진이 흐리거나 일부만 보이면 보이는 범위에서 최선을 다하되, 안 보이는 부분은 다시 또렷하게 찍어 달라고 정중히 안내해라.';

  // 사진(있으면)을 먼저, 그다음 질문 텍스트. 사진만 있고 글이 없으면 기본 지시문 사용.
  const userParts = [];
  if (image && image.data) userParts.push({ inlineData: { mimeType: image.mimeType || 'image/jpeg', data: image.data } });
  const qtext = String(question || '').slice(0, MAX_Q_LEN);
  userParts.push({ text: qtext || '첨부한 사진 속 수학 문제를 읽고 풀이해 주세요.' });

  const body = {
    systemInstruction: { parts: [{ text: sys }] },
    contents: [{ role: 'user', parts: userParts }],
    // 6/23: 2.5 Flash는 '사고(thinking)' 토큰이 maxOutputTokens에서 같이 차감됨.
    // 기존 1200이면 어려운 문제에서 사고가 예산을 다 먹어 답이 잘리거나 빈 응답이 됨.
    // → 사고예산(2048)을 명시 + 출력상한을 4096으로 올려 풀이가 안 잘리게 함.
    generationConfig: { temperature: 0.3, topP: 0.9, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 2048 } },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const m = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      return { error: 'AI 답변 생성 실패: ' + m };
    }
    if (data && data.promptFeedback && data.promptFeedback.blockReason) {
      return { error: '질문이 안전 정책에 걸려 답변할 수 없어요. 수학 질문으로 다시 작성해 주세요.' };
    }
    const cand = data && data.candidates && data.candidates[0];
    const parts = cand && cand.content && cand.content.parts;
    const text = (parts || []).map(p => p && p.text ? p.text : '').join('').trim();
    if (!text) return { error: 'AI가 답변을 만들지 못했어요. 잠시 후 다시 시도하거나 선생님께 질문해 주세요.' };
    return { text: text.slice(0, MAX_A_LEN) };
  } catch (e) {
    return { error: 'AI 서버 통신 오류. 잠시 후 다시 시도해 주세요.' };
  }
}

export async function onRequest({ request, env }) {
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
      const access = await requireStudentAccess(env, request);
      if (!access.ok) return access.response;
      const phone = access.phone;
      const student = access.student || {};

      const body = await request.json().catch(() => ({}));
      const mode = (body.mode === 'ai') ? 'ai' : 'teacher';
      const isPrivate = body.isPrivate === true || body.isPrivate === 1 ? 1 : 0;
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
          return jsonOk({
            ok: true, id: res.meta && res.meta.last_row_id, mode: 'teacher', status: 'pending',
            aiFailed: true, message: ai.error + ' 대신 선생님께 질문이 전달됐어요.',
            aiRemaining: Math.max(0, dailyLimit - used),
          }, 200);
        }
        const res = await env.DB.prepare(
          'INSERT INTO qna (student_id, author_phone, author_name, mode, is_private, title, question, image, answer, answered_by, status, qdate, created_at, answered_at) ' +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        ).bind(student.id || null, phone, authorName, 'ai', isPrivate, title, storedQuestion, imageToStore, ai.text, 'AI', 'answered', today, now, now).run();
        const usedAfter = used + 1;
        return jsonOk({
          ok: true, id: res.meta && res.meta.last_row_id, mode: 'ai', status: 'answered',
          answer: ai.text, answeredBy: 'AI',
          aiUsedToday: usedAfter, aiRemaining: Math.max(0, dailyLimit - usedAfter), aiDailyLimit: dailyLimit,
        });
      }

      // ── 선생님/조교 모드: 대기글 저장 (사진 첨부 포함) ──
      const res = await env.DB.prepare(
        'INSERT INTO qna (student_id, author_phone, author_name, mode, is_private, title, question, image, answer, answered_by, status, qdate, created_at, answered_at) ' +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(student.id || null, phone, authorName, 'teacher', isPrivate, title, storedQuestion, imageToStore, null, null, 'pending', today, now, null).run();
      return jsonOk({ ok: true, id: res.meta && res.meta.last_row_id, mode: 'teacher', status: 'pending' });
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
