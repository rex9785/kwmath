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
import { getStaffRecord } from './api/_staff.js';
import { normalizePhone } from './api/_auth.js';

const PRIMARY_ORIGIN = 'https://kwmath.co.kr';

// 정확히 일치할 때만 공개(*) — notices-write 등 -write/관리 엔드포인트는 자동으로 제외됨
const PUBLIC_API = new Set([
  '/api/notices',
  '/api/reviews',
  '/api/class-options',
  '/api/materials',
  '/api/timetable',
  '/api/clips',
  '/api/app-version',   // 강제업데이트 최소버전 조회(GET) — 앱 부팅 때 무인증 호출
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
  '/api/inquiry',          // 홈페이지 상담 문의(리드=학부모 연락처) — 원장 전용
  // '/api/surveys'는 staffAllowed 특례로 처리(조교=퀴즈만). surveys.js가 X-Staff-Phone로 quiz=1 전용 강제.
]);
const STAFF_WRITE_ALLOW = new Set([
  '/api/push-subscribe',   // 조교 본인 알림 구독/해제
  '/api/push-register-fcm',// 조교 본인 앱 FCM 토큰 등록/해제
  '/api/staff-worklog',    // 조교 본인 근무기록 입력/수정/삭제 (POST·DELETE) — 신원은 X-Staff-Phone로 서버가 강제
  '/api/attendance',       // 조교: 자기 학원 학생 출결 입력/삭제 (POST·DELETE) — 학원 스코프는 attendance.js가 X-Staff-Phone로 강제
  '/api/scores',           // 조교: 자기 학원 학생 성적 입력/삭제 (POST·DELETE) — 학원 스코프는 scores.js가 X-Staff-Phone로 강제
  '/api/clinic',           // 조교: 자기 학원 학생 클리닉 출결/성취도/시간 입력·삭제 (POST·DELETE) — 학원 스코프는 clinic.js가 X-Staff-Phone로 강제
  '/api/clinic-roster',    // 조교: 자기 학원 학생 클리닉 필수명단 수동 추가/제외 (POST) — 학원 스코프는 clinic-roster.js가 X-Staff-Phone로 강제
  '/api/notifications',    // 조교: 자기 학원 학생 클리닉 미참석 연락 (POST action=create type=clinic_absent) — 학원 스코프·정형알림 강제는 notifications.js가 X-Staff-Phone로 처리
]);
function staffAllowed(url, method) {
  const pathname = url.pathname;
  // 질문방: 열람(GET) + 답변(PATCH)만 허용.
  //   삭제(DELETE)·질문생성(POST)·사용량/한도설정(?usage=1)은 원장 전용으로 차단.
  if (pathname === '/api/qna') {
    if (url.searchParams.get('usage') === '1') return false;   // AI 사용량·비용·한도 = 원장 전용
    return method === 'GET' || method === 'PATCH';
  }
  // 설문/조사: 조교는 '퀴즈만' 만들고 채점결과까지 볼 수 있게 허용(GET·POST·PATCH·DELETE).
  //   ⚠️ 일반 설문·모든 응답(학생·학부모 개인정보)은 원장 전용 — 이 퀴즈전용 제한은 surveys.js가
  //      X-Staff-Phone(검증된 조교 신원) 존재로 quiz=1만 통과시켜 서버측에서 강제한다.
  if (pathname === '/api/surveys') {
    return method === 'GET' || method === 'POST' || method === 'PATCH' || method === 'DELETE';
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

      // staffPhone이 주어지면 다운스트림에 X-Staff-Phone(검증된 신원)을 실어 보낸다.
      //   ⚠️ 클라이언트가 직접 넣은 X-Staff-Phone은 항상 지운 뒤(스푸핑 방지) 토큰에서 나온 값만 세팅.
      //   원장(adm_)·쿠키 경로는 staffPhone 없음 → 헤더도 안 붙음(= 전체 접근).
      const translate = (staffPhone) => {
        const h = new Headers(context.request.headers);
        h.set('Authorization', 'Bearer ' + env.ADMIN_PASSWORD);
        h.delete('X-Staff-Phone');                       // 외부 주입 차단(필수)
        if (staffPhone) h.set('X-Staff-Phone', staffPhone);
        forwardRequest = new Request(context.request, { headers: h });
      };

      if (isAdminSessionToken(bearer)) {
        // 원장(adm_) 풀권한 세션 — 기존 동작 그대로 (X-Staff-Phone 없음 → 전체 열람)
        if (await verifyAdminSession(env, bearer)) translate();
      } else if (isStaffSessionToken(bearer)) {
        // 조교(ast_) 제한 세션 — 허용 경로만 번역, 그 외 403. 토큰에 박힌 전화번호를 X-Staff-Phone로 전달.
        const sv = await verifyStaffSession(env, bearer);
        if (sv) {
          // 조교 실시간 유효성 — 원장이 권한 해제(레코드 삭제)했거나 미승인이면, 이미 발급된 ast_ 토큰도 즉시 무효.
          //   (ast_는 무상태 서명이라 서명검증만으론 안 죽음 → 매 요청 R2 조교 레코드로 현재 승인상태 확인 = 권한해제 즉시 반영.
          //    이 검사가 qna 등 레코드를 스스로 안 보는 경로의 마지막 구멍까지 닫음. R2 오류 시 fail-closed=재로그인 유도.)
          const staffRec = await getStaffRecord(env, normalizePhone(sv.phone) || sv.phone);
          if (!staffRec || staffRec.approved !== true) {
            return new Response(
              JSON.stringify({ error: '조교 권한이 해제되었어요. 다시 로그인해주세요.' }),
              { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': acao } }
            );
          }
          if (staffAllowed(url, method)) {
            translate(sv.phone);   // ← 검증된 조교 신원(숫자만)
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
