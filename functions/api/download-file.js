// GET /api/download-file?key=...&name=...
// - admin: Authorization: Bearer <ADMIN_PASSWORD>
// - 사용자: Authorization: Bearer <userToken>
//   - reports/{학생이름}/ → 학생 본인 폴더만
//   - class/{학원}_{반}/ → 학생의 학원/반 폴더만
//   - 그 외 폴더(materials 등 공개)는 토큰 없이도 OK

import { requireAuth, resolveStudent } from './_auth.js';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key) return Response.json({ error: 'key 파라미터 필요' }, { status: 400 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;

  // 보호 폴더 접근 시 토큰 + 학생 매칭 검증
  if (!isAdmin && (key.startsWith('reports/') || key.startsWith('class/'))) {
    const auth = await requireAuth(env, request);
    if (!auth.ok) return auth.response;

    const queryName = (url.searchParams.get('name') || '').trim();
    const resolved = await resolveStudent(env, auth.phone, queryName);
    if (!resolved.ok) return Response.json({ error: resolved.error || '권한 없음' }, { status: 403 });
    const student = resolved.student;

    if (key.startsWith('reports/')) {
      const folderName = key.split('/')[1];
      if (folderName !== student.name) {
        return Response.json({ error: '다른 학생의 자료에 접근할 수 없습니다.' }, { status: 403 });
      }
    } else if (key.startsWith('class/')) {
      const classKey = key.split('/')[1] || '';
      const expected = (student.school || '') + '_' + (student.className || '');
      if (classKey !== expected) {
        return Response.json({ error: '다른 반의 자료에 접근할 수 없습니다.' }, { status: 403 });
      }
    }
  }

  const object = await env.BUCKET.get(key);
  if (!object) return Response.json({ error: '파일을 찾을 수 없습니다' }, { status: 404 });

  const fileName = key.split('/').pop().replace(/[\r\n"]/g, '');
  const contentType = object.httpMetadata?.contentType
    || (fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');

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
