// GET /api/download-file?key=...&name=...
// - admin: Authorization: Bearer <ADMIN_PASSWORD>
// - 사용자: Authorization: Bearer <userToken>
//   - reports/{학생이름}/ → 학생 본인 폴더만
//   - class/{학원}_{반}/ → 학생의 학원/반 폴더만
//   - 그 외 폴더(materials 등 공개)는 토큰 없이도 OK

import { requireAuth, resolveStudent } from './_auth.js';
import { absenceLockContext, isLocked, sessionDateFromText } from './_makeup.js';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key) return Response.json({ error: 'key 파라미터 필요' }, { status: 400 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;

  // 🔒 내부 전용 프리픽스 — download-file로 절대 노출 금지 (admin 제외).
  //    로그인 토큰·푸쉬구독·영상코드·라이브상태 등 운영 데이터. 프론트는 이 프리픽스를 받지 않음.
  // staff-shared/ = 원장→조교 전용 자료. 조교/원장은 /api/staff-materials로만 받고,
  //   일반(무인증·학생) 다운로드는 여기서 차단(공개 유출 방지). admin 토큰은 아래 isAdmin으로 통과.
  const INTERNAL_PREFIXES = ['auth/', 'video-codes/', 'push-subs/', 'study-live/', 'staff-shared/'];
  if (!isAdmin && INTERNAL_PREFIXES.some((p) => key.startsWith(p))) {
    return Response.json({ error: '접근 권한이 없습니다.' }, { status: 403 });
  }

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
      // 업로드 폴더는 class/{학원}_{반}/ 구조 → 학원(academy)으로 비교 (학교 school 아님)
      const expected = (student.academy || '') + '_' + (student.className || '');
      if (classKey !== expected) {
        return Response.json({ error: '다른 반의 자료에 접근할 수 없습니다.' }, { status: 403 });
      }
      // 🔒 결석·병결·공결한 날의 수업자료(파일명 6자리 YYMMDD)는 인강 승인 전까지 다운로드 차단.
      const gd = sessionDateFromText((key.split('/').pop() || ''));
      if (gd) {
        try {
          const ctx = await absenceLockContext(env, student.id);
          if (isLocked(ctx, gd)) {
            return Response.json({ error: '결석한 날의 자료입니다. 앱에서 인강 신청 후 선생님 승인이 필요합니다.' }, { status: 403 });
          }
        } catch (_) { /* 판정 실패 시 기존 접근 규칙만 적용 */ }
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
