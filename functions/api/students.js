// GET /api/students — admin 전용 전체 학생 목록 (Cloudflare D1 students, 이전엔 Notion)
// id는 문자열로 반환 (admin.html이 문자열 id로 승인/수정/삭제 호출 — 노션 시절 계약 유지)
import { listStudents } from './_db.js';
import { safeError } from './_errors.js';

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  try {
    const students = await listStudents(env);
    return Response.json(students.map(s => ({ ...s, id: s.id == null ? '' : String(s.id) })));
  } catch (e) {
    return safeError(e, env, { message: '학생 목록을 불러오지 못했습니다.' });
  }
}
