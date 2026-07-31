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
  renewAdminSessionIfDue, renewStaffSessionIfDue,
} from './api/_admin.js';
import { getStaffRecord } from './api/_staff.js';
import { normalizePhone, verifyToken } from './api/_auth.js';
import { logEvent, classifyPath } from './api/_eventlog.js';

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
  '/api/admin-analytics',  // AI 사용량·비용 (원장 전용)
  '/api/admin-seed-demo',
  '/api/admin-seed-test',
  '/api/cron-health',      // 크론(스케줄러) 생존 점검 — 원장 콘솔 전용
  '/api/inquiry',          // 홈페이지 상담 문의(리드=학부모 연락처) — 원장 전용
  // 🔴 2026-07-31 — 변경이력(감사로그). 조교가 무엇을 만졌는지, 비밀번호 초기화·관리자 로그인,
  //    삭제된 데이터의 원본값(before)까지 전부 들어 있다. 조교가 보면 서로를 감시하게 되고
  //    before 에 담긴 학생 개인정보가 통째로 샌다. audit-log.js 안에서도 한 번 더 막는다(이중 잠금).
  '/api/audit-log',
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
  '/api/clinic-review',    // 조교: 자기 학원 학생 클리닉 총평 초안 저장·수정·삭제 + 하루메모 (POST save/saveMemo·DELETE) — 학원 스코프는 clinic-review.js가 X-Staff-Phone로 강제. 발송(action=send)은 API가 원장 전용으로 재차 차단.
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
  // 과제방: 조교는 열람(GET) + 「확인 ✓」 도장(POST ?admin=1&action=check)만.
  //   과제 생성·마감토글(POST admin=1)과 과제 삭제(DELETE)는 원장 전용 — action을 콕 집어 여는 이유가 이것.
  //   도장은 되돌릴 수 있고 아무것도 지우지 않는 최소 권한이라 조교에게 열어도 안전하다.
  //   담당 학원 강제는 homework.js가 staffScopeAcademy + student_id로 서버측에서 재차 확인한다.
  if (pathname === '/api/homework') {
    if (method === 'GET') return true;
    return method === 'POST'
      && url.searchParams.get('admin') === '1'
      && url.searchParams.get('action') === 'check';
  }
  if (method === 'GET') return !STAFF_GET_BLOCK.has(pathname);  // 열람 전반 허용
  return STAFF_WRITE_ALLOW.has(pathname);                      // 쓰기는 화이트리스트만
}

export async function onRequest(context) {
  const acao = allowOrigin(context.request);
  let logIdentity = {};   // 접근로깅용 신원 — 원장/조교는 아래 토큰검증에서 채움
  let clientBearer = '';  // 원본 Bearer — 학생/학부모 포털토큰 백그라운드 해석용
  let renewedToken = '';  // 🔄 원장·조교 로그인 유지 — 갱신할 때가 됐으면 새 토큰(응답헤더로 내려감)

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

  // ═══════════════════════════════════════════════════════════════════════════
  // 🔒 2026-07-31 (2차 보완) — 신원 헤더 **무조건 세척**.
  //   이 세 헤더는 미들웨어만 붙일 수 있어야 한다. 그런데 처음엔 translate() 안에서만 지웠다.
  //   translate()는 (a) /api/ 경로이고 (b) ADMIN_PASSWORD가 있고 (c) 원장/조교 세션이 검증된
  //   경우에만 돈다. 즉 **익명 요청·학생 요청·/api/가 아닌 경로·비번 원본 직접 호출**에서는
  //   클라이언트가 손으로 넣은 X-Staff-Phone이 그대로 다운스트림에 도착했다.
  //   _auditlog.actorOf()는 이 헤더를 제일 먼저 믿으므로, 아무나 남의 조교 번호를 적어 보내면
  //   감사로그의 '누가'가 그 사람 이름으로 찍힌다 = 로그를 통째로 못 믿게 된다.
  //   → 요청이 무엇이든 들어오자마자 지운다. 붙이는 건 아래 translate()만.
  // ═══════════════════════════════════════════════════════════════════════════
  const SPOOFABLE = ['X-Staff-Phone', 'X-Staff-Name', 'X-Kw-Actor-Role'];
  let fwdHeaders = null;   // 다운스트림에 보낼 헤더 — 손댈 일이 있을 때만 만든다
  try {
    if (SPOOFABLE.some((k) => context.request.headers.has(k))) {
      fwdHeaders = new Headers(context.request.headers);
      for (const k of SPOOFABLE) fwdHeaders.delete(k);
    }
  } catch (_) {}

  try {
    const env = context.env;
    if (env && env.ADMIN_PASSWORD && new URL(context.request.url).pathname.startsWith('/api/')) {
      const url = new URL(context.request.url);
      const pathname = url.pathname;
      const method = context.request.method.toUpperCase();
      const authz = context.request.headers.get('Authorization') || '';
      const bearer = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
      clientBearer = bearer;

      // staffPhone이 주어지면 다운스트림에 X-Staff-Phone(검증된 신원)을 실어 보낸다.
      //   ⚠️ 클라이언트가 직접 넣은 X-Staff-Phone은 항상 지운 뒤(스푸핑 방지) 토큰에서 나온 값만 세팅.
      //   원장(adm_)·쿠키 경로는 staffPhone 없음 → 헤더도 안 붙음(= 전체 접근).
      //
      // 📓 2026-07-31 — 관우T 지시 "어떤 조교가 뭘 만졌고 뭘 바꿨는지도 로그에 남겨야 돼".
      //   여기서 Bearer를 ADMIN_PASSWORD로 바꿔치기하기 때문에, 다운스트림 API는 원장인지 조교인지,
      //   조교라면 누구인지 알 방법이 없었다(감사로그에 '__admin__' 한 덩어리로만 찍혔다).
      //   → 신원을 두 개 더 실어 보낸다. 어차피 조교 레코드(staffRec)는 위에서 이미 읽었으므로 공짜다.
      //     X-Kw-Actor-Role : 'owner' | 'staff'  ← ADMIN_PASSWORD 원본을 직접 쓰는 호출(MathOS·크론)과 구분됨
      //     X-Staff-Name    : 조교 이름. **헤더는 ASCII만 실을 수 있어 한글 이름이 들어가면 예외가 난다**
      //                       → encodeURIComponent로 감싼다. 읽는 쪽(_auditlog.actorOf)이 디코드한다.
      //   ⚠️ 이 두 개도 X-Staff-Phone과 똑같이 **먼저 지운 뒤** 세팅한다(외부 주입 차단).
      const translate = (staffPhone, staffName) => {
        // 위에서 이미 세척한 헤더가 있으면 그걸 이어 쓴다(없으면 지금 만든다).
        const h = fwdHeaders || new Headers(context.request.headers);
        h.set('Authorization', 'Bearer ' + env.ADMIN_PASSWORD);
        h.delete('X-Staff-Phone');                       // 외부 주입 차단(필수)
        h.delete('X-Staff-Name');
        h.delete('X-Kw-Actor-Role');
        if (staffPhone) h.set('X-Staff-Phone', staffPhone);
        if (staffName) {
          try { h.set('X-Staff-Name', encodeURIComponent(String(staffName).slice(0, 40))); } catch (_) {}
        }
        h.set('X-Kw-Actor-Role', staffPhone ? 'staff' : 'owner');
        fwdHeaders = h;
      };

      if (isAdminSessionToken(bearer)) {
        // 원장(adm_) 풀권한 세션 — 기존 동작 그대로 (X-Staff-Phone 없음 → 전체 열람)
        if (await verifyAdminSession(env, bearer)) {
          translate(); logIdentity = { role: 'owner' };
          renewedToken = (await renewAdminSessionIfDue(env, bearer)) || '';   // 🔄 계속 로그인
        }
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
            translate(sv.phone, staffRec.name);   // ← 검증된 조교 신원(숫자만) + 이름(감사로그용)
            logIdentity = { role: 'staff', phone: normalizePhone(sv.phone) || null };
            renewedToken = (await renewStaffSessionIfDue(env, bearer, sv.phone)) || '';   // 🔄 계속 로그인
          } else {
            return new Response(
              JSON.stringify({ error: '조교 권한으로는 이 작업을 할 수 없어요. (열람·질문답변만 가능)' }),
              { status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': acao } }
            );
          }
        }
      } else if (!authz) {
        const ck = readCookie(context.request, 'admin_session');     // 쿠키 전용 경로(미래)
        if (isAdminSessionToken(ck) && await verifyAdminSession(env, ck)) { translate(); logIdentity = { role: 'owner' }; }
      }
    }
  } catch (_) {}

  // 헤더를 손댄 경우에만 요청 객체를 새로 만든다. **딱 한 번만** 만드는 게 중요하다 —
  //   같은 요청으로 Request를 두 번 만들면 본문 스트림이 잠겨 POST/PATCH 본문이 깨질 수 있다.
  if (fwdHeaders) {
    try { forwardRequest = new Request(context.request, { headers: fwdHeaders }); } catch (_) { forwardRequest = null; }
  }

  const response = forwardRequest ? await context.next(forwardRequest) : await context.next();
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('Access-Control-Allow-Origin', acao);

  // 🔄 원장·조교 로그인 유지 — 갱신된 토큰을 응답헤더로 내려보낸다.
  //   받는 쪽 = /session-keep.js (localStorage 'kwmath_admin_token'에 덮어씀).
  //   Expose-Headers가 없으면 스크립트가 이 헤더를 못 읽는다(same-origin이라 대개 되지만 명시).
  if (renewedToken) {
    newResponse.headers.set('X-Kw-Session', renewedToken);
    newResponse.headers.set('Access-Control-Expose-Headers', 'X-Kw-Session');
  }

  // ── 접근 로깅(조용히 기록만) — page·api만, 정적자원 제외. 백그라운드라 응답을 안 막음.
  try {
    const pth = new URL(context.request.url).pathname;
    const kind = classifyPath(pth);
    if (kind) {
      const method = context.request.method;
      const status = newResponse.status;
      const ident = logIdentity;
      const cb = clientBearer;
      const task = (async () => {
        let id2 = ident;
        // 학생/학부모 포털 토큰(64 hex)은 백그라운드에서 신원 해석 → 응답 지연 0.
        if (!id2.phone && cb && /^[0-9a-f]{64}$/i.test(cb)) {
          try { const p = await verifyToken(context.env, cb); if (p && p.phone) id2 = { role: 'user', phone: p.phone }; } catch (_) {}
        }
        await logEvent(context.env, context.request, {
          kind, method, path: pth, status,
          role: id2.role || null, phone: id2.phone || null,
        });
      })();
      if (typeof context.waitUntil === 'function') context.waitUntil(task);
      else if (task && typeof task.catch === 'function') task.catch(() => {});
    }
  } catch (_) { /* 로깅 실패는 실제 요청을 막지 않음 */ }

  return newResponse;
}
