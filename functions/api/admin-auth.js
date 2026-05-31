// POST /api/admin-auth — 관리자 로그인
// 성공 시: 비번 원본 대신 서명된 세션 토큰(adm_)을 발급 + HttpOnly 쿠키 설정.
//   _middleware.js가 이 토큰을 검증해 다운스트림 endpoint엔 Bearer <ADMIN_PASSWORD>로 번역한다.
//   (admin endpoint들은 무수정. 레거시 Bearer <ADMIN_PASSWORD>도 계속 통과 — 하위호환.)
import { issueAdminSession } from './_admin.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  let body = {};
  try { body = await request.json(); } catch {}
  const { password } = body;
  if (!password || password !== env.ADMIN_PASSWORD)
    return Response.json({ error: '비밀번호가 올바르지 않습니다.' }, { status: 401 });

  // 비번 원본 대신 만료·서명된 세션 토큰 발급 (XSS로 비번 자체가 유출되는 것 방지)
  const token = await issueAdminSession(env);
  const maxAge = 30 * 24 * 60 * 60; // 30일
  const cookie = `admin_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  return new Response(JSON.stringify({ token, ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie },
  });
}
