// R2에서 파일을 직접 스트리밍 (native R2 binding)
export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const phone4 = url.searchParams.get('phone4');

  if (!key) return Response.json({ error: 'key 파라미터 필요' }, { status: 400 });

  // reports/ 폴더는 phone4 인증 필요
  if (key.startsWith('reports/')) {
    const keyPhone4 = key.split('/')[1];
    if (!phone4 || phone4 !== keyPhone4)
      return Response.json({ error: '접근 권한 없음' }, { status: 403 });
  }

  const object = await env.BUCKET.get(key);
  if (!object) return Response.json({ error: '파일을 찾을 수 없습니다' }, { status: 404 });

  const fileName = key.split('/').pop().replace(/^\d+_/, '');
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
