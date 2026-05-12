export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  const { password } = await request.json();
  if (!password || password !== env.ADMIN_PASSWORD)
    return Response.json({ error: '비밀번호가 올바르지 않습니다.' }, { status: 401 });
  return Response.json({ token: env.ADMIN_PASSWORD, ok: true });
}
