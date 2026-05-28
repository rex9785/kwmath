// GET /api/auth/me
// 헤더: Authorization: Bearer <token>
// 응답: { ok:true, phone, mustChangePassword, students:[...] }
// portal 페이지가 새로고침 시 토큰 유효성 + 자녀 목록 갱신용

import {
  requireAuth, findAccountByPhone, fetchStudentsByPhone, jsonError,
} from '../_auth.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return jsonError('GET만 허용', 405);

  const auth = await requireAuth(env, request);
  if (!auth.ok) return auth.response;

  const account = await findAccountByPhone(env, auth.phone);
  if (!account) return jsonError('계정을 찾을 수 없습니다. 다시 로그인해주세요.', 401);

  const students = await fetchStudentsByPhone(env, auth.phone);

  // 좀비 계정 방어 — 학생 DB에 연결된 학생이 없으면 토큰 무효 처리
  if (!students.length) {
    return jsonError('계정은 있으나 학원에 등록된 학생 정보가 없습니다. 관우T께 문의해주세요.', 401);
  }

  // 승인된 학생만 통과 (대기중/거부 제외, 빈 값은 옛 학생이므로 통과)
  const approvedStudents = students.filter(s => {
    const status = s.approvalStatus || '';
    return status === '' || status === '승인';
  });
  if (!approvedStudents.length) {
    return jsonError('학원 등록이 아직 승인되지 않았거나 거부됐습니다. 관우T께 문의해주세요.', 403);
  }

  return Response.json({
    ok: true,
    phone: auth.phone,
    mustChangePassword: !!account.mustChangePassword,
    students: approvedStudents,
  });
}
