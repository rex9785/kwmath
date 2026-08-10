// POST /api/auth/login
// body: { phone, password }
// 응답(학생/학부모): { ok, role:'student', token, expires, mustChangePassword, phone, students:[...], isAdmin:false }
// 응답(원장 관우T):   { ok, role:'owner', isAdmin:true, phone, adminToken }       ← adm_ 세션 → 프론트가 /admin
// 응답(조교 운영진):  { ok, role:'staff', isStaff:true, phone, name, staffToken } ← ast_ 세션 → 프론트가 /admin-qna
//   ※ 운영진(원장·조교)은 학생 레코드가 없어도 로그인됨(학생 검사보다 먼저 분기).

import {
  normalizePhone, verifyPassword, issueToken, touchLastLogin,
  findAccountByPhone, fetchStudentsByPhone, jsonError, canSignIn, isCompleted,
} from '../_auth.js';
import { issueAdminSession, issueStaffSession } from '../_admin.js';
import { getStaffRecord } from '../_staff.js';
import { checkLockout, recordFailure, clearLockout, fmtRetry } from '../_lockout.js';
import { logEvent } from '../_eventlog.js';
import { logAudit, describeDevice } from '../_auditlog.js';

// 운영진(원장) 번호 — 원장 식별 (staff-register.js·me.js와 동일하게 유지)
const ADMIN_PHONES = ['01041149785'];
const onlyDigits = (p) => String(p || '').replace(/\D/g, '');

// 📓 2026-07-31 — 로그인은 이 앱에서 가장 많이 일어나는 행위인데 여태 감사기록이 없었다.
//   _eventlog(logEvent)는 성공 로그인만, 그것도 **120일 뒤 자동 삭제**되는 트래픽 통계용이다.
//   "누가 언제 어떤 폰으로 로그인했나 / 왜 못 들어갔나(잠김·미승인·승인대기·좀비계정)"는
//   지금까지 어디에도 안 남아, 학부모가 "로그인이 안 돼요" 하면 재현 말고는 방법이 없었다.
//   여기서 남기는 audit_log는 지워지지 않는다.
//   🔴 비밀번호는 원문·해시·솔트 **무엇도 남기지 않는다**. 입력 길이만 남긴다.
//   로그인 전이라 actorOf()가 아무것도 못 잡으므로 행위자를 직접 지정한다.
async function 로그인로그(env, request, phone, fields) {
  const ua = request.headers.get('user-agent') || '';
  await logAudit(env, request, {
    actor: phone || '(번호 미입력)', actorRole: fields.actorRole || 'anonymous',
    actorName: fields.actorName || '',
    target: phone || '(번호 미입력)', targetName: fields.targetName || '',
    action: fields.action, summary: fields.summary,
    detail: {
      휴대폰: phone || '(입력 안 됨)',
      기기: describeDevice(ua) || '(알 수 없음)',
      ...fields.detail,
      비고: '비밀번호는 원문·해시·솔트 모두 로그에 남기지 않는다(입력 길이만).'
        + ' 성공 로그인은 방문통계(_eventlog)에도 따로 쌓이지만 그건 120일 뒤 지워진다 — 이 기록이 영구본이다.',
    },
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return jsonError('POST만 허용', 405);

  let body = {};
  try { body = await request.json(); } catch (_) {}

  const phone = normalizePhone(body.phone || '');
  const password = (body.password || '').toString();

  if (!phone) {
    await 로그인로그(env, request, '', {
      action: 'login.reject', summary: '로그인 거절 — 휴대폰 번호 형식이 올바르지 않음',
      detail: {
        보낸번호: String(body.phone || '').slice(0, 40) || '(빈 값)',
        사유: '숫자 10~11자리가 아니라 010-XXXX-XXXX로 정규화가 안 됨',
        비밀번호입력: password ? password.length + '자 입력됨' : '입력 안 됨',
        효과: '로그인 화면에 "휴대폰 번호를 정확히 입력해주세요"가 뜨고 끝난다 — 계정 조회 자체를 안 한다',
      },
    });
    return jsonError('휴대폰 번호를 정확히 입력해주세요.', 400);
  }
  if (!password) {
    await 로그인로그(env, request, phone, {
      action: 'login.reject', summary: '로그인 거절 — 비밀번호를 안 넣음',
      detail: { 사유: '비밀번호 칸이 비어 있음', 효과: '계정 조회·실패횟수 누적 없이 즉시 반려(잠금에 영향 없음)' },
    });
    return jsonError('비밀번호를 입력해주세요.', 400);
  }

  // ── 무차별 대입(brute-force) 방어: 이미 잠긴 계정이면 즉시 거절 ──
  const lock = await checkLockout(env, phone);
  if (lock.locked) {
    // 📓 잠긴 동안에도 계속 시도가 들어오면 그 자체가 신호다(본인이 헤매는 중 vs 남이 두드리는 중).
    await 로그인로그(env, request, phone, {
      action: 'login.locked', summary: '로그인 차단 — 이미 잠긴 계정에 다시 시도 (' + fmtRetry(lock.retryAfterSec) + ' 남음)',
      detail: {
        누적실패횟수: lock.failCount,
        남은잠금: fmtRetry(lock.retryAfterSec) + ' (' + lock.retryAfterSec + '초)',
        비밀번호입력: password.length + '자 입력됨',
        사유: '연속 5회 이상 틀려 잠긴 상태 — 비밀번호가 맞아도 이번엔 통과 못 한다',
        효과: '시간이 지나면 스스로 풀린다(최대 60분). 원장이 비밀번호를 초기화해주면 즉시 풀린다',
      },
    });
    return jsonError(
      `비밀번호를 여러 번 잘못 입력해 로그인이 일시 제한되었습니다. 약 ${fmtRetry(lock.retryAfterSec)} 후 다시 시도하시거나, 관우T께 비밀번호 초기화를 요청해주세요.`,
      429,
    );
  }

  // 계정 조회
  const account = await findAccountByPhone(env, phone);
  if (!account) {
    // 📓 "가입했는데 로그인이 안 된다"는 문의의 절대다수가 여기다(승인 전이라 계정이 아직 없음).
    //   ⚠️ 없는 번호는 실패횟수도 안 쌓인다 → 번호 대입 공격이 잠금 없이 무한 반복 가능(알려진 한계).
    await 로그인로그(env, request, phone, {
      action: 'login.fail.noaccount', summary: '로그인 실패 — 등록되지 않은 휴대폰 번호',
      detail: {
        비밀번호입력: password.length + '자 입력됨',
        사유: 'accounts 표에 이 번호가 없음 — 가입 신청만 하고 아직 원장 승인이 안 났거나, 번호를 잘못 입력했거나, 탈퇴한 계정',
        실패횟수누적: '안 됨(존재하지 않는 번호라 잠금 대상이 아님)',
        효과: '"등록되지 않은 휴대폰 번호입니다" 안내. 원장이 승인하면 그 순간 계정이 만들어지고 0000으로 로그인된다',
      },
    });
    return jsonError('등록되지 않은 휴대폰 번호입니다. 관우T께 문의해주세요.', 401);
  }

  // 비밀번호 검증
  const ok = await verifyPassword(password, account.hash, account.salt);
  if (!ok) {
    // 실패 1회 기록 → 누적 5회째부터 잠금(점점 길어짐)
    const f = await recordFailure(env, phone);
    // 📓 비밀번호 틀림은 "본인이 까먹은 것"과 "남이 두드리는 것"이 겉으로 똑같다.
    //   기기·시각·누적횟수가 같이 남아야 나중에 구분할 수 있다.
    await 로그인로그(env, request, phone, {
      action: f.locked ? 'login.fail.password.lock' : 'login.fail.password',
      summary: '로그인 실패 — 비밀번호 불일치 (누적 ' + f.failCount + '회)'
        + (f.locked ? ' → ' + fmtRetry(f.retryAfterSec) + ' 잠금' : ''),
      detail: {
        비밀번호입력: password.length + '자 입력됨',
        누적실패횟수: f.failCount,
        잠김: f.locked ? '예 — ' + fmtRetry(f.retryAfterSec) + ' 동안 잠금' : '아니오',
        잠금까지남은횟수: f.locked ? 0 : Math.max(0, 5 - f.failCount),
        계정에강제변경걸림: account.mustChangePassword ? '예(0000으로 초기화된 상태 — 0000을 넣어야 한다)' : '아니오',
        효과: f.locked
          ? '이 번호는 지금부터 잠금 시간 동안 비밀번호가 맞아도 못 들어간다. 원장이 초기화하면 즉시 풀린다'
          : '아직 잠기지 않음. 5회째부터 1분 → 5분 → 15분 → 60분(상한)으로 늘어난다',
      },
    });
    if (f.locked) {
      return jsonError(
        `비밀번호를 여러 번 잘못 입력해 로그인이 약 ${fmtRetry(f.retryAfterSec)} 제한됩니다. 관우T께 비밀번호 초기화를 요청하시면 즉시 풀 수 있어요.`,
        429,
      );
    }
    const left = Math.max(0, 5 - f.failCount);
    const tail = left > 0 && left <= 2 ? ` (${left}회 더 틀리면 일시 잠금)` : '';
    return jsonError('비밀번호가 일치하지 않습니다.' + tail, 401);
  }

  // 비밀번호 정답 → 누적 실패 기록 초기화(잠금 해제)
  //   📓 지우기 전 값을 들고 간다 — "몇 번 헤매다 들어왔는지"가 로그에 남아야 의미가 있다(추가 조회 없음).
  const 전누적실패 = lock.failCount || 0;
  await clearLockout(env, phone);

  // 마지막 로그인 시각 (비치명적)
  touchLastLogin(env, account.id);

  // ════════ 운영진(원장·조교) 분기 — 학생 레코드 없이도 로그인 ════════
  // 학생 검사보다 먼저 처리해서, 관우T가 학생 명단에서 빠져도(또는 빠지기 전에도) 로그인 가능.
  const digits = onlyDigits(phone);

  // 원장(관우T): adm_ 풀권한 세션 발급 → 프론트가 localStorage['kwmath_admin_token']에 저장 후 /admin.
  if (ADMIN_PHONES.includes(digits)) {
    const adminToken = await issueAdminSession(env);
    if (!adminToken) {
      await 로그인로그(env, request, phone, {
        actorRole: 'owner', actorName: '관우T', targetName: '관우T',
        action: 'login.fail.session', summary: '원장 로그인 실패 — ADMIN_PASSWORD 미설정으로 관리자 세션을 못 만듦',
        detail: {
          사유: 'Cloudflare 환경변수 ADMIN_PASSWORD가 비어 있어 adm_ 세션 서명을 못 한다',
          효과: '비밀번호는 맞았는데도 원장이 /admin에 못 들어간다. 배포 설정 문제이지 계정 문제가 아니다',
        },
      });
      return jsonError('관리자 세션 설정이 누락됐습니다. (ADMIN_PASSWORD 미설정)', 500);
    }
    await logEvent(env, request, { kind: 'login', phone, role: 'owner', name: '관우T' });
    // 🔴 원장 로그인 = 전체 권한 세션(adm_) 발급. 이 세션 하나로 모든 학생·성적·삭제가 가능해진다.
    //   내가 안 한 시각·모르는 기기가 찍혀 있으면 그게 곧 사고 신호다.
    await 로그인로그(env, request, phone, {
      actorRole: 'owner', actorName: '관우T', targetName: '관우T',
      action: 'login.owner', summary: '원장 로그인 성공 — 전체 권한 세션(adm_) 발급',
      detail: {
        역할: '원장(관우T)',
        직전누적실패: 전누적실패 + '회' + (전누적실패 ? ' (이번 성공으로 초기화됨)' : ''),
        발급세션: 'adm_ 관리자 세션 (30일)',
        비밀번호강제변경: account.mustChangePassword ? '걸려 있음' : '없음',
        효과: '이 세션으로 모든 학생·성적·출결·삭제·발송이 가능하다. 모르는 기기가 찍혀 있으면 즉시 비밀번호를 바꿔야 한다',
      },
    });
    return Response.json({ ok: true, role: 'owner', isAdmin: true, phone, adminToken });
  }

  // 조교(운영진): 승인된 경우에만 ast_ 제한세션 발급 → /admin-qna. 미승인은 안내 후 거절.
  const staff = await getStaffRecord(env, phone);
  if (staff) {
    if (!staff.approved) {
      await 로그인로그(env, request, phone, {
        actorRole: 'staff', actorName: staff.name || '', targetName: staff.name || '',
        action: 'login.blocked.staff.unapproved',
        summary: '조교 로그인 차단 — 아직 원장 승인 전 (' + (staff.name || '이름없음') + ')',
        detail: {
          조교이름: staff.name || '(없음)',
          신청시각: staff.createdAt || '(기록 없음)',
          배정학원: staff.academy || '(미배정)',
          사유: '비밀번호는 맞았지만 조교 레코드의 approved가 아직 false',
          효과: '원장이 조교 승인 화면에서 승인해야 같은 번호·비밀번호로 들어올 수 있다. 승인 전엔 학생 정보를 하나도 못 본다',
        },
      });
      return jsonError('조교 가입이 아직 승인되지 않았습니다. 관우T 승인 후 같은 번호·비밀번호로 로그인하실 수 있어요.', 403);
    }
    const staffToken = await issueStaffSession(env, phone);
    if (!staffToken) {
      await 로그인로그(env, request, phone, {
        actorRole: 'staff', actorName: staff.name || '', targetName: staff.name || '',
        action: 'login.fail.session', summary: '조교 로그인 실패 — ADMIN_PASSWORD 미설정으로 조교 세션을 못 만듦',
        detail: { 사유: 'Cloudflare 환경변수 ADMIN_PASSWORD가 비어 있어 ast_ 세션 서명을 못 한다',
                  효과: '비밀번호는 맞았는데도 조교가 못 들어간다. 배포 설정 문제이지 계정 문제가 아니다' },
      });
      return jsonError('운영진 세션 설정이 누락됐습니다. (ADMIN_PASSWORD 미설정)', 500);
    }
    await logEvent(env, request, { kind: 'login', phone, role: 'staff', name: staff.name || '' });
    // 🔴 조교 로그인 = ast_ 제한세션 발급. 이 순간부터 이 조교가 남기는 모든 기록의 행위자가 이 사람이 된다.
    //   "어떤 조교가 뭘 만졌나"를 추적할 때 이 로그가 출발점(세션 시작 시각·기기)이다.
    await 로그인로그(env, request, phone, {
      actorRole: 'staff', actorName: staff.name || '', targetName: staff.name || '',
      action: 'login.staff',
      summary: '조교 로그인 성공 — ' + (staff.name || '이름없음') + ' · 담당 ' + (staff.academy || '미배정'),
      detail: {
        조교이름: staff.name || '(없음)',
        담당학원: staff.academy || '(미배정 — 아무 학생도 안 보인다)',
        시급: staff.hourlyWage || 0,
        승인시각: staff.approvedAt || '(기록 없음)',
        직전누적실패: 전누적실패 + '회' + (전누적실패 ? ' (이번 성공으로 초기화됨)' : ''),
        발급세션: 'ast_ 조교 세션 (담당 학원 학생만 접근)',
        효과: '이 시각 이후 이 조교가 출결·클리닉·과제·성적에 남기는 기록의 행위자가 이 사람으로 찍힌다',
      },
    });
    return Response.json({
      ok: true, role: 'staff', isStaff: true, phone,
      name: staff.name || '',
      academy: staff.academy || '',          // 맡은 학원 (조교 페이지 표시용)
      hourlyWage: staff.hourlyWage || 0,      // 시급 (원장이 설정)
      staffToken,
    });
  }

  // ════════ 학생/학부모 — 기존 포털 흐름 ════════
  // ⚠️ 2026-08-03 (§11-12) — 토큰 발급을 아래 두 관문(좀비 계정·승인 대기) **뒤로** 옮겼다.
  //   예전엔 여기서 먼저 발급해서, 로그인이 거절돼도 R2에 토큰 파일이 하나씩 남았다.
  //   그 토큰은 응답에 실리지 않아 아무도 쓸 수 없었지만(=보안 구멍은 아님), 아무도 제시하지 않으니
  //   만료 정리도 영영 안 걸려서 그냥 쓰레기로 계속 쌓였다.

  // 자녀(또는 본인) 학생 목록
  const students = await fetchStudentsByPhone(env, phone);

  // ⚠️ 좀비 계정 방어 — 계정은 있는데 학생 DB에 연결된 학생이 없으면 로그인 거절
  if (!students.length) {
    // 📓 여기가 찍혔다면 계정과 학생 명단이 어긋나 있다는 뜻이다(퇴원 처리 후 계정만 남음,
    //   학생 레코드의 번호를 고치면서 계정 번호와 달라짐 등). 원장이 손봐야 하는 상태다.
    await 로그인로그(env, request, phone, {
      action: 'login.blocked.nostudent',
      summary: '로그인 차단 — 계정은 있는데 이 번호에 연결된 학생이 하나도 없음',
      detail: {
        사유: 'students 표에서 parent_phone/student_phone 어디에도 이 번호가 없다',
        추정원인: '퇴원 처리 후 계정만 남았거나, 학생 레코드의 전화번호를 고치면서 계정 번호와 어긋났거나, 승인 전에 계정만 먼저 생김',
        토큰: '발급되지 않았다 — 2026-08-03부터 이 검사를 통과한 뒤에만 발급한다',
        효과: '"등록된 학생 정보가 없습니다" 안내. 원장이 학생 레코드의 번호를 맞춰주기 전까지 계속 못 들어온다',
      },
    });
    return jsonError('계정은 있으나 학원에 등록된 학생 정보가 없습니다. 관우T께 문의해주세요.', 401);
  }

  // ⚠️ 승인 대기 방어 — 연결된 학생이 다 "대기중" 또는 "거부" 상태면 로그인 거절
  // 빈 값(옛 학생, 승인 시스템 도입 전)은 자동으로 통과
  // 🎓 2026-08-10 — '수료'도 통과시킨다. 학기가 끝나 안 나오는 학생도 본인 리포트·성적은 계속 봐야 한다
  //   (수업영상만 잠긴다 — class-videos.js). 예전엔 이 학생들을 퇴원 처리해 students 행을 지웠고,
  //   그러면 위 「좀비 계정 방어」에 걸려 앱에서 통째로 튕겨 나갔다.
  // 🔴 이 필터는 auth/me.js 와 **쌍**이다. 한 곳만 고치면 "로그인은 되는데 앱이 빈 화면"이 된다.
  const approvedStudents = students.filter(s => canSignIn(s.approvalStatus));
  if (!approvedStudents.length) {
    const pendingCount = students.filter(s => s.approvalStatus === '대기중').length;
    // 📓 "신청했는데 왜 안 들어가져요" 문의의 나머지 절반이 여기다. 자녀별 상태를 통째로 남긴다.
    await 로그인로그(env, request, phone, {
      action: pendingCount > 0 ? 'login.blocked.pending' : 'login.blocked.rejected',
      summary: '로그인 차단 — 연결된 학생이 전부 ' + (pendingCount > 0 ? '승인 대기중' : '거부/비활성')
        + ' (' + students.length + '명)',
      detail: {
        연결된학생수: students.length,
        대기중인원: pendingCount,
        학생별상태: students.slice(0, 20).map(s => ({
          학생id: String(s.id), 이름: s.name || '', 학원: s.academy || '', 반: s.className || '',
          승인상태: s.approvalStatus || '(빈 값 — 승인 시스템 도입 전 학생이라 통과 대상)',
          이번호의역할: s.role === 'student' ? '학생 본인 번호' : (s.role === 'parent' ? '학부모 번호' : '기타'),
        })),
        사유: pendingCount > 0
          ? '가입 신청은 접수됐지만 원장이 아직 승인하지 않았다'
          : '연결된 학생이 전부 "거부" 상태이거나 승인 상태가 승인/빈값이 아니다',
        효과: pendingCount > 0
          ? '원장이 학생 승인 화면에서 승인을 누르는 즉시 같은 번호·비밀번호로 들어올 수 있다'
          : '원장이 상태를 "승인"으로 바꾸기 전까지 계속 막힌다',
      },
    });
    if (pendingCount > 0) {
      return jsonError('등록 신청이 접수됐지만 아직 관우T 승인 대기 중입니다. 잠시 후 다시 시도해주세요.', 403);
    }
    return jsonError('학원 등록이 거부됐거나 활성 학생이 없습니다. 관우T께 문의해주세요.', 403);
  }

  // ✅ 두 관문을 다 통과한 뒤에만 토큰을 발급한다(§11-12).
  const { token, expires } = await issueToken(env, phone);

  await logEvent(env, request, { kind: 'login', phone, role: 'student', name: (approvedStudents[0] && approvedStudents[0].name) || '' });
  // 📓 학생·학부모 로그인 성공. 여기서 발급된 토큰으로 리포트·성적·영상·과제를 본다.
  //   "우리 애 성적을 누가 봤냐"를 따질 때 이 기록(시각·기기)이 출발점이다.
  await 로그인로그(env, request, phone, {
    actorRole: 'student', actorName: (approvedStudents[0] && approvedStudents[0].name) || '',
    targetName: approvedStudents.map(s => s.name).filter(Boolean).join(', '),
    action: 'login.student',
    summary: '학생/학부모 로그인 성공 — ' + approvedStudents.map(s => s.name).filter(Boolean).join(', ')
      + ' (' + approvedStudents.length + '명 연결)',
    detail: {
      이번호의역할: (approvedStudents[0] && approvedStudents[0].role) === 'student' ? '학생 본인' : '학부모(또는 기타)',
      연결된학생: approvedStudents.slice(0, 20).map(s => ({
        학생id: String(s.id), 이름: s.name || '', 학원: s.academy || '', 반: s.className || '', 학교: s.school || '', 학년: s.grade || '',
        수료: isCompleted(s.approvalStatus) ? '예 — 리포트·성적만 열림(수업영상 잠김)' : undefined,
      })),
      숨겨진학생수: students.length - approvedStudents.length,
      직전누적실패: 전누적실패 + '회' + (전누적실패 ? ' (이번 성공으로 초기화됨)' : ''),
      비밀번호강제변경: account.mustChangePassword
        ? '예 — 0000으로 초기화된 상태라 로그인 직후 변경 화면이 뜬다'
        : '아니오',
      토큰만료: new Date(expires).toISOString() + ' (접속할 때마다 30일 뒤로 밀린다)',
      효과: '이 토큰으로 위 학생들의 리포트·성적·출결·수업영상·과제를 볼 수 있다',
    },
  });
  return Response.json({
    ok: true,
    role: 'student',
    token,
    expires,
    mustChangePassword: !!account.mustChangePassword,
    phone,
    students: approvedStudents,  // 승인된 학생만 반환
    isAdmin: false,  // 원장은 위 분기에서 처리됨 → 여기 도달은 학생/학부모뿐
  });
}
