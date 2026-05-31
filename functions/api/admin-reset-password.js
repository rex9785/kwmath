// POST /api/admin-reset-password (admin only) — Cloudflare D1 accounts (이전엔 Notion)
// body: { phone } → 비번 '0000' 리셋 + must_change=true (재로그인 시 강제 변경)
import { findAccountByPhone, updateAccountPassword } from './_auth.js';
import { safeError } from './_errors.js';

const INITIAL_PASSWORD = '0000';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const phone = (body.phone || '').toString().trim();
  if (!phone) return Response.json({ error: 'phone 필요 (010-XXXX-XXXX)' }, { status: 400 });

  try {
    const account = await findAccountByPhone(env, phone);
    if (!account) return Response.json({ error: '해당 휴대폰의 계정을 찾을 수 없습니다.' }, { status: 404 });

    const result = await updateAccountPassword(env, account.id, INITIAL_PASSWORD);
    if (!result.ok) return safeError(result.error || '비번 리셋 실패', env, { message: '비밀번호 초기화에 실패했습니다.' });

    // updateAccountPassword가 must_change_pw=0으로 바꾸니, 명시적으로 1 덮어쓰기
    try { await env.DB.prepare('UPDATE accounts SET must_change_pw = 1 WHERE phone = ?').bind(account.id).run(); } catch (_) {}

    return Response.json({ ok: true, phone, message: '비밀번호가 0000으로 초기화되었습니다. 학부모/학생에게 알려주세요.' });
  } catch (e) {
    return safeError(e, env, { message: '비밀번호 초기화 중 오류가 발생했습니다.' });
  }
}
