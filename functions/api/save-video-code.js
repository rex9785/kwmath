// POST /api/save-video-code
// MathOS에서 수업 영상 코드를 R2에 저장
export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  let body = {};
  try { body = await request.json(); } catch {}

  const password = body.password || '';
  if (password !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  const code        = (body.code        || '').trim().toUpperCase();
  const youtubeUrl  = (body.youtube_url || '').trim();
  const title       = (body.title       || '').trim();
  const date        = (body.date        || '').trim();
  const school      = (body.school      || '').trim();
  const className   = (body.class_name  || '').trim();
  const requireCode = body.require_code === true;

  if (!code)       return Response.json({ error: 'code 필요' }, { status: 400 });
  if (!youtubeUrl) return Response.json({ error: 'youtube_url 필요' }, { status: 400 });

  const data = {
    code,
    youtube_url: youtubeUrl,
    title,
    date,
    school,
    class_name: className,
    active: true,
    require_code: requireCode,
    created_at: new Date().toISOString(),
    access_log: [],
    access_count: 0,
  };

  try {
    await env.BUCKET.put(`video-codes/${code}.json`, JSON.stringify(data), {
      httpMetadata: { contentType: 'application/json' },
    });
    return Response.json({ ok: true, code });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
