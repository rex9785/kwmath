// GET /api/download-file?key=...&name=...
// - admin: Authorization: Bearer <ADMIN_PASSWORD>
// - 사용자: Authorization: Bearer <userToken>
//   - reports/{학생이름}/ · test-results/{학생이름}/ → 학생 본인 폴더만
//   - class/{학원}_{반}/ → 학생의 학원/반 폴더만
//   - materials/ → 공개 자료실(토큰 없이도 OK)
//   - 🔒 그 외 모든 경로는 관리자만. (2026-07-31 화이트리스트로 전환 — 아래 주석 참조)

import { requireAuth, resolveStudent } from './_auth.js';
import { absenceLockContext, isLocked, sessionDateFromText } from './_makeup.js';
import { logAudit } from './_auditlog.js';

// ═══════════════════════════════════════════════════════════════════════════
// 🔒 2026-07-31 — "막을 것만 적는 목록"(블랙리스트) → "열 것만 적는 목록"(화이트리스트)로 뒤집음.
//
//   블랙리스트가 두 번 뚫렸다. 새 R2 폴더를 만들 때 이 파일을 같이 고치는 걸 잊으면
//   그 폴더는 자동으로 "무인증 공개"가 되기 때문이다(안전한 쪽으로 기울지 않는 설계).
//     1) fcm-tokens/  — 전화번호만 알면 그 사람 폰 기기토큰·기종이 열렸다 (2026-07-31 1차 발견·차단)
//     2) backups/     — D1 전체 백업(학생·계정·전화번호·성적·질문 22개 테이블)이 통째로 열렸다.
//        실측: `GET /api/download-file?key=backups/2026-07-30.json` (인증 0, 쿠키 0) → **200, 258KB**.
//        파일명이 날짜라 추측도 쉽다. 1차보다 훨씬 크다.
//        같은 이유로 열려 있던 것들: night-push-queue/(알림 본문+수신자 명단) · archive/(퇴원생 스냅샷)
//        · staff/(조교 계정) · homework/(학생 제출 사진) · prefs/ · attendance/ · study/ · notices/ …
//
//   이제부터는 **아래 목록에 없는 모든 키는 관리자만** 받을 수 있다. 새 폴더가 생겨도 기본이 차단이다.
//   ※ 원장·조교는 _middleware.js가 세션을 `Bearer ADMIN_PASSWORD`로 번역하므로 isAdmin=true다.
// ═══════════════════════════════════════════════════════════════════════════

// 누구나(로그인 없이) 받을 수 있는 공개 자료 — materials.html 자료실.
const PUBLIC_PREFIXES = ['materials/'];

// 로그인한 학생·학부모가 "본인 것만" 받을 수 있는 폴더. 아래에서 이름/반 대조를 한다.
//   test-results/ = 학습 진단 보고서. 2026-07-31까지 아무 검증도 없어서 이름만 알면 열렸다 → 대조 추가.
const GUARDED_PREFIXES = ['reports/', 'class/', 'test-results/'];

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key) return Response.json({ error: 'key 파라미터 필요' }, { status: 400 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;

  if (!isAdmin) {
    const allowed = PUBLIC_PREFIXES.concat(GUARDED_PREFIXES).some((p) => key.startsWith(p));
    if (!allowed) {
      // 이건 정상 사용에서는 일어나지 않는다 → 남기면 "누가 뭘 긁어보려 했는지"가 그대로 남는다.
      await logAudit(env, request, {
        action: 'file.download.denied',
        target: key.slice(0, 200),
        summary: '허용 목록에 없는 경로를 인증 없이 요청',
        detail: { key, hasToken: !!token },
      });
      return Response.json({ error: '접근 권한이 없습니다.' }, { status: 403 });
    }
  }

  // 보호 폴더 접근 시 토큰 + 학생 매칭 검증
  if (!isAdmin && GUARDED_PREFIXES.some((p) => key.startsWith(p))) {
    const auth = await requireAuth(env, request);
    if (!auth.ok) return auth.response;

    const queryName = (url.searchParams.get('name') || '').trim();
    const resolved = await resolveStudent(env, auth.phone, queryName);
    if (!resolved.ok) return Response.json({ error: resolved.error || '권한 없음' }, { status: 403 });
    const student = resolved.student;

    // reports/{이름}/ · test-results/{이름}/ 둘 다 폴더 이름 = 학생 이름 → 같은 규칙으로 대조.
    if (key.startsWith('reports/') || key.startsWith('test-results/')) {
      const folderName = key.split('/')[1];
      if (folderName !== student.name) {
        await logAudit(env, request, {
          action: 'file.download.denied',
          actor: auth.phone || null,
          target: key.slice(0, 200),
          summary: '다른 학생 폴더 접근 시도',
          detail: { key, 요청자학생: student.name, 폴더: folderName },
        });
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
