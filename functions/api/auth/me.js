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
  // 계정 페이지가 사라졌으면 토큰도 무효 처리 (이건 운영 중 드물지만 대비)
  if (!account) return jsonError('계정을 찾을 수 없습니다. 다시 로그인해주세요.', 401);

  const students = await fetchStudentsByPhone(env, auth.phone);

  return Response.json({
    ok: true,
    phone: auth.phone,
    mustChangePassword: !!account.mustChangePassword,
    students,
  });
}
