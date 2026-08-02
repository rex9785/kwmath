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
import { listStudentsByName, getStudentById, listStudents } from './_db.js';
import { staffScopeAcademy } from './_staff.js';
import { ensureExamScoresTable } from './_scores.js';   // 스키마 단일 출처(테스트 자동성적과 공유)
import { logAudit, diffFields } from './_auditlog.js';

// 🔒 2026-07-31 — 조교 학원 스코프 판정에서 '이름 Set'을 없앴다.
//   예전: 담당 학원 학생 **이름** Set에 들어 있으면 통과 → 그 뒤 getStudentByName 이
//         (ORDER BY id LIMIT 1) **다른 학원의 동명이인**을 집어올 수 있었다.
//         즉 "우리 학원에 김민준이 있다"는 사실만으로 남의 학원 김민준 성적을 읽고 쓸 수 있었다.
//   지금: sid 경로든 이름 경로든 **찾아낸 학생의 academy 를 담당 학원과 직접 대조**한다(아래 resolveStudent).
//         이름 Set은 더 이상 어디에서도 쓰지 않으므로 제거했다.

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
  const scopeAcad = isAdmin ? await staffScopeAcademy(env, request) : null;

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
  //
  // 🔎 2026-07-31 — 찾는 규칙은 예전 그대로다(sid 우선 → 없으면 이름 폴백). 바뀐 건 **결과에 꼬리표를
  //   붙여 돌려준다**는 것뿐이다(via·academy·요청자 신원). 성적이 엉뚱한 학생에게 들어갔을 때
  //   "이 학생을 학생번호로 집었는지, 이름으로 집었는지"가 로그에 없으면 동명이인 사고인지
  //   조교의 오입력인지 영영 구분할 수 없다. getStudentByName은 동명이인이면 먼저 등록된 1명만
  //   잡히므로(ORDER BY id LIMIT 1) 이름 경로로 들어온 쓰기는 특히 표시가 필요하다.
  async function resolveStudent(bodyName, bodySid) {
    if (isAdmin) {
      // 🔒 담당 학원이 아직 지정되지 않은 조교는 어떤 학생도 못 본다.
      //   (scopeAcad === '' = 미배정. 이게 없으면 '학원 미지정 학생'과 ''끼리 맞아떨어져 통과해 버린다.)
      if (scopeAcad !== null && !scopeAcad)
        return { error: '담당 학원이 아직 지정되지 않았어요. 원장님께 학원 배정을 요청해 주세요.', status: 403, via: '조교 학원 미배정' };
      // sid 우선 — 동명이인이 있어도 정확히 그 학생 한 명.
      const sid = String(bodySid || url.searchParams.get('sid') || '').trim();
      if (sid) {
        const via = 'studentId(동명이인 안전)';
        const st = await getStudentById(env, sid);
        if (!st) return { error: '학생을 D1에서 찾을 수 없습니다.', status: 404, via, 찾은키: sid };
        if (scopeAcad !== null && (st.academy || '') !== scopeAcad)
          return { error: '담당 학원 학생만 성적을 입력·조회할 수 있어요.', status: 403, via, 찾은키: sid,
                   name: st.name, academy: st.academy || '', 담당학원: scopeAcad };
        return { id: st.id, name: st.name, academy: st.academy || '', via };
      }
      // ── 이름 폴백 (구버전 화면 호환) ──
      //   여기서 조용히 엉뚱한 학생을 집으면 성적이 남의 성적표에 박힌다. 그래서 두 겹으로 막는다.
      const via = 'name 폴백';
      const name = (bodyName || url.searchParams.get('name') || '').trim();
      if (!name) return { error: 'name 필수', status: 400, via };
      const 후보 = await listStudentsByName(env, name);
      if (!후보.length) return { error: '학생을 D1에서 찾을 수 없습니다.', status: 404, via, 찾은키: name };
      // ① 같은 이름이 2명 이상이면 **아무것도 하지 않고 거부**한다(409).
      //    예전엔 먼저 등록된 1명이 조용히 선택돼, 성적이 엉뚱한 학생에게 들어가도 아무도 몰랐다.
      if (후보.length > 1) {
        return {
          error: '같은 이름 학생이 ' + 후보.length + '명이라 누구인지 확정할 수 없어요. 학생 목록에서 학생을 골라 주세요.',
          status: 409, via, 찾은키: name, 동명이인수: 후보.length,
          후보목록: 후보.map(s => ({ id: String(s.id), 학원: s.academy || '', 반: s.className || '', 학교: s.school || '' })),
        };
      }
      // ② 1명이어도 그 학생의 학원을 담당 학원과 직접 대조 — sid 경로와 완전히 같은 기준.
      const st = 후보[0];
      if (scopeAcad !== null && (st.academy || '') !== scopeAcad)
        return { error: '담당 학원 학생만 성적을 입력·조회할 수 있어요.', status: 403, via, 찾은키: name,
                 name: st.name, academy: st.academy || '', 담당학원: scopeAcad };
      return { id: st.id, name: st.name, academy: st.academy || '', via };
    }
    const access = await requireStudentAccess(env, request); // ?name= 쿼리로 자녀 선택 + 권한 검증
    if (!access.ok) return { response: access.response };
    const 관계 = access.student.role === 'parent' ? '학부모' : '학생';
    return {
      id: access.student.id, name: access.student.name, academy: access.student.academy || '',
      via: '본인·자녀 토큰(' + 관계 + ')',
      // 학생·학부모는 조교 헤더도 관리자 비번도 없어 actorOf가 '누구'를 못 캔다 → 여기서 직접 실어 준다.
      actor: access.phone,
      actorRole: access.student.role === 'parent' ? 'parent' : 'student',
      actorName: (access.student.name || '') + (관계 === '학부모' ? ' 학부모' : ''),
    };
  }

  // 로그의 '누가' 칸. 원장·조교는 미들웨어가 실은 헤더로 logAudit이 알아서 채우므로 비워 두고,
  //   학생·학부모(포털 토큰) 경로만 위에서 담아 온 신원을 넘긴다.
  const actorOfResolved = (r) => (r && r.actor
    ? { actor: r.actor, actorRole: r.actorRole, actorName: r.actorName }
    : {});

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
    if (r.error) {
      // ⚠️ 2026-07-31 — 조교가 담당 학원 밖 학생 성적을 건드리려 한 시도(403)가 아무 데도 안 남았다.
      //   앱이 엉뚱한 sid를 보낸 버그인지, 남의 반 성적을 손대려 한 건지 사후에 구분할 근거가 필요하다.
      await logAudit(env, request, {
        action: 'score.denied',
        target: String(r.찾은키 || body.sid || body.name || ''), targetName: r.name || '',
        summary: '성적 ' + (body.id ? '수정' : '입력') + ' 거부(' + r.status + ') — ' + r.error,
        detail: {
          거부사유: r.error, 상태코드: r.status,
          지목방식: r.via || '(알 수 없음)',
          찾으려한값: String(r.찾은키 || body.sid || body.name || '(없음)').slice(0, 100),
          학생이름: r.name || '(확인 안 됨)', 학생학원: r.academy || '(확인 안 됨)',
          조교담당학원: r.담당학원 === undefined ? '(원장 · 제한 없음)' : (r.담당학원 || '(미배정)'),
          동명이인: r.동명이인수 ? (r.동명이인수 + '명 — ' + JSON.stringify(r.후보목록 || [])) : '해당 없음',
          결과: '아무것도 저장되지 않음',
        },
      });
      return Response.json({ error: r.error }, { status: r.status });
    }

    // 🔎 2026-07-31 — 반려(400)는 화면에 빨간 글씨 한 줄 뜨고 사라져 흔적이 없었다.
    //   "성적 분명히 입력했는데 안 들어갔어요" 소리가 나오면, 서버까지 왔는데 값이 규칙에 안 맞아
    //   튕긴 건지 / 요청 자체가 안 온 건지 가릴 방법이 없다. 보낸 값을 통째로 남겨 둔다.
    const rejectPost = async (reason, status) => {
      await logAudit(env, request, Object.assign({
        action: 'score.reject',
        target: String(r.id), targetName: r.name || '',
        summary: '성적 ' + (body.id ? '수정' : '입력') + ' 반려(' + status + ') [' + (r.name || r.id) + '] — ' + reason,
        detail: {
          학생id: String(r.id), 이름: r.name || '', 학원: r.academy || '',
          지목방식: r.via || '(알 수 없음)',
          반려사유: reason, 상태코드: status,
          고치려던성적id: body.id ? String(body.id) : '(신규 입력)',
          보낸값: {
            시험종류: String(body.examType === undefined ? '(안 보냄)' : body.examType).slice(0, 100),
            학년: String(body.gradeLevel === undefined ? '(안 보냄)' : body.gradeLevel).slice(0, 100),
            시기: String(body.label === undefined ? '(안 보냄)' : body.label).slice(0, 200),
            원점수: String(body.rawScore === undefined ? '(안 보냄)' : body.rawScore).slice(0, 50),
            등급: String(body.grade === undefined ? '(안 보냄)' : body.grade).slice(0, 50),
            시험날짜: String(body.examDate === undefined ? '(안 보냄)' : body.examDate).slice(0, 50),
            메모: String(body.memo === undefined ? '(안 보냄)' : body.memo).slice(0, 300),
          },
          결과: '아무것도 저장되지 않음',
        },
      }, actorOfResolved(r)));
      return Response.json({ error: reason }, { status });
    };

    const examType = (body.examType || '').trim();
    if (examType !== '내신' && examType !== '모의')
      return await rejectPost("examType은 '내신' 또는 '모의' 여야 합니다.", 400);
    const label = (body.label || '').trim();
    if (!label) return await rejectPost('시기(label)는 필수입니다.', 400);
    const gradeLevel = (body.gradeLevel || '').trim();
    if (!gradeLevel) return await rejectPost('학년을 선택해주세요.', 400);

    const rawScore = intOrNull(body.rawScore);
    if (rawScore !== null && (rawScore < 0 || rawScore > 100))
      return await rejectPost('원점수는 0~100 사이여야 합니다.', 400);
    const grade = intOrNull(body.grade);
    if (grade !== null && (grade < 1 || grade > 9))
      return await rejectPost('등급은 1~9 사이여야 합니다.', 400);
    if (rawScore === null && grade === null)
      return await rejectPost('원점수 또는 등급 중 하나는 입력해주세요.', 400);

    const sortKey = (body.sortKey || '').trim();
    const examDate = (body.examDate || '').trim();
    const memo = (body.memo || '').trim();
    const now = new Date().toISOString();

    try {
      // 같은 학생·유형·학년·시기 중복 방지 (수정 시 자기 자신은 제외)
      const dupSql = 'SELECT id FROM exam_scores WHERE student_id=? AND exam_type=? AND grade_level=? AND label=?' + (body.id ? ' AND id<>?' : '');
      const dupBind = body.id ? [r.id, examType, gradeLevel, label, body.id] : [r.id, examType, gradeLevel, label];
      const dup = await env.DB.prepare(dupSql).bind(...dupBind).first();
      if (dup) return await rejectPost('이미 입력된 시험이에요. (같은 학년·시기) 기존 항목을 수정해주세요.', 409);
      if (body.id) {
        // 🔎 2026-07-31 — 원래 student_id 한 칸만 읽어서 "고치기 전 점수"를 아무도 몰랐다.
        //   같은 SELECT의 컬럼만 넓히면 이전 값이 공짜로 손에 들어온다(쿼리 추가 없음).
        //   성적은 학부모와 다투는 지점이라 '몇 점 → 몇 점'이 남아야 한다.
        const ex = await env.DB.prepare('SELECT * FROM exam_scores WHERE id=?').bind(body.id).first();
        if (!ex) return await rejectPost('수정할 성적을 찾을 수 없습니다.', 404);
        if (Number(ex.student_id) !== Number(r.id)) {
          // ⚠️ 2026-07-31 — 남의 학생 성적 행을 자기 학생인 척 고치려 한 시도. 예전엔 403만 뱉고 끝이라
          //   앱 버그인지 사람의 시도인지 구분할 흔적이 전혀 없었다. 어느 행을 노렸는지까지 남긴다.
          await logAudit(env, request, Object.assign({
            action: 'score.update.denied',
            target: String(body.id), targetName: r.name || '',
            summary: '성적 수정 거부(403) — 성적 #' + body.id + '은(는) 다른 학생(id ' + ex.student_id + ') 것인데 ['
              + (r.name || r.id) + '] 이름으로 고치려 함',
            detail: {
              성적id: String(body.id),
              성적행의학생id: String(ex.student_id), 요청자가지목한학생id: String(r.id), 이름: r.name || '',
              지목방식: r.via || '(알 수 없음)',
              건드리려한행: { 시험종류: ex.exam_type || '', 학년: ex.grade_level || '', 시기: ex.label || '',
                            원점수: ex.raw_score, 등급: ex.grade },
              결과: '거부됨 — 아무것도 바뀌지 않음',
            },
          }, actorOfResolved(r)));
          return Response.json({ error: '권한이 없습니다.' }, { status: 403 });
        }
        const upd = await env.DB.prepare(
          'UPDATE exam_scores SET exam_type=?, grade_level=?, label=?, sort_key=?, raw_score=?, grade=?, exam_date=?, memo=?, updated_at=? WHERE id=?'
        ).bind(examType, gradeLevel, label, sortKey, rawScore, grade, examDate, memo, now, body.id).run();

        // 📓 2026-07-31 — 성적 수정은 여태 아무 기록도 안 남았다. 조교 여럿이 같은 학생 성적표를 만지는데
        //   "내신 88이었는데 왜 78이지?" 같은 항의가 오면 누가 언제 고쳤는지 되짚을 방법이 아예 없었다.
        //   (덮어쓴 값이 퀴즈 자동반영분이면 source_key로 드러난다 → 수동 수정이 자동값을 밀어낸 것도 보인다.)
        const d = diffFields(
          { 시험종류: ex.exam_type || '', 학년: ex.grade_level || '', 시기: ex.label || '', 정렬키: ex.sort_key || '',
            원점수: ex.raw_score, 등급: ex.grade, 시험날짜: ex.exam_date || '', 메모: ex.memo || '' },
          { 시험종류: examType, 학년: gradeLevel, 시기: label, 정렬키: sortKey,
            원점수: rawScore, 등급: grade, 시험날짜: examDate, 메모: memo }
        );
        await logAudit(env, request, Object.assign({
          action: 'score.update',
          target: String(body.id), targetName: r.name || '',
          summary: '성적 수정 [' + (r.name || r.id) + ' · ' + examType + ' ' + gradeLevel + ' ' + label + '] — '
            + (d.요약 || '값 동일(updated_at만 갱신)'),
          detail: {
            성적id: String(body.id), 학생id: String(r.id), 이름: r.name || '', 학원: r.academy || '',
            지목방식: r.via || '(알 수 없음)',
            바뀐칸: d.바뀐칸, 변경: d.변경,
            이전값: { 시험종류: ex.exam_type || '', 학년: ex.grade_level || '', 시기: ex.label || '', 정렬키: ex.sort_key || '',
                    원점수: ex.raw_score, 등급: ex.grade, 시험날짜: ex.exam_date || '', 메모: (ex.memo || '').slice(0, 500),
                    입력시각: ex.created_at || '', 직전수정시각: ex.updated_at || '' },
            이전출처: ex.source_key ? (ex.source_key + ' (테스트 자동반영분을 손으로 덮어씀)') : '수동 입력분',
            바뀐행수: (upd && upd.meta && upd.meta.changes !== undefined) ? upd.meta.changes : '(알 수 없음)',
          },
        }, actorOfResolved(r)));
        return Response.json({ ok: true, id: body.id });
      }
      const res = await env.DB.prepare(
        'INSERT INTO exam_scores (student_id, exam_type, grade_level, label, sort_key, raw_score, grade, exam_date, memo, created_at, updated_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(r.id, examType, gradeLevel, label, sortKey, rawScore, grade, examDate, memo, now, now).run();

      // 📓 2026-07-31 — 성적 '입력'도 기록이 없었다. 사소해 보여도 이게 없으면 나중에 수정 로그를 봐도
      //   최초에 누가 어떤 점수를 넣어 준 건지가 비어 있어서 이력이 중간부터 시작한다.
      await logAudit(env, request, Object.assign({
        action: 'score.create',
        target: String((res && res.meta && res.meta.last_row_id) || ''), targetName: r.name || '',
        summary: '성적 입력 [' + (r.name || r.id) + ' · ' + examType + ' ' + gradeLevel + ' ' + label + '] — '
          + (rawScore === null ? '원점수 없음' : '원점수 ' + rawScore)
          + ' · ' + (grade === null ? '등급 없음' : grade + '등급'),
        detail: {
          성적id: String((res && res.meta && res.meta.last_row_id) || '(모름)'),
          학생id: String(r.id), 이름: r.name || '', 학원: r.academy || '',
          지목방식: r.via || '(알 수 없음)',
          넣은값: { 시험종류: examType, 학년: gradeLevel, 시기: label, 정렬키: sortKey,
                  원점수: rawScore, 등급: grade, 시험날짜: examDate, 메모: memo.slice(0, 500) },
          만든행수: (res && res.meta && res.meta.changes !== undefined) ? res.meta.changes : '(알 수 없음)',
          입력시각: now,
        },
      }, actorOfResolved(r)));
      return Response.json({ ok: true, id: res.meta && res.meta.last_row_id });
    } catch (e) {
      // 🔴 2026-07-31 — 저장 실패는 화면의 '성적 저장에 실패했습니다' 한 줄로만 뜨고 사라졌다.
      //   무엇을 넣으려다 실패했는지가 안 남으면 대신 입력해 주지도, 재현하지도 못한다.
      await logAudit(env, request, Object.assign({
        action: 'score.save.fail',
        target: String(body.id || r.id || ''), targetName: r.name || '',
        summary: '성적 ' + (body.id ? '수정' : '입력') + ' 저장 실패(500) [' + (r.name || r.id) + ' · '
          + examType + ' ' + gradeLevel + ' ' + label + ']',
        detail: {
          성적id: body.id ? String(body.id) : '(신규)',
          학생id: String(r.id), 이름: r.name || '', 학원: r.academy || '',
          지목방식: r.via || '(알 수 없음)',
          넣으려던값: { 시험종류: examType, 학년: gradeLevel, 시기: label, 정렬키: sortKey,
                     원점수: rawScore, 등급: grade, 시험날짜: examDate, 메모: memo.slice(0, 500) },
          DB오류: String((e && e.message) || e || '알 수 없는 오류').slice(0, 300),
          결과: '저장 안 됨 — 성적표는 예전 값 그대로',
        },
      }, actorOfResolved(r)));
      return Response.json({ error: '성적 저장에 실패했습니다.' }, { status: 500 });
    }
  }

  // ── DELETE ──
  if (request.method === 'DELETE') {
    let body = {};
    try { body = await request.json(); } catch (_) {}
    const id = body.id || url.searchParams.get('id');
    if (!id) {
      // 🔎 2026-07-31 — 지우려는 대상이 안 실려 온 요청. 예전엔 400만 뱉고 흔적이 없어서
      //   "지웠는데 그대로예요" 문의가 오면 요청이 오긴 왔는지조차 확인이 안 됐다(프론트 버그 단서).
      await logAudit(env, request, {
        action: 'score.delete.reject',
        summary: '성적 삭제 반려(400) — 지울 성적 id가 안 왔음. 아무것도 지워지지 않음',
        detail: {
          반려사유: 'id 필수 — body.id·?id 둘 다 비어 있음',
          같이온값: {
            sid: String(body.sid === undefined ? '(없음)' : body.sid).slice(0, 50),
            name: String(body.name === undefined ? '(없음)' : body.name).slice(0, 50),
            쿼리sid: String(url.searchParams.get('sid') || '(없음)').slice(0, 50),
          },
          결과: '아무것도 지워지지 않음',
        },
      });
      return Response.json({ error: 'id 필수' }, { status: 400 });
    }

    const r = await resolveStudent(body.name, body.sid);
    if (r.response) return r.response;
    if (r.error) {
      // ⚠️ 2026-07-31 — 담당 학원 밖 학생의 성적을 지우려 한 시도(403)가 어디에도 안 남았다.
      //   삭제는 되돌릴 수 없으니, 막힌 시도라도 누가 무엇을 노렸는지는 남겨 둬야 한다.
      await logAudit(env, request, {
        action: 'score.delete.denied',
        target: String(id), targetName: r.name || '',
        summary: '성적 삭제 거부(' + r.status + ') — 성적 #' + id + ' · ' + r.error,
        detail: {
          성적id: String(id), 거부사유: r.error, 상태코드: r.status,
          지목방식: r.via || '(알 수 없음)',
          찾으려한값: String(r.찾은키 || body.sid || body.name || '(없음)').slice(0, 100),
          학생이름: r.name || '(확인 안 됨)', 학생학원: r.academy || '(확인 안 됨)',
          조교담당학원: r.담당학원 === undefined ? '(원장 · 제한 없음)' : (r.담당학원 || '(미배정)'),
          동명이인: r.동명이인수 ? (r.동명이인수 + '명 — ' + JSON.stringify(r.후보목록 || [])) : '해당 없음',
          결과: '아무것도 지워지지 않음',
        },
      });
      return Response.json({ error: r.error }, { status: r.status });
    }

    try {
      // 🔴 2026-07-31 — student_id 한 칸만 읽던 걸 행 전체로 넓혔다(쿼리 추가 없음).
      //   삭제에는 되돌리기가 없다. 이 로그가 사라진 점수의 유일한 사본이 되므로 행을 통째로 남긴다.
      const ex = await env.DB.prepare('SELECT * FROM exam_scores WHERE id=?').bind(id).first();
      if (!ex) {
        // 📓 2026-07-31 — "지울 게 없었음"도 남긴다. 이미 다른 조교가 지운 뒤였는지, 애초에 없던 id인지를
        //   가리려면 이 빈 삭제도 시각과 함께 기록돼 있어야 한다(응답은 예전처럼 removed:0).
        await logAudit(env, request, Object.assign({
          action: 'score.delete.noop',
          target: String(id), targetName: r.name || '',
          summary: '성적 삭제 요청했지만 지울 게 없었음 [' + (r.name || r.id) + ' · 성적 #' + id + '] — 이미 지워졌거나 없는 id',
          detail: {
            성적id: String(id), 학생id: String(r.id), 이름: r.name || '', 학원: r.academy || '',
            지목방식: r.via || '(알 수 없음)',
            결과: 'DB 쓰기 안 함 · removed:0 으로 응답(에러 아님)',
          },
        }, actorOfResolved(r)));
        return Response.json({ ok: true, removed: 0 });
      }
      if (Number(ex.student_id) !== Number(r.id)) {
        // ⚠️ 2026-07-31 — 남의 학생 성적 행을 지우려 한 시도. 막혔더라도 어느 행을 노렸는지 남긴다.
        await logAudit(env, request, Object.assign({
          action: 'score.delete.denied',
          target: String(id), targetName: r.name || '',
          summary: '성적 삭제 거부(403) — 성적 #' + id + '은(는) 다른 학생(id ' + ex.student_id + ') 것인데 ['
            + (r.name || r.id) + '] 이름으로 지우려 함',
          detail: {
            성적id: String(id),
            성적행의학생id: String(ex.student_id), 요청자가지목한학생id: String(r.id), 이름: r.name || '',
            지목방식: r.via || '(알 수 없음)',
            지우려한행: { 시험종류: ex.exam_type || '', 학년: ex.grade_level || '', 시기: ex.label || '',
                        원점수: ex.raw_score, 등급: ex.grade },
            결과: '거부됨 — 아무것도 지워지지 않음',
          },
        }, actorOfResolved(r)));
        return Response.json({ error: '권한이 없습니다.' }, { status: 403 });
      }
      const del = await env.DB.prepare('DELETE FROM exam_scores WHERE id=?').bind(id).run();

      // 🔴 2026-07-31 — 성적 삭제는 여태 아무 기록도 안 남았다. 점수 한 줄이 소리 없이 사라지면
      //   학부모가 "그 시험 점수 어디 갔냐" 물어도 되살릴 근거가 없다. 지워진 행 전체를 여기 박아 둔다.
      await logAudit(env, request, Object.assign({
        action: 'score.delete',
        target: String(id), targetName: r.name || '',
        summary: '성적 삭제 [' + (r.name || r.id) + ' · ' + (ex.exam_type || '') + ' ' + (ex.grade_level || '') + ' '
          + (ex.label || '') + '] — '
          + (ex.raw_score === null || ex.raw_score === undefined ? '원점수 없음' : '원점수 ' + ex.raw_score)
          + ' · ' + (ex.grade === null || ex.grade === undefined ? '등급 없음' : ex.grade + '등급')
          + ' 이 없던 일이 됨 (복구 불가)',
        detail: {
          성적id: String(id), 학생id: String(r.id), 이름: r.name || '', 학원: r.academy || '',
          지목방식: r.via || '(알 수 없음)',
          지워진행: {
            시험종류: ex.exam_type || '', 학년: ex.grade_level || '', 시기: ex.label || '', 정렬키: ex.sort_key || '',
            원점수: ex.raw_score, 등급: ex.grade, 시험날짜: ex.exam_date || '', 메모: (ex.memo || '').slice(0, 500),
            출처: ex.source_key || '수동 입력분', 입력시각: ex.created_at || '', 직전수정시각: ex.updated_at || '',
          },
          지운행수: (del && del.meta && del.meta.changes !== undefined) ? del.meta.changes : '(알 수 없음)',
          비고: '되돌리기 없음 — 이 로그가 지워진 점수의 유일한 사본',
        },
      }, actorOfResolved(r)));
      return Response.json({ ok: true, removed: 1 });
    } catch (e) {
      // 🔴 2026-07-31 — 삭제 실패도 남긴다. 실패했는데 화면만 지워진 것처럼 보이는 경우를 가려내야 한다.
      await logAudit(env, request, Object.assign({
        action: 'score.delete.fail',
        target: String(id), targetName: r.name || '',
        summary: '성적 삭제 실패(500) [' + (r.name || r.id) + ' · 성적 #' + id + '] — 성적은 그대로 남아 있음',
        detail: {
          성적id: String(id), 학생id: String(r.id), 이름: r.name || '', 학원: r.academy || '',
          지목방식: r.via || '(알 수 없음)',
          DB오류: String((e && e.message) || e || '알 수 없는 오류').slice(0, 300),
          결과: '삭제 안 됨 — 성적은 남아 있음(화면만 지워진 것처럼 보일 수 있음)',
        },
      }, actorOfResolved(r)));
      return Response.json({ error: '성적 삭제에 실패했습니다.' }, { status: 500 });
    }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
