// functions/api/_outcomes.js
// ───────────────────────────────────────────────────────────
// 학생 데이터를 '하드 삭제'하기 직전에, 전체 기록을 관리자 아카이브(student_archive)에 보존한다.
// 보존 항목: 실명 · 학부모 전화 · 학생 전화 · 학교 · 학년 · 수강기간 ·
//            전체 성적 · 전체 출결 · 전체 학습기록. (자체 D1, 관리자 전용)
//
// via 구분:
//   'admin' = 관리자가 퇴원 처리(delete-student.js) — 학원 자체 기록
//   'app'   = 학생이 앱에서 직접 회원탈퇴(account-delete.js) — 앱(포털)에서는 삭제되지만 관리자 기록엔 남김
//             (참고: Apple 5.1.1(v)의 '자가탈퇴=삭제' 원칙과는 다른 운영 — 서버 DB는 심사 대상 아님)
//
// ⚠️ 실명·전화 포함 = 명백한 개인정보. 내부(관리자) 보관은 학원 운영상 가능하나,
//    외부 공개·홍보 활용 시에는 건별 동의(미성년은 보호자 동의)가 필요. 동의는 운영자가 직접 처리.
// ───────────────────────────────────────────────────────────

// 사람이 한눈에 읽는 성적 요약: "내신 3→1 · 모의 4→2"
function buildSummary(scores) {
  function fl(type) {
    const v = scores.filter(s => s.examType === type && s.grade != null);
    if (!v.length) return null;
    const a = v[0].grade, b = v[v.length - 1].grade;
    return (a === b) ? (type + ' ' + a + '등급') : (type + ' ' + a + '→' + b);
  }
  return [fl('내신'), fl('모의')].filter(Boolean).join(' · ');
}

// exam_scores를 시간순으로 읽어 성적 배열로
async function readScores(env, studentId) {
  let rows = [];
  try {
    const q = await env.DB.prepare(
      "SELECT exam_type, grade_level, label, sort_key, raw_score, grade, exam_date " +
      "FROM exam_scores WHERE student_id=? " +
      "ORDER BY (sort_key IS NULL OR sort_key=''), sort_key ASC, id ASC"
    ).bind(studentId).all();
    rows = q.results || [];
  } catch (_) { rows = []; }
  return rows.map(r => ({
    examType: r.exam_type || '', gradeLevel: r.grade_level || '', label: r.label || '',
    rawScore: (r.raw_score === null || r.raw_score === undefined) ? null : r.raw_score,
    grade: (r.grade === null || r.grade === undefined) ? null : r.grade,
    examDate: r.exam_date || '',
  }));
}

export async function ensureArchiveTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS student_archive (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'name TEXT, parent_phone TEXT, student_phone TEXT, school TEXT, grade_level TEXT, ' +
    'enrolled_at TEXT, left_at TEXT, via TEXT, summary TEXT, ' +
    'score_count INTEGER, attendance_count INTEGER, study_count INTEGER, study_minutes INTEGER, ' +
    'scores_json TEXT, attendance_json TEXT, study_json TEXT, note TEXT, created_at TEXT)'
  ).run();
  // 구버전 테이블에서 올라올 때 대비한 컬럼 추가 가드(이미 있으면 catch)
  for (const col of ['parent_phone TEXT', 'student_phone TEXT', 'via TEXT',
                     'attendance_json TEXT', 'study_json TEXT',
                     'attendance_count INTEGER', 'study_count INTEGER', 'study_minutes INTEGER']) {
    try { await env.DB.prepare('ALTER TABLE student_archive ADD COLUMN ' + col).run(); } catch (_) {}
  }
}

// 삭제 전에 호출 → 학생의 성적·출결·학습 전체를 읽어 실명·전화 그대로 보관.
// student: { id, name, school, grade, created_at, parentPhone|parent_phone, studentPhone|student_phone }
// via: 'admin' | 'app'
export async function snapshotArchive(env, student, via) {
  try {
    if (!student || !student.id) return { ok: false, error: 'no student' };
    await ensureArchiveTable(env);
    const id = student.id;
    const parentPhone = student.parentPhone || student.parent_phone || '';
    const studentPhone = student.studentPhone || student.student_phone || '';

    const scores = await readScores(env, id);

    let attRows = [];
    try {
      const q = await env.DB.prepare(
        'SELECT date, status, homework, homework_note, note, method FROM attendance WHERE student_id=? ORDER BY date ASC'
      ).bind(id).all();
      attRows = q.results || [];
    } catch (_) { attRows = []; }
    const attendance = attRows.map(r => ({
      date: r.date || '', status: r.status || '',
      homework: (r.homework === null || r.homework === undefined) ? null : r.homework,
      note: r.note || r.homework_note || '', method: r.method || '',
    }));

    let stRows = [];
    try {
      const q = await env.DB.prepare(
        'SELECT started_at, ended_at, minutes, date FROM study_sessions WHERE student_id=? ORDER BY started_at ASC'
      ).bind(id).all();
      stRows = q.results || [];
    } catch (_) { stRows = []; }
    const study = stRows.map(r => ({ date: r.date || '', minutes: Number(r.minutes) || 0, startedAt: r.started_at || '' }));
    const studyMin = study.reduce((a, b) => a + (b.minutes || 0), 0);

    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO student_archive ' +
      '(name, parent_phone, student_phone, school, grade_level, enrolled_at, left_at, via, summary, ' +
      'score_count, attendance_count, study_count, study_minutes, ' +
      'scores_json, attendance_json, study_json, note, created_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      student.name || '', parentPhone, studentPhone, student.school || '', student.grade || '',
      student.created_at || '', now, (via === 'app' ? 'app' : 'admin'),
      buildSummary(scores), scores.length, attendance.length, study.length, studyMin,
      JSON.stringify(scores), JSON.stringify(attendance), JSON.stringify(study), '', now
    ).run();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
