// /api/scores  — 시험 성적 (수학) : 원점수 + 등급
// ───────────────────────────────────────────────────────────
// D1 table: exam_scores (없으면 자동 생성). 학생 식별 = student_id.
// 인증: admin(Bearer ADMIN_PASSWORD) = 모든 학생 / 학생·학부모(토큰) = 본인·자녀만
//
//  GET    ?sid=12 (또는 ?name=홍길동)   → 그 학생 성적 목록(시간순). sid 우선 = 동명이인 안전.
//  GET    ?scope=class&acad=&cls=       → 반(또는 학원) 전체 명단 + 성적. 관리자·조교 전용(반 평균 화면).
//  POST   { sid?, name?, id?, examType, gradeLevel?, label, sortKey?, rawScore?, grade?, examDate?, memo? }
//                                        → 추가 (id 있으면 수정). 학생은 본인만(?name 쿼리로 자녀 선택).
//  DELETE { id }  (+ ?sid= 또는 ?name=) → 삭제. 학생은 본인 것만.
//
//  examType: 수동 입력 = '내신' | '모의'  ·  퀴즈 자동반영 = '일일테스트'|'주간테스트'|'월말테스트'
//            (자동반영분은 _scores.js가 넣는다. raw_score만 있고 grade는 항상 NULL, source_key='quiz:<id>')
//  rawScore: 0~100(정수)   grade: 1~9(정수, 1이 제일 좋음)
//  sortKey : 시간순 정렬용 문자열(프론트가 생성, 예 '2026-1-1' = 고1·1학기·중간). 없으면 id순.
// ───────────────────────────────────────────────────────────
import { requireStudentAccess } from './_auth.js';
import { getStudentByName, getStudentById, listStudents } from './_db.js';
import { staffScopeAcademy } from './_staff.js';
import { ensureExamScoresTable } from './_scores.js';   // 스키마 단일 출처(테스트 자동성적과 공유)

// 조교(X-Staff-Phone)가 맡은 학원의 학생 이름 Set. 미배정 조교는 빈 Set → 아무 학생도 못 봄/못 씀.
//   ⚠️ 이름 Set은 레거시 ?name= 경로 전용이다. sid·반 조회는 academy를 직접 비교해 판정한다
//      (다른 학원에 동명이인이 있으면 이름 Set만으로는 스코프를 우회당할 수 있으므로).
async function rosterNames(env, academy) {
  const roster = academy ? (await listStudents(env)).filter(s => (s.academy || '') === academy) : [];
  return new Set(roster.map(s => s.name));
}

// exam_scores 스키마 보장은 _scores.js의 ensureExamScoresTable로 일원화(source_key 컬럼 포함).

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

  try { await ensureExamScoresTable(env); }
  catch (e) { return Response.json({ error: '성적 DB 초기화에 실패했습니다.' }, { status: 500 }); }

  // 조교 학원 스코프 (원장이면 null = 제한 없음, ''이면 미배정). isAdmin 경로에서만 의미 있음.
  const scopeAcad    = isAdmin ? await staffScopeAcademy(env, request) : null;
  const allowedNames = (isAdmin && scopeAcad !== null) ? await rosterNames(env, scopeAcad) : null;

  // ── GET ?scope=class : 반(또는 학원) 전체 명단 + 성적 — 반 평균 화면 전용 ──
  //   학생 식별을 처음부터 student_id로 하므로 동명이인이 섞이지 않는다(이름 계약 안 씀).
  //   성적이 하나도 없는 학생도 students에는 넣는다 → 화면에서 '미입력'으로 보여 "몇 명 빠졌는지"를 숨기지 않는다.
  if (request.method === 'GET' && url.searchParams.get('scope') === 'class') {
    if (!isAdmin) return Response.json({ error: '권한이 없습니다.' }, { status: 403 });
    // 필터 적용 여부는 파라미터가 '왔는지'로 판단한다 — 빈 문자열도 "학원(반) 미지정 학생"이라는 명시적 조건이라
    // 값이 비었다고 필터를 빼면 엉뚱한 학생까지 딸려온다.
    const hasAcad = url.searchParams.has('acad'), hasCls = url.searchParams.has('cls');
    let acad = (url.searchParams.get('acad') || '').trim();
    const cls = (url.searchParams.get('cls') || '').trim();
    let filterAcad = hasAcad;
    if (scopeAcad !== null) {                                  // 조교 — 담당 학원 밖은 차단
      if (!scopeAcad) return Response.json({ academy: acad, className: cls, students: [], scores: [] });
      if (hasAcad && acad !== scopeAcad) return Response.json({ error: '담당 학원 학생만 볼 수 있어요.' }, { status: 403 });
      acad = scopeAcad; filterAcad = true;
    }
    if (!filterAcad && !hasCls) return Response.json({ error: '학원 또는 반을 지정해주세요.' }, { status: 400 });
    try {
      const roster = (await listStudents(env)).filter(s =>
        (!filterAcad || (s.academy || '') === acad) && (!hasCls || (s.className || '') === cls));
      const students = roster.map(s => ({
        id: String(s.id), name: s.name || '', grade: s.grade || '',
        academy: s.academy || '', className: s.className || '',
      }));
      if (!students.length) return Response.json({ academy: acad, className: cls, students, scores: [] });
      // D1 바인딩 개수 한계를 넘지 않게 100명씩 끊어 조회(학원 전체를 고를 수도 있으므로).
      const scores = [];
      for (let i = 0; i < roster.length; i += 100) {
        const chunk = roster.slice(i, i + 100).map(s => s.id);
        const { results } = await env.DB.prepare(
          'SELECT * FROM exam_scores WHERE student_id IN (' + chunk.map(() => '?').join(',') + ')'
        ).bind(...chunk).all();
        (results || []).forEach(r => { const o = rowOut(r); o.studentId = String(r.student_id); scores.push(o); });
      }
      return Response.json({ academy: acad, className: cls, students, scores });
    } catch (e) {
      return Response.json({ error: '반 성적을 불러오지 못했습니다.' }, { status: 500 });
    }
  }

  // 요청자 → student_id 매핑 (admin: ?sid/?name으로 지정 / 학생: 토큰으로 본인·자녀)
  async function resolveStudent(bodyName, bodySid) {
    if (isAdmin) {
      // sid 우선 — 동명이인이 있어도 정확히 그 학생 한 명.
      const sid = String(bodySid || url.searchParams.get('sid') || '').trim();
      if (sid) {
        const st = await getStudentById(env, sid);
        if (!st) return { error: '학생을 D1에서 찾을 수 없습니다.', status: 404 };
        if (scopeAcad !== null && (st.academy || '') !== scopeAcad)
          return { error: '담당 학원 학생만 성적을 입력·조회할 수 있어요.', status: 403 };
        return { id: st.id, name: st.name };
      }
      const name = (bodyName || url.searchParams.get('name') || '').trim();
      if (!name) return { error: 'name 필수', status: 400 };
      // 조교는 자기 학원 학생만 (원장은 allowedNames=null → 통과). 조회·입력·삭제 모두 이 경로를 거침.
      if (allowedNames && !allowedNames.has(name)) return { error: '담당 학원 학생만 성적을 입력·조회할 수 있어요.', status: 403 };
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
    const r = await resolveStudent(null, null);
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

    const r = await resolveStudent(body.name, body.sid);
    if (r.response) return r.response;
    if (r.error) return Response.json({ error: r.error }, { status: r.status });

    const examType = (body.examType || '').trim();
    if (examType !== '내신' && examType !== '모의')
      return Response.json({ error: "examType은 '내신' 또는 '모의' 여야 합니다." }, { status: 400 });
    const label = (body.label || '').trim();
    if (!label) return Response.json({ error: '시기(label)는 필수입니다.' }, { status: 400 });
    const gradeLevel = (body.gradeLevel || '').trim();
    if (!gradeLevel) return Response.json({ error: '학년을 선택해주세요.' }, { status: 400 });

    const rawScore = intOrNull(body.rawScore);
    if (rawScore !== null && (rawScore < 0 || rawScore > 100))
      return Response.json({ error: '원점수는 0~100 사이여야 합니다.' }, { status: 400 });
    const grade = intOrNull(body.grade);
    if (grade !== null && (grade < 1 || grade > 9))
      return Response.json({ error: '등급은 1~9 사이여야 합니다.' }, { status: 400 });
    if (rawScore === null && grade === null)
      return Response.json({ error: '원점수 또는 등급 중 하나는 입력해주세요.' }, { status: 400 });

    const sortKey = (body.sortKey || '').trim();
    const examDate = (body.examDate || '').trim();
    const memo = (body.memo || '').trim();
    const now = new Date().toISOString();

    try {
      // 같은 학생·유형·학년·시기 중복 방지 (수정 시 자기 자신은 제외)
      const dupSql = 'SELECT id FROM exam_scores WHERE student_id=? AND exam_type=? AND grade_level=? AND label=?' + (body.id ? ' AND id<>?' : '');
      const dupBind = body.id ? [r.id, examType, gradeLevel, label, body.id] : [r.id, examType, gradeLevel, label];
      const dup = await env.DB.prepare(dupSql).bind(...dupBind).first();
      if (dup) return Response.json({ error: '이미 입력된 시험이에요. (같은 학년·시기) 기존 항목을 수정해주세요.' }, { status: 409 });
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

    const r = await resolveStudent(body.name, body.sid);
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
