// POST /api/auth/login
// body: { phone, password }
// 응답(학생/학부모): { ok, role:'student', token, expires, mustChangePassword, phone, students:[...], isAdmin:false }
// 응답(원장 관우T):   { ok, role:'owner', isAdmin:true, phone, adminToken }       ← adm_ 세션 → 프론트가 /admin
// 응답(조교 운영진):  { ok, role:'staff', isStaff:true, phone, name, staffToken } ← ast_ 세션 → 프론트가 /admin-qna
//   ※ 운영진(원장·조교)은 학생 레코드가 없어도 로그인됨(학생 검사보다 먼저 분기).

import {
  normalizePhone, verifyPassword, issueToken, touchLastLogin,
  findAccountByPhone, fetchStudentsByPhone, jsonError,
} from '../_auth.js';
import { issueAdminSession, issueStaffSession } from '../_admin.js';
import { getStaffRecord } from '../_staff.js';

// 운영진(원장) 번호 — 원장 식별 (staff-register.js·me.js와 동일하게 유지)
const ADMIN_PHONES = ['01041149785'];
const onlyDigits = (p) => String(p || '').replace(/\D/g, '');

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

  // 마지막 로그인 시각 (비치명적)
  touchLastLogin(env, account.id);

  // ════════ 운영진(원장·조교) 분기 — 학생 레코드 없이도 로그인 ════════
  // 학생 검사보다 먼저 처리해서, 관우T가 학생 명단에서 빠져도(또는 빠지기 전에도) 로그인 가능.
  const digits = onlyDigits(phone);

  // 원장(관우T): adm_ 풀권한 세션 발급 → 프론트가 localStorage['kwmath_admin_token']에 저장 후 /admin.
  if (ADMIN_PHONES.includes(digits)) {
    const adminToken = await issueAdminSession(env);
    if (!adminToken) return jsonError('관리자 세션 설정이 누락됐습니다. (ADMIN_PASSWORD 미설정)', 500);
    return Response.json({ ok: true, role: 'owner', isAdmin: true, phone, adminToken });
  }

  // 조교(운영진): 승인된 경우에만 ast_ 제한세션 발급 → /admin-qna. 미승인은 안내 후 거절.
  const staff = await getStaffRecord(env, phone);
  if (staff) {
    if (!staff.approved) {
      return jsonError('조교 가입이 아직 승인되지 않았습니다. 관우T 승인 후 같은 번호·비밀번호로 로그인하실 수 있어요.', 403);
    }
    const staffToken = await issueStaffSession(env);
    if (!staffToken) return jsonError('운영진 세션 설정이 누락됐습니다. (ADMIN_PASSWORD 미설정)', 500);
    return Response.json({ ok: true, role: 'staff', isStaff: true, phone, name: staff.name || '', staffToken });
  }

  // ════════ 학생/학부모 — 기존 포털 흐름 ════════
  // 토큰 발급
  const { token, expires } = await issueToken(env, phone);

  // 자녀(또는 본인) 학생 목록
  const students = await fetchStudentsByPhone(env, phone);

  // ⚠️ 좀비 계정 방어 — 계정은 있는데 학생 DB에 연결된 학생이 없으면 로그인 거절
  if (!students.length) {
    return jsonError('계정은 있으나 학원에 등록된 학생 정보가 없습니다. 관우T께 문의해주세요.', 401);
  }

  // ⚠️ 승인 대기 방어 — 연결된 학생이 다 "대기중" 또는 "거부" 상태면 로그인 거절
  // 빈 값(옛 학생, 승인 시스템 도입 전)은 자동으로 통과
  const approvedStudents = students.filter(s => {
    const status = s.approvalStatus || '';
    return status === '' || status === '승인';
  });
  if (!approvedStudents.length) {
    const pendingCount = students.filter(s => s.approvalStatus === '대기중').length;
    if (pendingCount > 0) {
      return jsonError('등록 신청이 접수됐지만 아직 관우T 승인 대기 중입니다. 잠시 후 다시 시도해주세요.', 403);
    }
    return jsonError('학원 등록이 거부됐거나 활성 학생이 없습니다. 관우T께 문의해주세요.', 403);
  }

  return Response.json({
    ok: true,
    role: 'student',
    token,
    expires,
    mustChangePassword: !!account.mustChangePassword,
    phone,
    students: approvedStudents,  // 승인된 학생만 반환
    isAdmin: false,  // 원장은 위 분기에서 처리됨 → 여기 도달은 학생/학부모뿐
  });
}
