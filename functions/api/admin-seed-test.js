// POST /api/admin-seed-test  (admin only)
// ───────────────────────────────────────────────────────────
// 설명회 '체험 계정'(010-0000-0000)에 샘플 데이터를 채운다.
//  - 계정/학생: 010-0000-0000  (관우T가 미리 만들어 둔 체험 계정)
//  - 2026년 5월 출결(월·수·금: 지각 1·결석 1 외 전부 출석), 숙제 평균 ~80%
//  - 5월 거의 매일(일요일 제외) 공부시간 2~4시간(KW-Study), 리포트 3개, 시험성적 5개
//
// ⚠️ 안전장치: 오직 010-0000-0000 학생에만 작용. 다른 학생 데이터는 절대 건드리지 않음.
// ⚠️ 재실행 안전(idempotent): 이 학생의 기존 샘플만 지우고 새로 채운다.
//
// 실행: /admin 로그인 후 콘솔(F12)에서
//   fetch('/api/admin-seed-test',{method:'POST',credentials:'same-origin'}).then(r=>r.json()).then(console.log)
// ───────────────────────────────────────────────────────────
import { createStudent, setApprovalStatus, createReport, upsertAttendance, addStudySession } from './_db.js';

const TEST_PHONE = '010-0000-0000';
const TEST_NAME  = '체험학생';

// 2026년 5월 월·수·금 출결 (status / 숙제완료율%). 결석일은 숙제 0.
// 지각: 5/13 · 결석: 5/22 · 나머지 출석. 출석/지각 숙제 평균 ≈ 80%.
const MAY_ATTEND = [
  ['2026-05-01', '출석', 80],
  ['2026-05-04', '출석', 90],
  ['2026-05-06', '출석', 75],
  ['2026-05-08', '출석', 85],
  ['2026-05-11', '출석', 70],
  ['2026-05-13', '지각', 75],
  ['2026-05-15', '출석', 90],
  ['2026-05-18', '출석', 80],
  ['2026-05-20', '출석', 60],
  ['2026-05-22', '결석', 0],
  ['2026-05-25', '출석', 85],
  ['2026-05-27', '출석', 95],
  ['2026-05-29', '출석', 80],
];

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용' }, { status: 405 });
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증 실패' }, { status: 401 });

  const log = {};
  try {
    // exam_scores 테이블 보장
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS exam_scores (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, ' +
      'exam_type TEXT NOT NULL, grade_level TEXT, label TEXT NOT NULL, sort_key TEXT, raw_score INTEGER, grade INTEGER, ' +
      'exam_date TEXT, memo TEXT, created_at TEXT, updated_at TEXT)'
    ).run();

    // 1) 체험 학생 — 010-0000-0000 으로 등록된 학생을 그대로 사용. 없으면 생성.
    let sid, name;
    const existing = await env.DB.prepare('SELECT id, name FROM students WHERE student_phone=? OR parent_phone=? ORDER BY id LIMIT 1')
      .bind(TEST_PHONE, TEST_PHONE).first();
    if (existing) {
      sid = existing.id;
      name = existing.name || TEST_NAME;
      await setApprovalStatus(env, sid, '승인');
      log.student = 'reused id=' + sid + ' name=' + name;
    } else {
      const c = await createStudent(env, {
        name: TEST_NAME, school: '세정고등학교', grade: '고1',
        studentPhone: TEST_PHONE, parentPhone: '', parentRelation: '',
        goals: ['내신 대비', '수능 대비'], level: '3등급',
        academy: '세정학원', className: '고1 공통수학2 선행반',
        schoolMathGrade: '3등급', advanceProgress: '공통수학1 완료 · 공통수학2 진행',
        availableDays: ['월', '수', '금'], weakness: '도형의 방정식 - 원과 직선',
        dreamUniv: '', notes: '[설명회 체험용 계정]',
        approvalStatus: '승인',
      });
      if (!c.ok) return Response.json({ error: '체험 학생 생성 실패: ' + c.error }, { status: 500 });
      sid = c.id; name = TEST_NAME;
      log.student = 'created id=' + sid;
    }

    // 2) 이 학생의 기존 샘플 정리 (체험 범위만)
    await env.DB.prepare('DELETE FROM reports WHERE student_name=?').bind(name).run();
    await env.DB.prepare('DELETE FROM attendance WHERE student_id=?').bind(sid).run();
    await env.DB.prepare('DELETE FROM study_sessions WHERE student_id=?').bind(sid).run();
    await env.DB.prepare('DELETE FROM exam_scores WHERE student_id=?').bind(sid).run();

    // 3) 출결 — 5월 월·수·금 (숙제 완료율 포함)
    let aCnt = 0;
    for (const [date, status, hw] of MAY_ATTEND) {
      const updates = { status, method: '대면' };
      if (status !== '결석') updates.homework = hw;
      const r = await upsertAttendance(env, sid, date, updates);
      if (r.ok) aCnt++;
    }
    log.attendance = aCnt;

    // 4) KW-Study — 5월 거의 매일(일요일 제외) 2~4시간
    let sCnt = 0;
    for (let d = 1; d <= 31; d++) {
      const dd = String(d).padStart(2, '0');
      const dt = new Date(Date.UTC(2026, 4, d));        // 2026-05-d (UTC)
      if (dt.getUTCDay() === 0) continue;               // 일요일 휴식
      const minutes = 120 + ((d * 37) % 121);           // 120~240분 (2~4시간)
      const start = new Date(Date.UTC(2026, 4, d, 10, 0, 0)); // 19:00 KST
      const end = new Date(start.getTime() + minutes * 60000);
      const r = await addStudySession(env, sid, {
        id: 'test-2026-05-' + dd, startedAt: start.toISOString(), endedAt: end.toISOString(),
        minutes, date: '2026-05-' + dd, awayCount: d % 3, awayMs: (d % 3) * 40000,
      });
      if (r.ok) sCnt++;
    }
    log.study = sCnt;

    // 5) 리포트 3개 (5월)
    const reports = [
      { date: '2026-05-08', content: '평면좌표와 두 점 사이의 거리. 중2 닮음비를 이용한 좌표 해석으로 계산을 단축하는 풀이 정리.', homework: '워크북 p.12~18 / 주간지 1회', notes: '계산보다 그림 먼저 — 습관 잡는 중' },
      { date: '2026-05-15', content: '직선의 방정식과 평행·수직 조건. 기울기의 의미를 인과로 설명하고 적용.', homework: '기출 14문항 / 오답노트', notes: '조건 해석 속도 향상' },
      { date: '2026-05-29', content: '원의 방정식 도입. 원과 직선의 위치 관계를 그림 중심으로 직관화.', homework: '워크북 p.24~30', notes: '준킬러 1문항 추가 도전' },
    ];
    let rCnt = 0;
    for (const rp of reports) {
      const res = await createReport(env, {
        studentName: name, phone4: TEST_PHONE.slice(-4),
        title: name + ' - ' + rp.date + ' 수업 리포트',
        date: rp.date, content: rp.content, homework: rp.homework, notes: rp.notes,
        school: '세정학원 · 고1 공통수학2 선행반',
      });
      if (res.ok) rCnt++;
    }
    log.reports = rCnt;

    // 6) 시험 성적 — 내신 3 + 모의 2 (상승 추세)
    const scores = [
      ['내신', '고1', '1학기 중간', '2026-04', 62, 4],
      ['모의', '고1', '3월', '2026-03', 70, 3],
      ['모의', '고1', '5월', '2026-05', 78, 2],
      ['내신', '고1', '1학기 기말', '2026-07', 84, 2],
      ['모의', '고1', '6월', '2026-06', 82, 2],
    ];
    const nowIso = new Date().toISOString();
    let scCnt = 0;
    for (const [type, gl, label, sk, raw, gr] of scores) {
      const res = await env.DB.prepare(
        'INSERT INTO exam_scores (student_id, exam_type, grade_level, label, sort_key, raw_score, grade, exam_date, memo, created_at, updated_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(sid, type, gl, label, sk, raw, gr, '', '', nowIso, nowIso).run();
      if (res.success !== false) scCnt++;
    }
    log.scores = scCnt;

    return Response.json({
      ok: true,
      message: '체험 계정 데이터 채움 완료. 010-0000-0000 / 0000 으로 로그인해 확인하세요.',
      studentId: String(sid), detail: log,
    });
  } catch (e) {
    return Response.json({ error: '시드 실패: ' + (e && e.message || e), detail: log }, { status: 500 });
  }
}
