// /api/scores  — 시험 성적 (수학) : 원점수 + 등급
// ───────────────────────────────────────────────────────────
// D1 table: exam_scores (없으면 자동 생성). 학생 식별 = student_id.
// 인증: admin(Bearer ADMIN_PASSWORD) = 모든 학생 / 학생·학부모(토큰) = 본인·자녀만
//
//  GET    ?name=홍길동                  → 그 학생 성적 목록(시간순)
//  POST   { name?, id?, examType, gradeLevel?, label, sortKey?, rawScore?, grade?, examDate?, memo? }
//                                        → 추가 (id 있으면 수정). 학생은 본인만(?name 쿼리로 자녀 선택).
//  DELETE { id }  (+ ?name=)            → 삭제. 학생은 본인 것만.
//
//  examType: '내신' | '모의'   rawScore: 0~100(정수)   grade: 1~9(정수)
//  sortKey : 시간순 정렬용 문자열(프론트가 생성, 예 '2026-1-1' = 고1·1학기·중간). 없으면 id순.
// ───────────────────────────────────────────────────────────
import { requireStudentAccess } from './_auth.js';
import { getStudentByName } from './_db.js';

async function ensureTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS exam_scores (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, ' +
    'exam_type TEXT NOT NULL, grade_level TEXT, label TEXT NOT NULL, sort_key TEXT, ' +
    'raw_score INTEGER, grade INTEGER, exam_date TEXT, memo TEXT, ' +
    'created_at TEXT, updated_at TEXT)'
  ).run();
  try {
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_exam_scores_student ON exam_scores(student_id)').run();
  } catch (_) { /* 비치명적 */ }
}

function rowOut(r) {
  return {
    id: r.id,
    examType: r.exam_type || '',
    gradeLevel: r.grade_level || '',
    label: r.label || '',
    sortKey: r.sort_key || '',
    rawScore: (r.raw_score === null || r.raw_score === undefined) ? null : r.raw_score,
    grade: (r.grade === null || r.grade === undefined) ? null : r.grade,
    examDate: r.exam_date || '',
    memo: r.memo || '',
    createdAt: r.created_at || '',
  };
}

function intOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

async function listForStudent(env, studentId) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM exam_scores WHERE student_id=? ORDER BY (sort_key IS NULL OR sort_key=\'\'), sort_key ASC, id ASC'
  ).bind(studentId).all();
  return (results || []).map(rowOut);
}

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  const url = new URL(request.url);

  try { await ensureTable(env); }
  catch (e) { return Response.json({ error: '성적 DB 초기화에 실패했습니다.' }, { status: 500 }); }

  // 요청자 → student_id 매핑 (admin: ?name/body.name으로 지정 / 학생: 토큰으로 본인·자녀)
  async function resolveStudent(bodyName) {
    if (isAdmin) {
      const name = (bodyName || url.searchParams.get('name') || '').trim();
      if (!name) return { error: 'name 필수', status: 400 };
      const st = await getStudentByName(env, name);
      if (!st) return { error: '학생을 D1에서 찾을 수 없습니다.', status: 404 };
      return { id: st.id, name: st.name };
    }
    const access = await requireStudentAccess(env, request); // ?name= 쿼리로 자녀 선택 + 권한 검증
    if (!access.ok) return { response: access.response };
    return { id: access.student.id, name: access.student.name };
  }

  // ── GET: 목록 ──
  if (request.method === 'GET') {
    const r = await resolveStudent(null);
    if (r.response) return r.response;
    if (r.error) return Response.json({ error: r.error }, { status: r.status });
    try {
      const scores = await listForStudent(env, r.id);
      return Response.json({ name: r.name, scores });
    } catch (e) {
      return Response.json({ error: '성적을 불러오지 못했습니다.' }, { status: 500 });
    }
  }

  // ── POST: 추가 / 수정 ──
  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (_) {}

    const r = await resolveStudent(body.name);
    if (r.response) return r.response;
    if (r.error) return Response.json({ error: r.error }, { status: r.status });

    const examType = (body.examType || '').trim();
    if (examType !== '내신' && examType !== '모의')
      return Response.json({ error: "examType은 '내신' 또는 '모의' 여야 합니다." }, { status: 400 });
    const label = (body.label || '').trim();
    if (!label) return Response.json({ error: '시기(label)는 필수입니다.' }, { status: 400 });

    const rawScore = intOrNull(body.rawScore);
    if (rawScore !== null && (rawScore < 0 || rawScore > 100))
      return Response.json({ error: '원점수는 0~100 사이여야 합니다.' }, { status: 400 });
    const grade = intOrNull(body.grade);
    if (grade !== null && (grade < 1 || grade > 9))
      return Response.json({ error: '등급은 1~9 사이여야 합니다.' }, { status: 400 });
    if (rawScore === null && grade === null)
      return Response.json({ error: '원점수 또는 등급 중 하나는 입력해주세요.' }, { status: 400 });

    const gradeLevel = (body.gradeLevel || '').trim();
    const sortKey = (body.sortKey || '').trim();
    const examDate = (body.examDate || '').trim();
    const memo = (body.memo || '').trim();
    const now = new Date().toISOString();

    try {
      if (body.id) {
        const ex = await env.DB.prepare('SELECT student_id FROM exam_scores WHERE id=?').bind(body.id).first();
        if (!ex) return Response.json({ error: '수정할 성적을 찾을 수 없습니다.' }, { status: 404 });
        if (Number(ex.student_id) !== Number(r.id)) return Response.json({ error: '권한이 없습니다.' }, { status: 403 });
        await env.DB.prepare(
          'UPDATE exam_scores SET exam_type=?, grade_level=?, label=?, sort_key=?, raw_score=?, grade=?, exam_date=?, memo=?, updated_at=? WHERE id=?'
        ).bind(examType, gradeLevel, label, sortKey, rawScore, grade, examDate, memo, now, body.id).run();
        return Response.json({ ok: true, id: body.id });
      }
      const res = await env.DB.prepare(
        'INSERT INTO exam_scores (student_id, exam_type, grade_level, label, sort_key, raw_score, grade, exam_date, memo, created_at, updated_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(r.id, examType, gradeLevel, label, sortKey, rawScore, grade, examDate, memo, now, now).run();
      return Response.json({ ok: true, id: res.meta && res.meta.last_row_id });
    } catch (e) {
      return Response.json({ error: '성적 저장에 실패했습니다.' }, { status: 500 });
    }
  }

  // ── DELETE ──
  if (request.method === 'DELETE') {
    let body = {};
    try { body = await request.json(); } catch (_) {}
    const id = body.id || url.searchParams.get('id');
    if (!id) return Response.json({ error: 'id 필수' }, { status: 400 });

    const r = await resolveStudent(body.name);
    if (r.response) return r.response;
    if (r.error) return Response.json({ error: r.error }, { status: r.status });

    try {
      const ex = await env.DB.prepare('SELECT student_id FROM exam_scores WHERE id=?').bind(id).first();
      if (!ex) return Response.json({ ok: true, removed: 0 });
      if (Number(ex.student_id) !== Number(r.id)) return Response.json({ error: '권한이 없습니다.' }, { status: 403 });
      await env.DB.prepare('DELETE FROM exam_scores WHERE id=?').bind(id).run();
      return Response.json({ ok: true, removed: 1 });
    } catch (e) {
      return Response.json({ error: '성적 삭제에 실패했습니다.' }, { status: 500 });
    }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
