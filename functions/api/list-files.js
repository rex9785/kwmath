// GET /api/list-files?folder=...&name=...
// - admin: Authorization: Bearer <ADMIN_PASSWORD>
// - 사용자(학부모/학생): Authorization: Bearer <userToken>
//   - reports/{학생이름}/, class/{학원}_{반}/ 폴더만 접근 가능
//   - 토큰 검증 + 학생 이름/학원/반 일치 확인

import { requireAuth, resolveStudent } from './_auth.js';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const folder = url.searchParams.get('folder') || 'materials';

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;

  if (!isAdmin) {
    // 사용자 모드: 토큰 검증 + 학생 매칭
    const auth = await requireAuth(env, request);
    if (!auth.ok) return auth.response;

    const queryName = (url.searchParams.get('name') || '').trim();
    const resolved = await resolveStudent(env, auth.phone, queryName);
    if (!resolved.ok) return Response.json({ error: resolved.error || '권한 없음' }, { status: 403 });
    const student = resolved.student;

    // reports/{이름}/ — 학생 본인 폴더만 OK
    if (folder.startsWith('reports/')) {
      const folderName = folder.slice('reports/'.length).split('/')[0];
      if (folderName !== student.name) {
        return Response.json({ error: '다른 학생의 자료에 접근할 수 없습니다.' }, { status: 403 });
      }
    }
    // test-results/{이름}/ — 학생 본인 테스트 결과 PDF만 OK (매쓰플랫 보고서 등)
    else if (folder.startsWith('test-results/')) {
      const folderName = folder.slice('test-results/'.length).split('/')[0];
      if (folderName !== student.name) {
        return Response.json({ error: '다른 학생의 테스트 결과에 접근할 수 없습니다.' }, { status: 403 });
      }
    }
    // class/{학원}_{반}/ — 학생의 학원/반과 일치해야 OK
    else if (folder.startsWith('class/')) {
      const classKey = folder.slice('class/'.length).split('/')[0];
      const expected = (student.school || '') + '_' + (student.className || '');
      if (classKey !== expected) {
        return Response.json({ error: '다른 반의 자료에 접근할 수 없습니다.' }, { status: 403 });
      }
    }
    // 그 외 폴더 — 사용자는 접근 불가
    else {
      return Response.json({ error: '사용자가 접근할 수 없는 폴더입니다.' }, { status: 403 });
    }
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
