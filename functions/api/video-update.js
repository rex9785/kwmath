// POST /api/video-update  (admin only)
// 영상의 require_code / class_name / active 변경
// body: { code, require_code?, class_name?, active? }
export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}

  const code = (body.code || '').trim().toUpperCase();
  if (!code) return Response.json({ error: 'code 필요' }, { status: 400 });

  try {
    const key = `video-codes/${code}.json`;
    const obj = await env.BUCKET.get(key);
    if (!obj) return Response.json({ error: '해당 코드 영상 없음' }, { status: 404 });

    const data = await obj.json();
    let changed = false;
    if (typeof body.require_code === 'boolean') { data.require_code = body.require_code; changed = true; }
    if (typeof body.active === 'boolean')       { data.active = body.active; changed = true; }
    if (typeof body.class_name === 'string')    { data.class_name = body.class_name.trim(); changed = true; }
    if (!changed) return Response.json({ error: '변경할 필드 없음' }, { status: 400 });

    data.updated_at = new Date().toISOString();
    await env.BUCKET.put(key, JSON.stringify(data), {
      httpMetadata: { contentType: 'application/json' },
    });
    return Response.json({ ok: true, code, video: data });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
