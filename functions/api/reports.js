// GET /api/reports — Cloudflare D1 reports 테이블 (Phase 4 전환, 이전엔 Notion 82ef)
//   admin (Bearer ADMIN_PASSWORD):
//     - name 없으면 전체 공개 리포트 (D1 학생 명단 join → 학원/반 채움)
//     - name 있으면 그 학생 리포트
//   사용자 (Bearer userToken): 토큰 → 본인/자녀 리포트
//
// id는 문자열로 반환 (admin.html이 문자열 id로 수정/삭제 호출 — 노션 시절 계약 유지)

import { requireStudentAccess } from './_auth.js';
import { getReportsForStudent, listStudents } from './_db.js';
import { safeError } from './_errors.js';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const queryName = (url.searchParams.get('name') || '').trim();

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;

  let targetName = '';
  let studentInfo = null;

  if (isAdmin) {
    targetName = queryName;
  } else {
    const access = await requireStudentAccess(env, request);
    if (!access.ok) return access.response;
    targetName = access.student.name;
    studentInfo = {
      name: access.student.name,
      school: access.student.school,
      class_name: access.student.className,
    };
  }

  try {
    const opts = { publicOnly: true };
    if (targetName) opts.name = targetName;
    let reports = await getReportsForStudent(env, opts);
    reports = reports.map(r => ({ ...r, id: r.id == null ? '' : String(r.id) }));

    // admin 전체 조회 — D1 학생 명단으로 학원/반 채움
    if (isAdmin && !targetName && reports.length) {
      const nameToClass = {};
      const students = await listStudents(env);
      for (const s of students) {
        if (s.name) nameToClass[s.name] = { school: s.academy || '', class_name: s.className || '' };
      }
      reports = reports.map(r => {
        const info = nameToClass[r.studentName] || {};
        return { ...r, class_name: info.class_name || '', school: r.school || info.school || '' };
      });
    }

    return Response.json({ student: studentInfo, reports });
  } catch (e) {
    return safeError(e, env, { message: '리포트를 불러오지 못했습니다.' });
  }
}
