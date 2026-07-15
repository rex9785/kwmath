// POST /api/admin-auth — 관리자 로그인
// 성공 시: 비번 원본 대신 서명된 세션 토큰(adm_)을 발급 + HttpOnly 쿠키 설정.
//   _middleware.js가 이 토큰을 검증해 다운스트림 endpoint엔 Bearer <ADMIN_PASSWORD>로 번역한다.
//   (admin endpoint들은 무수정. 레거시 Bearer <ADMIN_PASSWORD>도 계속 통과 — 하위호환.)
import { issueAdminSession } from './_admin.js';
import { checkLockout, recordFailure, clearLockout, fmtRetry } from './_lockout.js';

// 관리자 잠금 키 — login_lockouts 테이블은 phone 키라서 고정 키 사용 (푸시의 '__admin__' 관례와 동일)
const ADMIN_LOCK_KEY = '__admin__';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  let body = {};
  try { body = await request.json(); } catch {}
  const { password } = body;

  // ── 무차별 대입(brute-force) 방어: 학생 로그인(_lockout)과 동일 단계 잠금(5회→1분…8회+→60분 상한) ──
  //    상한 60분이라 관우T 본인이 잠겨도 최대 60분이면 스스로 풀림(자가복구).
  const lock = await checkLockout(env, ADMIN_LOCK_KEY);
  if (lock.locked) {
    return Response.json(
      { error: `비밀번호를 여러 번 잘못 입력해 로그인이 일시 제한되었습니다. 약 ${fmtRetry(lock.retryAfterSec)} 후 다시 시도해주세요.` },
      { status: 429 },
    );
  }

  if (!password || password !== env.ADMIN_PASSWORD) {
    const f = await recordFailure(env, ADMIN_LOCK_KEY);
    if (f.locked) {
      return Response.json(
        { error: `비밀번호를 여러 번 잘못 입력해 로그인이 약 ${fmtRetry(f.retryAfterSec)} 제한됩니다.` },
        { status: 429 },
      );
    }
    const left = Math.max(0, 5 - f.failCount);
    const tail = (f.failCount >= 3 && left > 0) ? ` (${left}회 더 틀리면 잠깐 잠겨요)` : '';
    return Response.json({ error: '비밀번호가 올바르지 않습니다.' + tail }, { status: 401 });
  }

  // 정답 → 누적 실패 초기화
  await clearLockout(env, ADMIN_LOCK_KEY);

  // 비번 원본 대신 만료·서명된 세션 토큰 발급 (XSS로 비번 자체가 유출되는 것 방지)
  const token = await issueAdminSession(env);
  const maxAge = 30 * 24 * 60 * 60; // 30일
  const cookie = `admin_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  return new Response(JSON.stringify({ token, ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie },
  });
}
