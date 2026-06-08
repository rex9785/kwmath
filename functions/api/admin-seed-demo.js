// POST /api/admin-seed-demo  (admin only)
// ───────────────────────────────────────────────────────────
// 앱 심사용 데모 계정에 샘플 데이터를 채운다. (리뷰어가 빈 화면을 보지 않도록)
//  - 계정: 010-1234-1234 / 비번 5677  (must_change_pw=0)
//  - 학생: '심사데모학생' (student_phone=010-1234-1234, 승인됨)
//  - 리포트·출결·KW스터디·시험성적까지 채움
//
// ⚠️ 안전장치: 오직 위 데모 계정/학생에만 작용. 실제 학생 데이터는 절대 건드리지 않음.
// ⚠️ 재실행 안전(idempotent): 데모 학생의 기존 샘플만 지우고 새로 채운다.
//
// 실행: /admin 로그인 후 콘솔(F12)에서
//   fetch('/api/admin-seed-demo',{method:'POST',credentials:'same-origin'}).then(r=>r.json()).then(console.log)
// ───────────────────────────────────────────────────────────
import { createAccount } from './_auth.js';
import { createStudent, setApprovalStatus, createReport, upsertAttendance, addStudySession } from './_db.js';

const DEMO_PHONE = '010-1234-1234';
const DEMO_PW = '5677';
const DEMO_NAME = '심사데모학생';

function ymd(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

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

    // 1) 데모 계정 (upsert, 비번 변경 강제 안 함)
    const acc = await createAccount(env, DEMO_PHONE, DEMO_PW, false, '[심사용 데모 계정]');
    log.account = acc.ok ? 'ok' : ('fail: ' + acc.error);

    // 2) 데모 학생 (있으면 재사용, 없으면 생성) — 실제 학생과 안 겹치게 고유 이름 사용
    let sid;
    const existing = await env.DB.prepare('SELECT id FROM students WHERE student_phone=? AND name=?')
      .bind(DEMO_PHONE, DEMO_NAME).first();
    if (existing) {
      sid = existing.id;
      await setApprovalStatus(env, sid, '승인');
      log.student = 'reused id=' + sid;
    } else {
      const c = await createStudent(env, {
        name: DEMO_NAME, school: '데모고등학교', grade: '고2',
        studentPhone: DEMO_PHONE, parentPhone: '', parentRelation: '',
        goals: ['내신 대비', '수능 대비'], level: '2등급',
        academy: '대치동 정규반', className: '월수금 A반',
        schoolMathGrade: '2등급', advanceProgress: '수1 완료 · 수2 진행',
        availableDays: ['월', '수', '금'], weakness: '미적분 - 극한/연속',
        dreamUniv: '서울대 공과대학', notes: '[앱 심사용 데모 계정입니다]',
        approvalStatus: '승인',
      });
      if (!c.ok) return Response.json({ error: '데모 학생 생성 실패: ' + c.error }, { status: 500 });
      sid = c.id;
      log.student = 'created id=' + sid;
    }

    // 3) 데모 학생의 기존 샘플 정리 (데모 범위만)
    await env.DB.prepare('DELETE FROM reports WHERE student_name=?').bind(DEMO_NAME).run();
    await env.DB.prepare('DELETE FROM attendance WHERE student_id=?').bind(sid).run();
    await env.DB.prepare('DELETE FROM study_sessions WHERE student_id=?').bind(sid).run();
    await env.DB.prepare('DELETE FROM exam_scores WHERE student_id=?').bind(sid).run();

    // 4) 리포트 3개 (최근 금요일 기준)
    const now = new Date();
    const reports = [
      { d: 14, content: '극한의 정의와 좌·우극한을 백지복습으로 점검. 개념 정착 양호.', homework: '워크북 p.32~38 / 주간지 1회', notes: '응용문제 풀이 속도 개선 필요' },
      { d: 7, content: '연속의 조건(3가지)과 사잇값 정리 적용 연습. 그래프 해석 강화.', homework: '기출 12문항 / 오답노트', notes: '실수 줄이기 — 부호 처리 주의' },
      { d: 1, content: '미분계수와 도함수 정의. 접선의 방정식 유형 정리.', homework: '워크북 p.40~46', notes: '심화 1문항 추가 도전' },
    ];
    let rCnt = 0;
    for (const rp of reports) {
      const dt = new Date(now); dt.setUTCDate(dt.getUTCDate() - rp.d);
      const date = ymd(dt);
      const res = await createReport(env, {
        studentName: DEMO_NAME, phone4: '1234',
        title: DEMO_NAME + ' - ' + date + ' 수업 리포트',
        date, content: rp.content, homework: rp.homework, notes: rp.notes, school: '대치동 정규반',
      });
      if (res.ok) rCnt++;
    }
    log.reports = rCnt;

    // 5) 출결 — 최근 4주 월·수·금 (숙제 완료율 포함)
    const dayset = { 1: true, 3: true, 5: true }; // 월수금
    let aCnt = 0;
    for (let back = 26; back >= 0; back--) {
      const dt = new Date(now); dt.setUTCDate(dt.getUTCDate() - back);
      if (!dayset[dt.getUTCDay()]) continue;
      const hw = 80 + ((back * 7) % 21); // 80~100 사이 변동
      const status = (back === 12) ? '지각' : '출석';
      const res = await upsertAttendance(env, sid, ymd(dt), { status, homework: Math.min(100, hw), method: '대면' });
      if (res.ok) aCnt++;
    }
    log.attendance = aCnt;

    // 6) KW스터디 세션 5개
    let sCnt = 0;
    for (let i = 0; i < 5; i++) {
      const dt = new Date(now); dt.setUTCDate(dt.getUTCDate() - (i * 3 + 1));
      const date = ymd(dt);
      const start = new Date(dt); start.setUTCHours(18, 0, 0, 0);
      const mins = 50 + i * 8;
      const end = new Date(start.getTime() + mins * 60000);
      const res = await addStudySession(env, sid, {
        id: 'demo-' + date + '-' + i, startedAt: start.toISOString(), endedAt: end.toISOString(),
        minutes: mins, date, awayCount: i % 3, awayMs: (i % 3) * 40000,
      });
      if (res.ok) sCnt++;
    }
    log.study = sCnt;

    // 7) 시험 성적 — 내신 4 + 모의 3
    const scores = [
      ['내신', '고1', '1학기 중간', '2025-04', 58, 3],
      ['내신', '고1', '1학기 기말', '2025-07', 69, 2],
      ['내신', '고1', '2학기 중간', '2025-10', 75, 2],
      ['내신', '고1', '2학기 기말', '2025-12', 85, 1],
      ['모의', '고2', '3월', '2026-03', 80, 2],
      ['모의', '고2', '6월', '2026-06', 84, 2],
      ['모의', '고2', '9월', '2026-09', 88, 1],
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
      message: '데모 데이터 채움 완료. 010-1234-1234 / 5677 로 로그인해 확인하세요.',
      studentId: String(sid), detail: log,
    });
  } catch (e) {
    return Response.json({ error: '시드 실패: ' + (e && e.message || e), detail: log }, { status: 500 });
  }
}
