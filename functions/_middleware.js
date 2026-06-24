// CORS 전역 처리 미들웨어
// 공개 read API(아래 PUBLIC_API)만 모든 origin 허용(*).
// 그 외(인증·admin·학생정보·출결·리포트·영상·파일·쓰기 API)는 kwmath.co.kr origin만 허용.
// ※ 홈페이지/PWA는 same-origin이라 CORS 검사를 안 받음 → 정상 동작에 영향 없음.
//    MathOS는 Python 로컬앱이라 CORS 무관(브라우저 전용 규칙).
//
// + 관리자 세션 번역: admin.html이 보낸 서명 세션 토큰(adm_)을 검증해서
//   다운스트림 endpoint엔 기존 Authorization: Bearer <ADMIN_PASSWORD>로 바꿔 전달한다.
//   → admin endpoint 31개와 admin.html 모두 무수정. 비번 원본은 클라이언트에 안 남음.
import {
  verifyAdminSession, isAdminSessionToken, readCookie,
  verifyStaffSession, isStaffSessionToken,
} from './api/_admin.js';

const PRIMARY_ORIGIN = 'https://kwmath.co.kr';

// 정확히 일치할 때만 공개(*) — notices-write 등 -write/관리 엔드포인트는 자동으로 제외됨
const PUBLIC_API = new Set([
  '/api/notices',
  '/api/reviews',
  '/api/class-options',
  '/api/materials',
  '/api/timetable',
  '/api/clips',
]);

function allowOrigin(request) {
  let pathname = '/';
  try { pathname = new URL(request.url).pathname; } catch (_) {}
  return PUBLIC_API.has(pathname) ? '*' : PRIMARY_ORIGIN;
}

// ── 조교(ast_) 권한 스코프 ──
// 조교는 '열람(GET 전반) + 질문답변(/api/qna)'만 가능. 쓰기·삭제·계정·민감조회는 차단.
// 아래 GET 차단 목록은 데이터가 새면 안 되는 민감 조회만(파괴적 엔드포인트는 GET 미구현이라 자동 405).
const STAFF_GET_BLOCK = new Set([
  '/api/staff-approve',    // 다른 조교 목록·승인 (원장 전용)
  '/api/admin-accounts',   // 계정 목록
  '/api/admin-analytics',  // AI 사용량·비용 (원장 전용)
  '/api/admin-seed-demo',
  '/api/admin-seed-test',
]);
const STAFF_WRITE_ALLOW = new Set([
  '/api/push-subscribe',   // 조교 본인 알림 구독/해제
]);
function staffAllowed(url, method) {
  const pathname = url.pathname;
  // 질문방: 열람(GET) + 답변(PATCH)만 허용.
  //   삭제(DELETE)·질문생성(POST)·사용량/한도설정(?usage=1)은 원장 전용으로 차단.
  if (pathname === '/api/qna') {
    if (url.searchParams.get('usage') === '1') return false;   // AI 사용량·비용·한도 = 원장 전용
    return method === 'GET' || method === 'PATCH';
  }
  if (method === 'GET') return !STAFF_GET_BLOCK.has(pathname);  // 열람 전반 허용
  return STAFF_WRITE_ALLOW.has(pathname);                      // 쓰기는 화이트리스트만
}

export async function onRequest(context) {
  const acao = allowOrigin(context.request);

  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': acao,
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      },
    });
  }

  // 관리자/조교 세션 토큰 → 다운스트림엔 Bearer ADMIN_PASSWORD로 번역.
  //   adm_ (원장)  : 전체 허용.
  //   ast_ (조교)  : 열람·질문답변 경로만 허용, 그 외엔 403.
  //   학생/공개 요청(다른 Bearer 또는 무인증)은 절대 건드리지 않음(권한 상승 방지).
  let forwardRequest = null;
  try {
    const env = context.env;
    if (env && env.ADMIN_PASSWORD && new URL(context.request.url).pathname.startsWith('/api/')) {
      const url = new URL(context.request.url);
      const pathname = url.pathname;
      const method = context.request.method.toUpperCase();
      const authz = context.request.headers.get('Authorization') || '';
      const bearer = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';

      const translate = () => {
        const h = new Headers(context.request.headers);
        h.set('Authorization', 'Bearer ' + env.ADMIN_PASSWORD);
        forwardRequest = new Request(context.request, { headers: h });
      };

      if (isAdminSessionToken(bearer)) {
        // 원장(adm_) 풀권한 세션 — 기존 동작 그대로
        if (await verifyAdminSession(env, bearer)) translate();
      } else if (isStaffSessionToken(bearer)) {
        // 조교(ast_) 제한 세션 — 허용 경로만 번역, 그 외 403
        if (await verifyStaffSession(env, bearer)) {
          if (staffAllowed(url, method)) {
            translate();
          } else {
            return new Response(
              JSON.stringify({ error: '조교 권한으로는 이 작업을 할 수 없어요. (열람·질문답변만 가능)' }),
              { status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': acao } }
            );
          }
        }
      } else if (!authz) {
        const ck = readCookie(context.request, 'admin_session');     // 쿠키 전용 경로(미래)
        if (isAdminSessionToken(ck) && await verifyAdminSession(env, ck)) translate();
      }
    }
  } catch (_) {}

  const response = forwardRequest ? await context.next(forwardRequest) : await context.next();
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('Access-Control-Allow-Origin', acao);
  return newResponse;
}
