// POST /api/auth/login
// body: { phone, password }
// 응답: { ok:true, token, expires, mustChangePassword, students:[{id,name,school,grade,academy,className,role}] }

import {
  normalizePhone, verifyPassword, issueToken, touchLastLogin,
  findAccountByPhone, fetchStudentsByPhone, jsonError,
} from '../_auth.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return jsonError('POST만 허용', 405);

  let body = {};
  try { body = await request.json(); } catch (_) {}

  const phone = normalizePhone(body.phone || '');
  const password = (body.password || '').toString();

  if (!phone) return jsonError('휴대폰 번호를 정확히 입력해주세요.', 400);
  if (!password) return jsonError('비밀번호를 입력해주세요.', 400);

  // 계정 조회
  const account = await findAccountByPhone(env, phone);
  if (!account) return jsonError('등록되지 않은 휴대폰 번호입니다. 관우T께 문의해주세요.', 401);

  // 비밀번호 검증
  const ok = await verifyPassword(password, account.hash, account.salt);
  if (!ok) return jsonError('비밀번호가 일치하지 않습니다.', 401);

  // 토큰 발급
  const { token, expires } = await issueToken(env, phone);

  // 마지막 로그인 시각 (비치명적)
  touchLastLogin(env, account.id);

  // 자녀(또는 본인) 학생 목록
  const students = await fetchStudentsByPhone(env, phone);

  // ⚠️ 좀비 계정 방어 — 계정은 있는데 학생 DB에 연결된 학생이 없으면 로그인 거절
  // (퇴원처리 후 계정만 남은 좀비 등)
  if (!students.length) {
    return jsonError('계정은 있으나 학원에 등록된 학생 정보가 없습니다. 관우T께 문의해주세요.', 401);
  }

  return Response.json({
    ok: true,
    token,
    expires,
    mustChangePassword: !!account.mustChangePassword,
    phone,
    students,
  });
}
