// POST /api/admin-reset-password (admin only) — Cloudflare D1 accounts (이전엔 Notion)
// body: { phone } → 비번 '0000' 리셋 + must_change=true (재로그인 시 강제 변경)
//   예외: 데모 계정(010-1234-1234)은 자가변경 불가라 '1234'로 되돌리고 강제변경 안 검.
import { findAccountByPhone, updateAccountPassword } from './_auth.js';
import { clearLockout } from './_lockout.js';
import { safeError } from './_errors.js';

const INITIAL_PASSWORD = '0000';
// 데모 계정(여러 명에게 배포되는 공용 심사 계정)은 자가 비밀번호 변경이 막혀 있다(change-password.js).
// 일반 학생처럼 0000+강제변경으로 초기화하면 데모가 영영 못 바꿔 잠기므로,
// 데모는 공지된 데모 비밀번호(1234)로 되돌리고 강제변경 플래그도 걸지 않는다.
const DEMO_PHONE = '010-1234-1234';
const DEMO_PASSWORD = '1234';

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

    const isDemo = account.phone === DEMO_PHONE;
    const newPw = isDemo ? DEMO_PASSWORD : INITIAL_PASSWORD;

    const result = await updateAccountPassword(env, account.id, newPw);
    if (!result.ok) return safeError(result.error || '비번 리셋 실패', env, { message: '비밀번호 초기화에 실패했습니다.' });

    // 일반 계정만 재로그인 시 강제 변경(0000→본인 비번). 데모는 자가변경이 막혀 있어 강제변경을 걸지 않는다
    // (updateAccountPassword가 이미 must_change_pw=0으로 세팅).
    if (!isDemo) {
      try { await env.DB.prepare('UPDATE accounts SET must_change_pw = 1 WHERE phone = ?').bind(account.id).run(); } catch (_) {}
    }

    // 비번 초기화 시 로그인 잠금도 함께 해제 → 잠긴 학생을 관우T가 즉시 풀어줄 수 있음
    try { await clearLockout(env, account.id); } catch (_) {}

    return Response.json({ ok: true, phone, message: isDemo ? '데모 계정 비밀번호를 1234로 되돌렸습니다.' : '비밀번호가 0000으로 초기화되었습니다. 학부모/학생에게 알려주세요.' });
  } catch (e) {
    return safeError(e, env, { message: '비밀번호 초기화 중 오류가 발생했습니다.' });
  }
}
