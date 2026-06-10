// POST /api/delete-student (admin only) — Cloudflare D1 + R2 (이전엔 Notion+R2)
// body: { name } 전체 퇴원(같은 이름 모든 enrollment + 리포트 + 출결 + 공부 + 계정)
//       { studentId } enrollment-only (그 레코드만 + 그 출결/공부)
// 안전장치: 계정은 같은 번호를 쓰는 다른 학생이 남아있으면 보존(형제 로그인 보호).
import { safeError } from './_errors.js';
import { snapshotArchive } from './_outcomes.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const name = (body.name || '').trim();
  const studentIdRaw = (body.studentId || '').toString().trim();
  if (!name && !studentIdRaw) return Response.json({ error: '학생 이름 또는 studentId 필요' }, { status: 400 });
  const enrollmentOnly = !!studentIdRaw && !name;

  const result = { name: name || '', studentId: studentIdRaw || '', enrollmentOnly,
    students_archived: 0, reports_archived: 0, accounts_archived: 0, files_deleted: 0,
    scores_deleted: 0, outcomes_saved: 0, errors: [] };

  try {
    if (enrollmentOnly) {
      const id = Number(studentIdRaw);
      if (!Number.isFinite(id)) return Response.json({ error: 'studentId 형식 오류' }, { status: 400 });
      const st = await env.DB.prepare('SELECT id, name, school, grade, created_at, parent_phone, student_phone FROM students WHERE id = ?').bind(id).first();
      if (!st) return Response.json({ error: '학생을 찾을 수 없습니다' }, { status: 404 });
      result.name = st.name || '';
      // 삭제 직전: 전체 기록(실명·전화·성적·출결·학습)을 관리자 아카이브에 보존
      try { const snap = await snapshotArchive(env, st, 'admin'); if (snap.ok) result.outcomes_saved += 1; } catch (e) {}
      await env.DB.prepare('DELETE FROM attendance WHERE student_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM study_sessions WHERE student_id = ?').bind(id).run();
      try { const sd = await env.DB.prepare('DELETE FROM exam_scores WHERE student_id = ?').bind(id).run(); result.scores_deleted += (sd.meta && sd.meta.changes) || 0; } catch (e) { /* exam_scores 테이블 없을 수 있음 */ }
      const d = await env.DB.prepare('DELETE FROM students WHERE id = ?').bind(id).run();
      result.students_archived = (d.meta && d.meta.changes) || 0;
      return Response.json({ ok: true, ...result });
    }

    // 전체 퇴원 (이름 기준)
    const phones = new Set();
    const { results: studs } = await env.DB.prepare(
      'SELECT id, parent_phone, student_phone, school, grade, created_at FROM students WHERE name = ?'
    ).bind(name).all();
    for (const s of (studs || [])) {
      if (s.parent_phone) phones.add(s.parent_phone);
      if (s.student_phone) phones.add(s.student_phone);
      // 삭제 직전: 전체 기록(실명·전화·성적·출결·학습)을 관리자 아카이브에 보존
      try {
        const snap = await snapshotArchive(env, { id: s.id, name, school: s.school, grade: s.grade, created_at: s.created_at, parent_phone: s.parent_phone, student_phone: s.student_phone }, 'admin');
        if (snap.ok) result.outcomes_saved += 1;
      } catch (e) {}
      await env.DB.prepare('DELETE FROM attendance WHERE student_id = ?').bind(s.id).run();
      await env.DB.prepare('DELETE FROM study_sessions WHERE student_id = ?').bind(s.id).run();
      try { const sd = await env.DB.prepare('DELETE FROM exam_scores WHERE student_id = ?').bind(s.id).run(); result.scores_deleted += (sd.meta && sd.meta.changes) || 0; } catch (e) { /* exam_scores 테이블 없을 수 있음 */ }
      const d = await env.DB.prepare('DELETE FROM students WHERE id = ?').bind(s.id).run();
      result.students_archived += (d.meta && d.meta.changes) || 0;
    }

    // 리포트 (이름 기준)
    const rd = await env.DB.prepare('DELETE FROM reports WHERE student_name = ?').bind(name).run();
    result.reports_archived = (rd.meta && rd.meta.changes) || 0;

    // R2 reports/{이름}/ 파일 삭제 (리포트 PDF는 R2 유지 중)
    try {
      const listed = await env.BUCKET.list({ prefix: 'reports/' + name + '/', limit: 500 });
      for (const obj of (listed.objects || [])) {
        try { await env.BUCKET.delete(obj.key); result.files_deleted++; }
        catch (e) { result.errors.push('file ' + obj.key); }
      }
    } catch (e) { result.errors.push('R2 list 실패'); }

    // 계정 — 같은 번호 쓰는 다른 학생 없을 때만 삭제 (형제 로그인 보호)
    for (const phone of phones) {
      try {
        const stillUsed = await env.DB.prepare(
          'SELECT 1 FROM students WHERE parent_phone = ? OR student_phone = ? LIMIT 1'
        ).bind(phone, phone).first();
        if (stillUsed) continue;
        const ad = await env.DB.prepare('DELETE FROM accounts WHERE phone = ?').bind(phone).run();
        result.accounts_archived += (ad.meta && ad.meta.changes) || 0;
      } catch (e) { result.errors.push('account ' + phone); }
    }

    return Response.json({ ok: true, ...result });
  } catch (e) {
    return safeError(e, env, { message: '학생 삭제 중 오류가 발생했습니다.' });
  }
}
