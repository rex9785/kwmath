// POST /api/admin-seed-demo  (admin only)
// ───────────────────────────────────────────────────────────
// 앱 심사용 데모 계정에 샘플 데이터를 채운다. (리뷰어가 빈 화면을 보지 않도록)
//  - 계정: 010-1234-1234 / 비번 1234  (must_change_pw=0)
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
import { logAudit } from './_auditlog.js';

const DEMO_PHONE = '010-1234-1234';
const DEMO_PW = '1234';
const DEMO_NAME = '심사데모학생';

function ymd(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용' }, { status: 405 });
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) {
    await logAudit(env, request, {
      action: 'admin.seed.demo.denied',
      target: DEMO_PHONE,
      summary: '심사용 데모 데이터 채우기 인증 실패 — 거부(401)',
      detail: {
        결과: '거부(401). 아무 데이터도 바뀌지 않았다.',
        사유: env.ADMIN_PASSWORD ? '관리자 비밀번호 불일치' : '서버에 ADMIN_PASSWORD 미설정',
        효과: '없음.',
        비고: '입력된 토큰 원문·데모 계정 비밀번호는 기록하지 않는다.',
      },
    });
    return Response.json({ error: '인증 실패' }, { status: 401 });
  }

  const log = {};
  // 📓 감사로그용 — 이 endpoint 한 번이 수십 행을 지우고 다시 넣는다. 실행 1회 = 로그 1건으로 모은다.
  const 시작 = Date.now();
  const 지운기존 = { 리포트: 0, 출결: 0, 학습: 0, 성적: 0, 잔재학생리포트: 0 };
  const 지운잔재학생 = [];
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

    // 2) 데모 학생 — 계정(010-1234-1234)이 기본으로 보는 학생(가장 낮은 id)을 그대로 사용.
    //    없을 때만 새로 만든다. (중복 학생을 만들어 데이터가 다른 학생에 들어가던 문제 방지)
    let sid, demoName;
    const existing = await env.DB.prepare('SELECT id, name FROM students WHERE student_phone=? OR parent_phone=? ORDER BY id LIMIT 1')
      .bind(DEMO_PHONE, DEMO_PHONE).first();
    if (existing) {
      sid = existing.id;
      demoName = existing.name || DEMO_NAME;
      await setApprovalStatus(env, sid, '승인');
      log.student = 'reused id=' + sid + ' name=' + demoName;
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
      if (!c.ok) {
        await logAudit(env, request, {
          action: 'admin.seed.demo.fail',
          target: DEMO_PHONE, targetName: DEMO_NAME,
          summary: '심사용 데모 데이터 채우기 중단 — 데모 학생 생성 실패: ' + String(c.error || '').slice(0, 100),
          detail: {
            단계: '데모 학생 생성',
            오류: String(c.error || ''),
            계정처리: log.account || '',
            효과: '데모 학생이 만들어지지 않아 샘플 데이터도 채워지지 않았다. 기존 학생 데이터는 건드리지 않았다.',
            비고: '데모 계정 비밀번호는 기록하지 않는다.',
          },
        });
        return Response.json({ error: '데모 학생 생성 실패: ' + c.error }, { status: 500 });
      }
      sid = c.id;
      demoName = DEMO_NAME;
      log.student = 'created id=' + sid;
    }

    // 2.5) 첫 시도 때 잘못 만들어진 '심사데모학생' 잔재가 있으면 정리 (선택된 학생 sid는 제외)
    try {
      const strays = await env.DB.prepare('SELECT id FROM students WHERE (student_phone=? OR parent_phone=?) AND name=? AND id<>?')
        .bind(DEMO_PHONE, DEMO_PHONE, DEMO_NAME, sid).all();
      let cleaned = 0;
      for (const row of (strays.results || [])) {
        await env.DB.prepare('DELETE FROM study_sessions WHERE student_id=?').bind(row.id).run();
        await env.DB.prepare('DELETE FROM attendance WHERE student_id=?').bind(row.id).run();
        await env.DB.prepare('DELETE FROM exam_scores WHERE student_id=?').bind(row.id).run();
        await env.DB.prepare('DELETE FROM students WHERE id=?').bind(row.id).run();
        지운잔재학생.push(row.id);
        cleaned++;
      }
      if (demoName !== DEMO_NAME) {
        const r = await env.DB.prepare('DELETE FROM reports WHERE student_name=?').bind(DEMO_NAME).run();
        지운기존.잔재학생리포트 = (r.meta && r.meta.changes) || 0;
      }
      log.cleanedStrays = cleaned;
    } catch (e) { log.cleanedStrays = 'err:' + (e && e.message); }

    // 3) 데모 학생의 기존 샘플 정리 (데모 범위만)
    //    🔎 지운 행 수는 run()이 그대로 돌려준다 — 조회를 더 하지 않고 "무엇이 몇 건 사라졌는지"를 확보한다.
    //       (이 학생에게 진짜 데이터가 들어 있었다면 이 숫자가 그 증거가 된다.)
    const d1 = await env.DB.prepare('DELETE FROM reports WHERE student_name=?').bind(demoName).run();
    const d2 = await env.DB.prepare('DELETE FROM attendance WHERE student_id=?').bind(sid).run();
    const d3 = await env.DB.prepare('DELETE FROM study_sessions WHERE student_id=?').bind(sid).run();
    const d4 = await env.DB.prepare('DELETE FROM exam_scores WHERE student_id=?').bind(sid).run();
    지운기존.리포트 = (d1.meta && d1.meta.changes) || 0;
    지운기존.출결   = (d2.meta && d2.meta.changes) || 0;
    지운기존.학습   = (d3.meta && d3.meta.changes) || 0;
    지운기존.성적   = (d4.meta && d4.meta.changes) || 0;

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
        studentName: demoName, phone4: '1234',
        title: demoName + ' - ' + date + ' 수업 리포트',
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
      const hwBuckets = [100, 75, 100, 100, 50, 75, 100, 75]; // 숙제 완료율은 0/25/50/75/100 버킷만
      const hw = hwBuckets[back % hwBuckets.length];
      const status = (back === 12) ? '지각' : '출석';
      const res = await upsertAttendance(env, sid, ymd(dt), { status, homework: hw, method: '대면' });
      if (res.ok) aCnt++;
    }
    log.attendance = aCnt;

    // 6) KW스터디 세션 — 오늘·이번주 포함(반 랭킹에서 꼴등 안 보이게)
    const sOffsets = [0, 1, 3, 5, 8];   // 오늘 · 어제 · 이번주 포함
    const sMins    = [45, 58, 66, 74, 82];
    let sCnt = 0;
    for (let i = 0; i < sOffsets.length; i++) {
      const dt = new Date(now); dt.setUTCDate(dt.getUTCDate() - sOffsets[i]);
      const date = ymd(dt);
      const start = new Date(dt); start.setUTCHours(13, 0, 0, 0);
      const mins = sMins[i];
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

    // 🔴 실행 1회 = 로그 1건. (리포트 3 + 출결 ~12 + 학습 5 + 성적 7 을 건별로 남기지 않는다)
    //    핵심은 "어느 학생 위에 덮어썼고, 그 과정에서 기존 몇 건이 지워졌나".
    const 실제학생덮어씀 = !!existing && (existing.name || '') !== '' && (existing.name || '') !== DEMO_NAME;
    await logAudit(env, request, {
      action: 'admin.seed.demo',
      target: String(sid), targetName: demoName,
      summary: '심사용 데모 데이터 채움 [' + demoName + '(id ' + sid + ')] — 기존 리포트 ' + 지운기존.리포트
        + ' · 출결 ' + 지운기존.출결 + ' · 학습 ' + 지운기존.학습 + ' · 성적 ' + 지운기존.성적
        + '건 삭제 후 리포트 ' + log.reports + ' · 출결 ' + log.attendance + ' · 학습 ' + log.study
        + ' · 성적 ' + log.scores + '건 삽입'
        + (실제학생덮어씀 ? ' ⚠️ 데모 이름이 아닌 학생 위에 덮어씀' : ''),
      detail: {
        데모전화번호: DEMO_PHONE,
        학생: existing
          ? { 처리: '기존 학생 재사용', id: sid, 이름: demoName, 승인상태: '승인으로 변경' }
          : { 처리: '새로 생성', id: sid, 이름: demoName },
        계정: log.account || '',
        지운기존데이터: 지운기존,
        정리한잔재학생: { 건수: log.cleanedStrays, 학생id: 지운잔재학생 },
        새로넣은건수: { 리포트: log.reports, 출결: log.attendance, 학습: log.study, 성적: log.scores },
        걸린시간초: Math.round((Date.now() - 시작) / 100) / 10,
        효과: '이 학생(id ' + sid + ')의 리포트·출결·학습시간·시험성적이 통째로 데모 샘플로 바뀐다. '
          + '학부모·학생 포털과 반 랭킹에 이 가짜 수치가 그대로 보인다.'
          + (실제학생덮어씀
            ? ' ⚠️ 재사용된 학생 이름이 「' + demoName + '」로 데모용(' + DEMO_NAME + ')이 아니다 — 실제 학생일 수 있으니 위 「지운기존데이터」 건수를 반드시 확인할 것.'
            : ''),
        비고: '데모 계정 비밀번호는 기록하지 않는다. 리포트 삭제는 학생 id가 아니라 이름 기준이라 동명이인이 있으면 함께 지워진다.',
      },
    });

    return Response.json({
      ok: true,
      message: '데모 데이터 채움 완료. 010-1234-1234 / 1234 로 로그인해 확인하세요.',
      studentId: String(sid), detail: log,
    });
  } catch (e) {
    // 중간에 터졌다 = 지우기만 하고 다시 못 채운 상태일 수 있다. 어디까지 갔는지가 유일한 단서다.
    await logAudit(env, request, {
      action: 'admin.seed.demo.fail',
      target: DEMO_PHONE, targetName: DEMO_NAME,
      summary: '심사용 데모 데이터 채우기 중단(오류) — ' + String((e && e.message) || e).slice(0, 120),
      detail: {
        오류: String((e && e.message) || e),
        진행상황: log,
        지운기존데이터: 지운기존,
        정리한잔재학생id: 지운잔재학생,
        걸린시간초: Math.round((Date.now() - 시작) / 100) / 10,
        효과: '⚠️ 기존 샘플만 지우고 새 데이터를 못 채운 상태일 수 있다. 위 「지운기존데이터」 건수만큼은 이미 사라졌다.',
        비고: '데모 계정 비밀번호는 기록하지 않는다.',
      },
    });
    return Response.json({ error: '시드 실패: ' + (e && e.message || e), detail: log }, { status: 500 });
  }
}
