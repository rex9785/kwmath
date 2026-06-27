// POST /api/auth/change-password
// 헤더: Authorization: Bearer <token>
// body: { oldPassword, newPassword }
// 응답: { ok:true }

import {
  requireAuth, findAccountByPhone, verifyPassword, updateAccountPassword, jsonError,
} from '../_auth.js';
import { clearLockout } from '../_lockout.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return jsonError('POST만 허용', 405);

  const auth = await requireAuth(env, request);
  if (!auth.ok) return auth.response;

  // 데모 계정은 비밀번호 변경 불가 (여러 사람에게 배포되는 공용 계정 보호)
  if (auth.phone === '010-1234-1234') {
    return jsonError('데모 계정은 비밀번호를 변경할 수 없습니다.', 403);
  }

  let body = {};
  try { body = await request.json(); } catch (_) {}
  const oldPassword = (body.oldPassword || '').toString();
  const newPassword = (body.newPassword || '').toString();

  if (!newPassword || newPassword.length < 4) {
    return jsonError('새 비밀번호는 4자리 이상이어야 합니다.', 400);
  }
  if (newPassword.length > 64) {
    return jsonError('새 비밀번호가 너무 깁니다.', 400);
  }
  if (oldPassword === newPassword) {
    return jsonError('새 비밀번호가 기존 비밀번호와 동일합니다.', 400);
  }

  const account = await findAccountByPhone(env, auth.phone);
  if (!account) return jsonError('계정을 찾을 수 없습니다.', 404);

  const okOld = await verifyPassword(oldPassword, account.hash, account.salt);
  if (!okOld) return jsonError('기존 비밀번호가 일치하지 않습니다.', 401);

  const upd = await updateAccountPassword(env, account.id, newPassword);
  if (!upd.ok) return jsonError(upd.error || '비밀번호 변경 실패', 500);

  // 비번 변경 성공 → 혹시 남아있던 로그인 잠금도 해제
  try { await clearLockout(env, account.id); } catch (_) {}

  return Response.json({ ok: true });
}
