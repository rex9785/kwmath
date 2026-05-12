// 파일을 직접 R2에 업로드 (native R2 binding, AWS SDK 불필요)
export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405 });

  const formData = await request.formData();
  const file = formData.get('file');
  const folder = formData.get('folder') || 'materials';
  const password = formData.get('password');

  if (password !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });
  if (!file || typeof file === 'string')
    return Response.json({ error: '파일이 없습니다' }, { status: 400 });

  const timestamp = Date.now();
  const safeFileName = file.name.replace(/[^a-zA-Z0-9가-힣.\-_]/g, '_');
  const key = `${folder}/${timestamp}_${safeFileName}`;

  await env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  const fileSize = file.size > 1024 * 1024
    ? (file.size / (1024 * 1024)).toFixed(1) + 'MB'
    : Math.round(file.size / 1024) + 'KB';

  return Response.json({ ok: true, key, fileName: file.name, fileSize });
}
