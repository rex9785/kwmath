// functions/api/_outcomes.js
// ───────────────────────────────────────────────────────────
// 회원탈퇴/퇴원으로 학생 데이터를 '하드 삭제'하기 직전에,
// 개인을 식별할 수 없게 익명화한 '성과 기록'만 따로 한 줄 남긴다.
//
// 남기는 것 : 마스킹 이름(김명환→김*환) · 학교 · 학년 · 수강기간(가입~탈퇴) ·
//             성적 변화(내신/모의 각각 '첫 등급 → 마지막 등급' + 시기 라벨)
// 빼는 것   : 전화번호 · 부모번호 · 뒷자리 · 생년 · personal_key · 계정 등 직접 식별자 일절
//
// ⚠️ 마스킹 이름 + 학교 + 성적 조합은 소규모에선 재식별 여지가 있어 법적으로 '가명정보'다.
//    그래서 노션(해외) 대신 '자체 D1'에만 저장(국외이전 회피). 실명·학교까지 공개해
//    홍보로 쓸 땐 그때 별도 동의(미성년은 보호자 동의)를 받아야 한다.
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
    'naesin_first INTEGER, naesin_first_label TEXT, naesin_last INTEGER, naesin_last_label TEXT, ' +
    'mock_first INTEGER, mock_first_label TEXT, mock_last INTEGER, mock_last_label TEXT, ' +
    'score_count INTEGER, note TEXT, created_at TEXT)'
  ).run();
}

// rows: exam_scores (sort_key ASC, id ASC 로 이미 정렬됨). 해당 유형의 '첫/마지막' 유효 등급을 뽑는다.
function firstLast(rows, type) {
  const valid = rows.filter(r => r.exam_type === type && r.grade !== null && r.grade !== undefined);
  const f = valid[0] || null;
  const l = valid.length ? valid[valid.length - 1] : null;
  return {
    first: f ? f.grade : null, firstLabel: f ? (f.label || '') : '',
    last: l ? l.grade : null, lastLabel: l ? (l.label || '') : '',
  };
}

// student: { id, name, school, grade, created_at }
// 삭제 전에 호출 → exam_scores를 읽어 익명 성과 한 줄을 student_outcomes에 insert.
// 실패해도 삭제 흐름을 막지 않도록 항상 {ok} 형태로만 반환(throw 안 함).
export async function snapshotOutcome(env, student) {
  try {
    if (!student || !student.id) return { ok: false, error: 'no student' };
    await ensureOutcomesTable(env);

    let rows = [];
    try {
      const q = await env.DB.prepare(
        "SELECT exam_type, label, grade FROM exam_scores WHERE student_id=? " +
        "ORDER BY (sort_key IS NULL OR sort_key=''), sort_key ASC, id ASC"
      ).bind(student.id).all();
      rows = q.results || [];
    } catch (_) { rows = []; }   // exam_scores 테이블이 아직 없으면 성적은 빈 값으로

    const n = firstLast(rows, '내신');
    const m = firstLast(rows, '모의');
    const now = new Date().toISOString();

    await env.DB.prepare(
      'INSERT INTO student_outcomes ' +
      '(name_masked, school, grade_level, enrolled_at, left_at, ' +
      'naesin_first, naesin_first_label, naesin_last, naesin_last_label, ' +
      'mock_first, mock_first_label, mock_last, mock_last_label, score_count, note, created_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      maskName(student.name), student.school || '', student.grade || '',
      student.created_at || '', now,
      n.first, n.firstLabel, n.last, n.lastLabel,
      m.first, m.firstLabel, m.last, m.lastLabel,
      rows.length, '', now
    ).run();

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
