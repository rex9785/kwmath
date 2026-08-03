// POST /api/account-delete
// ───────────────────────────────────────────────────────────
// 로그인한 사용자(학부모/학생)가 '본인 계정'을 직접 삭제한다.
// Apple App Store 심사지침 5.1.1(v): 계정 생성이 가능한 앱은 '인앱 계정 삭제'를 제공해야 함.
//   → 이 엔드포인트가 그 요건을 충족한다. (관리자용 delete-student.js와 별개: 이건 사용자 토큰 인증)
//
// 인증: Authorization: Bearer <userToken>
// 동작: 그 전화번호(계정)에 연결된 모든 학생 + 그 학생의 출결/공부/성적/리포트(D1) +
//       R2의 reports/{이름}/ · test-results/{이름}/ 파일 + 계정(accounts) 삭제, 토큰 폐기.
//       반 공용 자료(class/...)는 사용자 개인정보가 아니므로 건드리지 않는다.
// ───────────────────────────────────────────────────────────
import { requireAuth, revokeToken, revokeTokensForPhone } from './_auth.js';
import { safeError } from './_errors.js';
import { snapshotArchive } from './_outcomes.js';
import { logAudit } from './_auditlog.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용됩니다.' }, { status: 405 });

  const auth = await requireAuth(env, request);
  if (!auth.ok) return auth.response;
  const phone = auth.phone;

  const result = {
    phone,
    students_deleted: 0, attendance_deleted: 0, study_deleted: 0,
    scores_deleted: 0, reports_deleted: 0, files_deleted: 0, account_deleted: 0,
    outcomes_saved: 0,
    errors: [],
  };

  try {
    const { results: studs } = await env.DB.prepare(
      'SELECT id, name, school, grade, created_at, parent_phone, student_phone FROM students WHERE parent_phone = ? OR student_phone = ?'
    ).bind(phone, phone).all();

    const names = new Set();
    for (const s of (studs || [])) {
      if (s.name) names.add(s.name);
      // ── 앱(포털)에서는 아래에서 전부 삭제하되, 그 전에 관리자 아카이브에는 전체 기록 보존(via='app') ──
      try {
        const snap = await snapshotArchive(env, s, 'app');
        if (snap.ok) result.outcomes_saved += 1;
      } catch (e) { /* 보존 실패는 삭제를 막지 않음 */ }
      try {
        const d = await env.DB.prepare('DELETE FROM attendance WHERE student_id = ?').bind(s.id).run();
        result.attendance_deleted += (d.meta && d.meta.changes) || 0;
      } catch (e) { result.errors.push('attendance:' + s.id); }
      try {
        const d = await env.DB.prepare('DELETE FROM study_sessions WHERE student_id = ?').bind(s.id).run();
        result.study_deleted += (d.meta && d.meta.changes) || 0;
      } catch (e) { result.errors.push('study:' + s.id); }
      try {
        const d = await env.DB.prepare('DELETE FROM exam_scores WHERE student_id = ?').bind(s.id).run();
        result.scores_deleted += (d.meta && d.meta.changes) || 0;
      } catch (e) { /* exam_scores 테이블이 없을 수 있음 — 무시 */ }
      try {
        const d = await env.DB.prepare('DELETE FROM students WHERE id = ?').bind(s.id).run();
        result.students_deleted += (d.meta && d.meta.changes) || 0;
      } catch (e) { result.errors.push('student:' + s.id); }
    }

    // 리포트(D1) + R2 개인 파일 (이름 기준)
    const 삭제된파일키 = [];
    const 리포트아카이브 = [];
    for (const name of names) {
      // 🛡️ 2026-07-31 — 관리자 삭제(delete-student.js)는 리포트 행을 지우기 전에
      //    R2 archive/reports/{이름}/{시각}.json 으로 통째 보존한다. 여기(앱 자가탈퇴)만 그게 없어서
      //    같은 데이터가 흔적 없이 사라지고 있었다 → 같은 보존을 넣는다.
      //    ※ 관리자 경로와 다른 점: 애플 5.1.1은 계정 삭제를 보장해야 하므로 **보존 실패해도 삭제는 계속**한다.
      try {
        const { results: repRows } = await env.DB.prepare('SELECT * FROM reports WHERE student_name = ?').bind(name).all();
        if ((repRows || []).length) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const akey = 'archive/reports/' + name + '/' + stamp + '_app.json';
          await env.BUCKET.put(akey, JSON.stringify({
            archivedAt: new Date().toISOString(), via: 'app-account-delete',
            student_name: name, count: repRows.length, rows: repRows,
          }), { httpMetadata: { contentType: 'application/json' } });
          리포트아카이브.push({ 이름: name, 키: akey, 건수: repRows.length });
        }
      } catch (e) { result.errors.push('report 아카이브 실패:' + name); }

      try {
        const rd = await env.DB.prepare('DELETE FROM reports WHERE student_name = ?').bind(name).run();
        result.reports_deleted += (rd.meta && rd.meta.changes) || 0;
      } catch (e) { result.errors.push('reports:' + name); }

      for (const prefix of ['reports/' + name + '/', 'test-results/' + name + '/']) {
        // ⚠️ 예전엔 limit:500 으로 한 번만 훑고 끝냈다 → 파일이 500개를 넘으면 나머지가 조용히 남고
        //    응답은 "삭제 완료"로 나갔다. cursor 로 끝까지 돈다(안전장치로 50바퀴 = 25,000개 상한).
        try {
          let cursor = undefined;
          for (let guard = 0; guard < 50; guard++) {
            const listed = await env.BUCKET.list({ prefix, limit: 500, cursor });
            for (const obj of (listed.objects || [])) {
              try {
                await env.BUCKET.delete(obj.key);
                result.files_deleted++;
                if (삭제된파일키.length < 200) 삭제된파일키.push(obj.key);   // 로그 1건이 터지지 않게 상한
              } catch (e) { result.errors.push('file:' + obj.key); }
            }
            if (!listed.truncated) break;
            cursor = listed.cursor;
          }
        } catch (e) { result.errors.push('list:' + prefix); }
      }
    }

    // 계정 삭제 (이 전화번호)
    try {
      const ad = await env.DB.prepare('DELETE FROM accounts WHERE phone = ?').bind(phone).run();
      result.account_deleted += (ad.meta && ad.meta.changes) || 0;
    } catch (e) { result.errors.push('account'); }

    // 로그인 토큰 폐기
    // 🔑 2026-08-03 (§11-12) — 예전엔 **지금 이 기기의 토큰 1개만** 지웠다. 그래서 같은 번호로
    //   다른 기기(태블릿·가족 폰)에 로그인해 둔 게 있으면 계정을 지웠는데도 **최대 30일** 그대로 열려 있었다
    //   (verifyToken 은 만료만 보고 accounts 를 다시 안 본다). 이제 그 번호의 토큰을 전부 끊는다.
    //   계정 자체를 지우는 경로이므로 형제 검사는 하지 않는다 — 이 번호로는 아무도 못 들어와야 맞다.
    let 폐기된토큰수 = 0;
    try { 폐기된토큰수 = await revokeTokensForPhone(env, phone); } catch (e) { /* 비치명적 */ }
    try { await revokeToken(env, auth.token); } catch (e) { /* 색인이 없던 옛 토큰 대비 — 내 것은 확실히 지운다 */ }

    // 🛡️ 2026-07-31 — 푸시 등록도 같이 지운다.
    //   계정을 지웠는데 이 번호로 등록된 기기 토큰(R2 fcm-tokens/·push-subs/)이 남아 있으면
    //   ① 탈퇴한 번호 앞으로 알림이 계속 시도되고 ② 토큰·기기명 같은 개인정보가 남는다.
    //   애플 5.1.1(계정 삭제) 취지에도 어긋난다.
    const 푸시삭제 = [];
    for (const k of ['fcm-tokens/' + encodeURIComponent(phone) + '.json',
                     'push-subs/' + encodeURIComponent(phone) + '.json']) {
      try {
        const had = await env.BUCKET.head(k);
        if (had) { await env.BUCKET.delete(k); 푸시삭제.push(k); }
      } catch (e) { result.errors.push('push:' + k); }
    }

    // 🔴 되돌릴 수 없는 삭제 — 무엇이 사라졌는지 전부 남긴다.
    //   행위자는 미들웨어가 아니라 **본인(포털 토큰의 전화번호)**이다 → actor 를 직접 넘긴다.
    await logAudit(env, request, {
      action: 'account.selfdelete',
      actor: phone, actorRole: 'student',
      actorName: ((studs || [])[0] && (studs || [])[0].name) || '',
      target: phone,
      targetName: Array.from(names).join(', ').slice(0, 60),
      summary: '앱에서 본인 계정 삭제(탈퇴) — 학생 ' + result.students_deleted + '명 · 출결 ' + result.attendance_deleted
        + '건 · 학습 ' + result.study_deleted + '건 · 성적 ' + result.scores_deleted + '건 · 리포트 '
        + result.reports_deleted + '건 · 파일 ' + result.files_deleted + '개 삭제 (복구 불가)',
      detail: {
        전화번호: phone,
        지워진학생: (studs || []).map((s) => ({
          id: s.id, 이름: s.name || '', 학교: s.school || '', 학년: s.grade || '',
          등록일: s.created_at || '', 학부모폰: s.parent_phone || '', 학생폰: s.student_phone || '',
        })),
        건수: {
          학생: result.students_deleted, 출결: result.attendance_deleted, 학습: result.study_deleted,
          성적: result.scores_deleted, 리포트: result.reports_deleted, 파일: result.files_deleted,
          계정: result.account_deleted,
        },
        퇴원기록보존: result.outcomes_saved,      // student_archive 에 via='app' 으로 남은 건수
        리포트아카이브: 리포트아카이브,            // R2 archive/reports/... (복원 근거)
        삭제된파일키: 삭제된파일키,
        파일키일부만저장: result.files_deleted > 200,
        푸시등록삭제: 푸시삭제,
        로그인토큰폐기: 폐기된토큰수 + '개 (이 번호로 로그인해 둔 모든 기기)',
        오류: result.errors,
      },
    });

    return Response.json({ ok: true, ...result });
  } catch (e) {
    return safeError(e, env, { message: '계정 삭제 중 오류가 발생했습니다.' });
  }
}
