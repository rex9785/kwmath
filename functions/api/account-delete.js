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
import { requireAuth, revokeToken } from './_auth.js';
import { safeError } from './_errors.js';
import { snapshotOutcome } from './_outcomes.js';

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
      'SELECT id, name, school, grade, created_at FROM students WHERE parent_phone = ? OR student_phone = ?'
    ).bind(phone, phone).all();

    const names = new Set();
    for (const s of (studs || [])) {
      if (s.name) names.add(s.name);
      // ── 삭제 직전: 익명 성과 한 줄만 따로 보존(개인정보 아님) ──
      try {
        const snap = await snapshotOutcome(env, s);
        if (snap.ok) result.outcomes_saved += 1;
      } catch (e) { /* 성과 보존 실패는 삭제를 막지 않음 */ }
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
    for (const name of names) {
      try {
        const rd = await env.DB.prepare('DELETE FROM reports WHERE student_name = ?').bind(name).run();
        result.reports_deleted += (rd.meta && rd.meta.changes) || 0;
      } catch (e) { result.errors.push('reports:' + name); }
      for (const prefix of ['reports/' + name + '/', 'test-results/' + name + '/']) {
        try {
          const listed = await env.BUCKET.list({ prefix, limit: 500 });
          for (const obj of (listed.objects || [])) {
            try { await env.BUCKET.delete(obj.key); result.files_deleted++; }
            catch (e) { result.errors.push('file:' + obj.key); }
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
    try { await revokeToken(env, auth.token); } catch (e) { /* 비치명적 */ }

    return Response.json({ ok: true, ...result });
  } catch (e) {
    return safeError(e, env, { message: '계정 삭제 중 오류가 발생했습니다.' });
  }
}
