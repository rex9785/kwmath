// functions/api/_outcomes.js
// ───────────────────────────────────────────────────────────
// 회원탈퇴/퇴원으로 학생 데이터를 '하드 삭제'하기 직전에,
// 개인 직접식별자(전화·생년·계정 등)는 빼고 '성과 기록'만 따로 한 줄 보존한다.
//
// 남기는 것 : 마스킹 이름(김명환→김*환) · 학교 · 학년 · 수강기간(가입~탈퇴) ·
//             지금까지 본 '모든' 성적 이력(scores_json: 내신/모의 전체)
// 빼는 것   : 전화번호 · 부모번호 · 뒷자리 · 생년 · personal_key · 계정 등 직접식별자 일절
//
// ⚠️ 마스킹 이름 + 학교 + 성적 조합은 소규모에선 재식별 여지가 있어 법적으론 '가명정보'다(=여전히 개인정보).
//    그래서 노션(해외) 대신 '자체 D1'에만, '관리자 전용'으로 둔다(국외이전 회피). 개인정보처리방침에 보존 사실을 명시하고,
//    실명·학교까지 공개해 홍보로 쓸 땐 그때 별도 동의(미성년은 보호자 동의)를 받는다.
// ───────────────────────────────────────────────────────────

// 이름 가운데를 가린다. 김명환→김*환, 박민→박*, 김(1자)→*  (가린 문자는 * — 원하면 바꿔도 됨)
export function maskName(name) {
  const s = (name || '').trim();
  if (!s) return '';
  const c = Array.from(s);                       // 한글 1글자 단위 처리
  if (c.length === 1) return '*';
  if (c.length === 2) return c[0] + '*';
  return c[0] + '*'.repeat(c.length - 2) + c[c.length - 1];
}

export async function ensureOutcomesTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS student_outcomes (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'name_masked TEXT, school TEXT, grade_level TEXT, ' +
    'enrolled_at TEXT, left_at TEXT, ' +
    'score_count INTEGER, scores_json TEXT, summary TEXT, ' +
    'note TEXT, created_at TEXT)'
  ).run();
  // 예전 형태(첫/끝 컬럼만 있던 버전)에서 올라올 때를 대비한 마이그레이션 가드 — 이미 있으면 catch
  for (const col of ['scores_json TEXT', 'score_count INTEGER', 'summary TEXT', 'school TEXT', 'grade_level TEXT']) {
    try { await env.DB.prepare('ALTER TABLE student_outcomes ADD COLUMN ' + col).run(); } catch (_) { /* 이미 있음 */ }
  }
}

// 사람이 한눈에 읽는 요약: "내신 3→1 · 모의 4→2" (유효 등급이 있을 때만)
function buildSummary(scores) {
  function fl(type) {
    const v = scores.filter(s => s.examType === type && s.grade != null);
    if (!v.length) return null;
    const a = v[0].grade, b = v[v.length - 1].grade;
    return (a === b) ? (type + ' ' + a + '등급') : (type + ' ' + a + '→' + b);
  }
  return [fl('내신'), fl('모의')].filter(Boolean).join(' · ');
}

// student: { id, name, school, grade, created_at }
// 삭제 전에 호출 → exam_scores 전체를 읽어 익명 성과 한 줄을 student_outcomes에 insert.
// 실패해도 삭제 흐름을 막지 않도록 항상 {ok} 형태로만 반환(throw 안 함).
export async function snapshotOutcome(env, student) {
  try {
    if (!student || !student.id) return { ok: false, error: 'no student' };
    await ensureOutcomesTable(env);

    let rows = [];
    try {
      const q = await env.DB.prepare(
        "SELECT exam_type, grade_level, label, sort_key, raw_score, grade, exam_date " +
        "FROM exam_scores WHERE student_id=? " +
        "ORDER BY (sort_key IS NULL OR sort_key=''), sort_key ASC, id ASC"
      ).bind(student.id).all();
      rows = q.results || [];
    } catch (_) { rows = []; }   // exam_scores 테이블이 아직 없으면 성적은 빈 값으로

    // 전체 성적 이력을 그대로(개인식별 없는 성적값만) 직렬화
    const scores = rows.map(r => ({
      examType: r.exam_type || '',
      gradeLevel: r.grade_level || '',
      label: r.label || '',
      rawScore: (r.raw_score === null || r.raw_score === undefined) ? null : r.raw_score,
      grade: (r.grade === null || r.grade === undefined) ? null : r.grade,
      examDate: r.exam_date || '',
    }));
    const now = new Date().toISOString();

    await env.DB.prepare(
      'INSERT INTO student_outcomes ' +
      '(name_masked, school, grade_level, enrolled_at, left_at, score_count, scores_json, summary, note, created_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      maskName(student.name), student.school || '', student.grade || '',
      student.created_at || '', now,
      scores.length, JSON.stringify(scores), buildSummary(scores), '', now
    ).run();

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
