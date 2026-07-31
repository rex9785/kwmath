// POST /api/delete-student (admin only) — Cloudflare D1 + R2 (이전엔 Notion+R2)
// body: { name } 전체 퇴원(같은 이름 모든 enrollment + 리포트 + 출결 + 공부 + 계정)
//       { studentId } enrollment-only (그 레코드만 + 그 출결/공부)
// 안전장치: 계정은 같은 번호를 쓰는 다른 학생이 남아있으면 보존(형제 로그인 보호).
import { safeError } from './_errors.js';
import { snapshotArchive } from './_outcomes.js';
import { logAudit } from './_auditlog.js';

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
      // 삭제 직전: 전체 기록(실명·전화·성적·출결·학습)을 관리자 아카이브에 보존.
      // 🛡️ 2026-07-30 — 보존 실패 시 삭제 중단(보존 없는 삭제 금지). 이전엔 실패해도 DELETE가 진행됐다.
      const snap = await snapshotArchive(env, st, 'admin');
      if (!snap.ok) {
        return Response.json({ error: '기록 보존(아카이브)에 실패해 삭제를 중단했습니다. 아무것도 지워지지 않았습니다. 잠시 후 다시 시도해주세요.' + (snap.error ? ' [' + snap.error + ']' : '') }, { status: 500 });
      }
      result.outcomes_saved += 1;
      // 몇 건이 사라지는지 세어서 남긴다. "출결이 통째로 없어졌다"는 문의에 답할 수 있는 유일한 근거다.
      const dAtt = await env.DB.prepare('DELETE FROM attendance WHERE student_id = ?').bind(id).run();
      const dStu = await env.DB.prepare('DELETE FROM study_sessions WHERE student_id = ?').bind(id).run();
      try { const sd = await env.DB.prepare('DELETE FROM exam_scores WHERE student_id = ?').bind(id).run(); result.scores_deleted += (sd.meta && sd.meta.changes) || 0; } catch (e) { /* exam_scores 테이블 없을 수 있음 */ }
      const d = await env.DB.prepare('DELETE FROM students WHERE id = ?').bind(id).run();
      result.students_archived = (d.meta && d.meta.changes) || 0;
      await logAudit(env, request, {
        action: 'student.delete.enrollment',
        target: String(id),
        targetName: st.name || '',
        summary: '[' + (st.name || id) + '] 등록 1건 삭제(퇴원) — 출결 ' + ((dAtt.meta && dAtt.meta.changes) || 0)
          + '건 · 학습 ' + ((dStu.meta && dStu.meta.changes) || 0) + '건 · 성적 ' + result.scores_deleted + '건 함께 삭제',
        detail: {
          방식: 'enrollmentOnly(studentId 지정)',
          지워진학생: st,
          건수: {
            출결: (dAtt.meta && dAtt.meta.changes) || 0,
            학습: (dStu.meta && dStu.meta.changes) || 0,
            성적: result.scores_deleted,
            학생레코드: result.students_archived,
          },
          퇴원기록보존: 'student_archive(via=admin) 1건 — 실명·전화·성적·출결·학습 전체 보존됨',
        },
      });
      return Response.json({ ok: true, ...result });
    }

    // 전체 퇴원 (이름 기준)
    const phones = new Set();
    const { results: studs } = await env.DB.prepare(
      'SELECT id, parent_phone, student_phone, school, grade, created_at FROM students WHERE name = ?'
    ).bind(name).all();

    // 동명이인 안전장치: 같은 이름이 2명 이상이면 이름 삭제를 막는다.
    //   이름 삭제는 같은 이름 전원 + 그 이름의 리포트/PDF까지 지운다. 리포트는 이름으로만 저장돼
    //   누구 것인지 구분이 안 되므로, 사람이 직접 확인하도록 개별(studentId) 처리를 안내한다.
    if ((studs || []).length > 1) {
      return Response.json({
        error: '같은 이름(' + name + ')의 학생이 ' + studs.length + '명 있어, 이름으로 한 번에 삭제하지 않습니다. 학생을 개별(studentId)로 처리해주세요.',
        duplicates: (studs || []).map((s) => ({ studentId: s.id, school: s.school || '', grade: s.grade || '', created_at: s.created_at || '' })),
      }, { status: 409 });
    }

    const 삭제내역 = [];   // 학생별로 무엇이 몇 건 사라졌는지 — 아래 감사로그에 그대로 들어간다
    for (const s of (studs || [])) {
      if (s.parent_phone) phones.add(s.parent_phone);
      if (s.student_phone) phones.add(s.student_phone);
      // 삭제 직전: 전체 기록(실명·전화·성적·출결·학습)을 관리자 아카이브에 보존.
      // 🛡️ 2026-07-30 — 보존 실패 시 삭제 중단(보존 없는 삭제 금지). 이전엔 실패해도 DELETE가 진행됐다.
      //   (동명이인 가드로 이 루프는 최대 1명 — 중단 시점엔 아직 아무것도 안 지워진 상태.)
      const snap = await snapshotArchive(env, { id: s.id, name, school: s.school, grade: s.grade, created_at: s.created_at, parent_phone: s.parent_phone, student_phone: s.student_phone }, 'admin');
      if (!snap.ok) {
        return Response.json({ error: '기록 보존(아카이브)에 실패해 삭제를 중단했습니다. 아무것도 지워지지 않았습니다. 잠시 후 다시 시도해주세요.' + (snap.error ? ' [' + snap.error + ']' : '') }, { status: 500 });
      }
      result.outcomes_saved += 1;
      const dAtt = await env.DB.prepare('DELETE FROM attendance WHERE student_id = ?').bind(s.id).run();
      const dStu = await env.DB.prepare('DELETE FROM study_sessions WHERE student_id = ?').bind(s.id).run();
      let 성적삭제 = 0;
      try { const sd = await env.DB.prepare('DELETE FROM exam_scores WHERE student_id = ?').bind(s.id).run(); 성적삭제 = (sd.meta && sd.meta.changes) || 0; result.scores_deleted += 성적삭제; } catch (e) { /* exam_scores 테이블 없을 수 있음 */ }
      const d = await env.DB.prepare('DELETE FROM students WHERE id = ?').bind(s.id).run();
      result.students_archived += (d.meta && d.meta.changes) || 0;
      // 학생 1명당 1건씩 남긴다 — 나중에 학생 이름으로 검색이 되어야 한다(전체 1건만 남기면 안 잡힌다).
      삭제내역.push({
        studentId: s.id, 이름: name,
        학교: s.school || '', 학년: s.grade || '', 등록일: s.created_at || '',
        학부모폰: s.parent_phone || '', 학생폰: s.student_phone || '',
        출결삭제: (dAtt.meta && dAtt.meta.changes) || 0,
        학습삭제: (dStu.meta && dStu.meta.changes) || 0,
        성적삭제: 성적삭제,
      });
    }

    // 리포트 (이름 기준)
    // 삭제 전에 리포트 행 전체를 R2 아카이브에 보존한다(되돌릴 수단). D1 백업엔 PDF가 안 들어가므로 여기서 텍스트/메타를 남긴다.
    // 🛡️ 2026-07-30 — 아카이브 실패 시 리포트 행 삭제를 건너뛴다(보존 없는 삭제 금지). 이전엔 실패해도 DELETE가 진행됐다.
    let repArchOk = true;
    let 리포트아카이브키 = '', 리포트원본건수 = 0;
    try {
      const { results: repRows } = await env.DB.prepare('SELECT * FROM reports WHERE student_name = ?').bind(name).all();
      리포트원본건수 = (repRows || []).length;
      if ((repRows || []).length) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        리포트아카이브키 = 'archive/reports/' + name + '/' + stamp + '.json';
        await env.BUCKET.put(
          리포트아카이브키,
          JSON.stringify({ archivedAt: new Date().toISOString(), student_name: name, count: repRows.length, rows: repRows }),
          { httpMetadata: { contentType: 'application/json' } }
        );
      }
    } catch (e) { repArchOk = false; 리포트아카이브키 = ''; result.errors.push('report 아카이브 실패 — 리포트 행은 지우지 않고 남겼습니다. 다시 시도해주세요.'); }

    if (repArchOk) {
      const rd = await env.DB.prepare('DELETE FROM reports WHERE student_name = ?').bind(name).run();
      result.reports_archived = (rd.meta && rd.meta.changes) || 0;
    }

    // R2 reports/{이름}/ PDF는 삭제하지 않고 남긴다(되돌릴 수단으로 보존).
    //   D1 백업엔 PDF가 안 들어가므로 여기서 지우면 복구 불가 → 파일은 보존, 리포트 행만 삭제.
    //   (동일 이름 재등록 시 파일키에 날짜/식별자가 들어가 충돌 위험은 낮음. 누적 용량은 소규모 학원 기준 무시 가능.)

    // 계정 — 같은 번호 쓰는 다른 학생 없을 때만 삭제 (형제 로그인 보호)
    const 삭제된계정 = [], 보존된계정 = [];
    for (const phone of phones) {
      try {
        const stillUsed = await env.DB.prepare(
          'SELECT 1 FROM students WHERE parent_phone = ? OR student_phone = ? LIMIT 1'
        ).bind(phone, phone).first();
        if (stillUsed) { 보존된계정.push(phone); continue; }   // 형제가 남아 있어 로그인 계정은 살린다
        const ad = await env.DB.prepare('DELETE FROM accounts WHERE phone = ?').bind(phone).run();
        result.accounts_archived += (ad.meta && ad.meta.changes) || 0;
        if ((ad.meta && ad.meta.changes) || 0) 삭제된계정.push(phone);
      } catch (e) { result.errors.push('account ' + phone); }
    }

    // 🔴 이름 기준 전체 퇴원 — 학생·출결·학습·성적·리포트·로그인계정이 한 번에 사라진다.
    //    무엇이 몇 건 사라졌는지 + 복원 근거(아카이브 위치)를 한 건에 모아 남긴다.
    await logAudit(env, request, {
      action: 'student.delete.full',
      target: ((studs || [])[0] && String((studs || [])[0].id)) || name,
      targetName: name,
      summary: '[' + name + '] 전체 퇴원 삭제 — 학생 ' + result.students_archived + '명 · 리포트 '
        + result.reports_archived + '건 · 로그인계정 ' + result.accounts_archived + '개 삭제'
        + (보존된계정.length ? ' (형제 사용 중 계정 ' + 보존된계정.length + '개는 보존)' : ''),
      detail: {
        방식: '이름 기준 전체 퇴원',
        학생별삭제: 삭제내역,
        리포트: {
          원본건수: 리포트원본건수, 삭제건수: result.reports_archived,
          아카이브키: 리포트아카이브키 || '(없음)',
          아카이브성공: repArchOk,
          비고: repArchOk ? 'R2 archive/reports/ 에 원본 보존 — 복원 가능' : '아카이브 실패로 리포트 행은 지우지 않고 남김',
        },
        R2개인파일: '삭제하지 않음(reports/{이름}/ PDF는 복원 수단으로 보존)',
        계정: { 삭제: 삭제된계정, 보존_형제사용중: 보존된계정 },
        퇴원기록보존: result.outcomes_saved + '건 (student_archive, via=admin)',
        오류: result.errors,
      },
    });

    return Response.json({ ok: true, ...result });
  } catch (e) {
    return safeError(e, env, { message: '학생 삭제 중 오류가 발생했습니다.' });
  }
}
