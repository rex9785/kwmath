// R2 파일 삭제 (native R2 binding)
export async function onRequest({ request, env }) {
  if (request.method !== 'DELETE' && request.method !== 'POST')
    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  const { key } = await request.json();
  if (!key) return Response.json({ error: 'key 필요' }, { status: 400 });

  await env.BUCKET.delete(key);
  return Response.json({ ok: true });
}
