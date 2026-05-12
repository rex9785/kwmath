// R2 파일 목록 (native R2 binding)
export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  const url = new URL(request.url);
  const folder = url.searchParams.get('folder') || 'materials';

  const listed = await env.BUCKET.list({ prefix: folder + '/', limit: 200 });
  const files = (listed.objects || [])
    .map(obj => ({
      key: obj.key,
      displayName: obj.key.split('/').pop().replace(/^\d+_/, ''),
      size: obj.size > 1024 * 1024
        ? (obj.size / (1024 * 1024)).toFixed(1) + 'MB'
        : Math.round(obj.size / 1024) + 'KB',
      lastModified: obj.uploaded,
    }))
    .filter(f => f.displayName);

  return Response.json(files);
}
