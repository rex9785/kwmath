// functions/api/_outcomes.js
// ───────────────────────────────────────────────────────────
// 학생 데이터를 '하드 삭제'하기 직전에, 전체 기록을 관리자 아카이브(student_archive)에 보존한다.
// 보존 항목: 실명 · 학부모 전화 · 학생 전화 · 학교 · 학년 · 수강기간 ·
//            전체 성적 · 전체 출결 · 전체 학습기록. (자체 D1, 관리자 전용)
//   + 2026-08-05 — students 행 전체를 profile_json 에 통째로 보존.
//     (희망대학 · 상담메모 · 유입경로 · 학원/반 · 모의등급 · 취약단원 · 선행진도 · 가능요일 …)
//     화면에는 안 뿌린다 — 퇴원생 목록은 이름·학교/학년·전화·기간까지만 보이고,
//     profile_json 은 필요할 때 `GET /api/outcomes?id=N` 으로 꺼내 본다(관우T 요청, 2026-08-05).
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
    'scores_json TEXT, attendance_json TEXT, study_json TEXT, note TEXT, created_at TEXT, ' +
    'hidden INTEGER DEFAULT 0, profile_json TEXT)'
  ).run();
  // 구버전 테이블에서 올라올 때 대비한 컬럼 추가 가드(이미 있으면 catch)
  for (const col of ['parent_phone TEXT', 'student_phone TEXT', 'via TEXT',
                     'attendance_json TEXT', 'study_json TEXT',
                     'attendance_count INTEGER', 'study_count INTEGER', 'study_minutes INTEGER',
                     'hidden INTEGER DEFAULT 0',
                     // 2026-08-05 — students 행 통째 보존. 이 칸이 없으면 희망대학·상담메모·유입경로 등이
                     //   퇴원과 동시에 영구 소실된다(옛 스냅샷은 7칸만 담았다).
                     'profile_json TEXT']) {
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

    // 🧾 2026-08-05 — students 행을 통째로 다시 읽어 profile_json 에 보존한다.
    //   호출측(delete-student.js · account-delete.js)이 넘겨주는 객체는 SELECT 7칸뿐이라,
    //   그것만 담으면 희망대학(target_univ) · 상담메모(notes) · 유입경로(referral/referral_detail) ·
    //   학원/반 · 모의등급 3종 · 취약단원 · 선행진도 · 가능요일 · 매쓰플랫이름 등이
    //   퇴원과 동시에 영구히 사라진다(30일 백업이 지나면 복구 불가였다).
    //   여기서 직접 다시 읽으므로 호출측 SELECT를 건드리지 않아도 전 항목이 남는다.
    //   ⚠️ 두 호출부 모두 'DELETE FROM students' 앞에서 이 함수를 부른다 — 행이 아직 살아 있다.
    //      순서를 바꿔 삭제 뒤에 부르면 profileRow 가 null 이 되어 이 보존이 조용히 무력화된다.
    let profileRow = null;
    try {
      profileRow = await env.DB.prepare('SELECT * FROM students WHERE id=?').bind(id).first();
    } catch (_) { profileRow = null; }
    const P = profileRow || {};   // 재조회 실패 시엔 넘겨받은 값으로만 채운다(아래 || 폴백)

    const parentPhone = student.parentPhone || student.parent_phone || P.parent_phone || '';
    const studentPhone = student.studentPhone || student.student_phone || P.student_phone || '';

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
      'scores_json, attendance_json, study_json, note, created_at, profile_json) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      student.name || P.name || '', parentPhone, studentPhone,
      student.school || P.school || '', student.grade || P.grade || '',
      student.created_at || P.created_at || '', now, (via === 'app' ? 'app' : 'admin'),
      buildSummary(scores), scores.length, attendance.length, study.length, studyMin,
      JSON.stringify(scores), JSON.stringify(attendance), JSON.stringify(study), '', now,
      JSON.stringify(profileRow || student || {})
    ).run();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
