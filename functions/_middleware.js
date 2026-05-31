// CORS 전역 처리 미들웨어
// 공개 read API(아래 PUBLIC_API)만 모든 origin 허용(*).
// 그 외(인증·admin·학생정보·출결·리포트·영상·파일·쓰기 API)는 kwmath.co.kr origin만 허용.
// ※ 홈페이지/PWA는 same-origin이라 CORS 검사를 안 받음 → 정상 동작에 영향 없음.
//    MathOS는 Python 로컬앱이라 CORS 무관(브라우저 전용 규칙).

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

  const response = await context.next();
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('Access-Control-Allow-Origin', acao);
  return newResponse;
}
