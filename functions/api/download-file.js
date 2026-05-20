// R2에서 파일을 직접 스트리밍 (native R2 binding)
export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!key) return Response.json({ error: 'key 파라미터 필요' }, { status: 400 });

  // reports/ 폴더는 admin 토큰 OR 이름+phone4 인증 필요
  if (key.startsWith('reports/')) {
    const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
    const isAdmin = token === env.ADMIN_PASSWORD;
    const name = url.searchParams.get('name') || '';
    const phone4 = url.searchParams.get('phone4') || '';
    const folderName = key.split('/')[1]; // 학생 이름
    const isStudentAuth = name && phone4.length === 4 && folderName === name;
    if (!isAdmin && !isStudentAuth)
      return Response.json({ error: '접근 권한 없음' }, { status: 403 });
  }

  const object = await env.BUCKET.get(key);
  if (!object) return Response.json({ error: '파일을 찾을 수 없습니다' }, { status: 404 });

  const fileName = key.split('/').pop().replace(/[\r\n"]/g, '');
  const contentType = object.httpMetadata?.contentType
    || (fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');

  // RFC 5987: 한글 파일명을 위해 filename* 인코딩 사용
  const encodedName = encodeURIComponent(fileName);
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`,
      'Cache-Control': 'private, max-age=0',
    },
  });
}
