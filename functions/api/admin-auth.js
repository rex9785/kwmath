// POST /api/admin-auth — 관리자 로그인
// 성공 시: 비번 원본 대신 서명된 세션 토큰(adm_)을 발급 + HttpOnly 쿠키 설정.
//   _middleware.js가 이 토큰을 검증해 다운스트림 endpoint엔 Bearer <ADMIN_PASSWORD>로 번역한다.
//   (admin endpoint들은 무수정. 레거시 Bearer <ADMIN_PASSWORD>도 계속 통과 — 하위호환.)
import { issueAdminSession } from './_admin.js';
import { checkLockout, recordFailure, clearLockout, fmtRetry } from './_lockout.js';
import { logAudit, describeDevice } from './_auditlog.js';

// 관리자 잠금 키 — login_lockouts 테이블은 phone 키라서 고정 키 사용 (푸시의 '__admin__' 관례와 동일)
const ADMIN_LOCK_KEY = '__admin__';

// 📓 2026-07-31 — 여기는 **관리자 비밀번호 하나만 맞히면 전체 권한**이 나오는 문이다.
//   그런데 여태 성공도 실패도 아무 기록이 없었다. 누가 관리자 비번을 두드리고 있어도 알 방법이 없었다.
//   🔴 비밀번호는 원문도 일부도 남기지 않는다. 입력 길이만 남긴다.
//   로그인 전이라 actorOf()가 못 잡으므로 행위자를 직접 지정한다.
async function 관리자로그(env, request, fields) {
  await logAudit(env, request, {
    actor: '__admin_login__', actorRole: 'anonymous', actorName: '',
    target: ADMIN_LOCK_KEY, targetName: '관리자 로그인(/admin)',
    action: fields.action, summary: fields.summary,
    detail: {
      기기: describeDevice(request.headers.get('user-agent') || '') || '(알 수 없음)',
      ...fields.detail,
      비고: '비밀번호는 원문·일부 모두 로그에 남기지 않는다(입력 길이만).'
        + ' 이 문은 번호 확인 없이 비밀번호 하나로 열리므로, 모르는 기기의 성공 기록이 보이면 즉시 ADMIN_PASSWORD를 바꿔야 한다.',
    },
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  let body = {};
  try { body = await request.json(); } catch {}
  const { password } = body;

  // ── 무차별 대입(brute-force) 방어: 학생 로그인(_lockout)과 동일 단계 잠금(5회→1분…8회+→60분 상한) ──
  //    상한 60분이라 관우T 본인이 잠겨도 최대 60분이면 스스로 풀림(자가복구).
  const lock = await checkLockout(env, ADMIN_LOCK_KEY);
  if (lock.locked) {
    await 관리자로그(env, request, {
      action: 'admin.login.locked',
      summary: '관리자 로그인 차단 — 이미 잠긴 상태에 다시 시도 (' + fmtRetry(lock.retryAfterSec) + ' 남음)',
      detail: {
        누적실패횟수: lock.failCount,
        남은잠금: fmtRetry(lock.retryAfterSec) + ' (' + lock.retryAfterSec + '초)',
        비밀번호입력: password ? String(password).length + '자 입력됨' : '입력 안 됨',
        효과: '잠금 상한이 60분이라 최대 60분이면 스스로 풀린다(원장 자가복구). '
          + '내가 시도한 게 아닌데 이 기록이 계속 쌓이면 누군가 관리자 비번을 두드리고 있다는 뜻이다',
      },
    });
    return Response.json(
      { error: `비밀번호를 여러 번 잘못 입력해 로그인이 일시 제한되었습니다. 약 ${fmtRetry(lock.retryAfterSec)} 후 다시 시도해주세요.` },
      { status: 429 },
    );
  }

  if (!password || password !== env.ADMIN_PASSWORD) {
    const f = await recordFailure(env, ADMIN_LOCK_KEY);
    await 관리자로그(env, request, {
      action: f.locked ? 'admin.login.fail.lock' : 'admin.login.fail',
      summary: '관리자 로그인 실패 — 비밀번호 불일치 (누적 ' + f.failCount + '회)'
        + (f.locked ? ' → ' + fmtRetry(f.retryAfterSec) + ' 잠금' : ''),
      detail: {
        비밀번호입력: password ? String(password).length + '자 입력됨' : '입력 안 됨(빈 값)',
        누적실패횟수: f.failCount,
        잠김: f.locked ? '예 — ' + fmtRetry(f.retryAfterSec) + ' 동안 잠금' : '아니오',
        잠금까지남은횟수: f.locked ? 0 : Math.max(0, 5 - f.failCount),
        서버비번설정됨: env.ADMIN_PASSWORD ? '예' : '아니오(ADMIN_PASSWORD 미설정 — 무엇을 넣어도 실패한다)',
        효과: f.locked
          ? '지금부터 잠금 시간 동안 비밀번호가 맞아도 /admin에 못 들어간다(최대 60분 뒤 자동 해제)'
          : '5회째부터 1분 → 5분 → 15분 → 60분(상한)으로 잠금이 길어진다',
      },
    });
    if (f.locked) {
      return Response.json(
        { error: `비밀번호를 여러 번 잘못 입력해 로그인이 약 ${fmtRetry(f.retryAfterSec)} 제한됩니다.` },
        { status: 429 },
      );
    }
    const left = Math.max(0, 5 - f.failCount);
    const tail = (f.failCount >= 3 && left > 0) ? ` (${left}회 더 틀리면 잠깐 잠겨요)` : '';
    return Response.json({ error: '비밀번호가 올바르지 않습니다.' + tail }, { status: 401 });
  }

  // 정답 → 누적 실패 초기화
  //   📓 지우기 전 값을 들고 간다 — 몇 번 헤매다 들어왔는지가 남아야 의미가 있다(추가 조회 없음).
  const 전누적실패 = lock.failCount || 0;
  await clearLockout(env, ADMIN_LOCK_KEY);

  // 비번 원본 대신 만료·서명된 세션 토큰 발급 (XSS로 비번 자체가 유출되는 것 방지)
  const token = await issueAdminSession(env);
  const maxAge = 30 * 24 * 60 * 60; // 30일
  const cookie = `admin_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  // 🔴 성공 = 전체 권한 세션(adm_) 30일짜리가 발급된 순간. 이 한 줄이 이후 모든 관리자 행위의 출발점이다.
  await 관리자로그(env, request, {
    action: 'admin.login',
    summary: '관리자 로그인 성공 — 전체 권한 세션(adm_) 발급 (30일)',
    detail: {
      직전누적실패: 전누적실패 + '회' + (전누적실패 ? ' (이번 성공으로 초기화됨)' : ''),
      세션발급: token ? '성공' : '실패(ADMIN_PASSWORD 미설정 — 토큰이 비었다)',
      유효기간: '30일 (HttpOnly·Secure·SameSite=Strict 쿠키 + 응답 본문 토큰)',
      들어온경로: '/api/admin-auth (번호 없이 관리자 비밀번호만으로 여는 문)',
      효과: '이 세션으로 모든 학생·성적·출결·삭제·발송·백업이 가능하다. '
        + '내가 안 한 시각·모르는 기기가 찍혀 있으면 즉시 ADMIN_PASSWORD를 교체해야 한다',
    },
  });
  return new Response(JSON.stringify({ token, ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie },
  });
}
