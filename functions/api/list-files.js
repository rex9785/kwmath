// R2 파일 목록 (native R2 binding)
export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const folder = url.searchParams.get('folder') || 'materials';
  const phone4 = url.searchParams.get('phone4');

  // 어드민 토큰 인증
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = token === env.ADMIN_PASSWORD;

  // reports/{phone4}/ 폴더는 phone4 인증도 허용
  const isReportsFolder = folder.startsWith('reports/');
  const folderPhone4 = isReportsFolder ? folder.split('/')[1] : null;
  const isPhone4Auth = isReportsFolder && phone4 && phone4 === folderPhone4;

  if (!isAdmin && !isPhone4Auth) {
    return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });
  }

  const listed = await env.BUCKET.list({ prefix: folder + '/', limit: 200 });
  const files = (listed.objects || [])
    .map(obj => ({
      key: obj.key,
      name: obj.key.split('/').pop().replace(/^\d+_/, ''),
      displayName: obj.key.split('/').pop().replace(/^\d+_/, ''),
      size: obj.size,
      sizeLabel: obj.size > 1024 * 1024
        ? (obj.size / (1024 * 1024)).toFixed(1) + 'MB'
        : Math.round(obj.size / 1024) + 'KB',
      lastModified: obj.uploaded,
    }))
    .filter(f => f.displayName);

  return Response.json(files);
}
