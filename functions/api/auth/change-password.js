// POST /api/auth/change-password
// 헤더: Authorization: Bearer <token>
// body: { oldPassword, newPassword }
// 응답: { ok:true }

import {
  requireAuth, findAccountByPhone, verifyPassword, updateAccountPassword, jsonError,
} from '../_auth.js';
import { clearLockout } from '../_lockout.js';
import { logAudit, describeDevice } from '../_auditlog.js';

// 📓 2026-07-31 — 비밀번호 변경은 여태 아무 기록이 없었다.
//   "제 비밀번호가 바뀌었어요"라는 말이 나와도 언제 어떤 기기에서 바뀐 건지 확인할 방법이 없었다.
//   🔴 옛 비번·새 비번·해시·솔트 **무엇도 남기지 않는다**. 길이와 성공 여부만 남긴다.
//   포털 토큰으로 들어오므로 actorOf()가 못 잡는다 → 본인을 행위자로 직접 지정한다.
async function 비번변경로그(env, request, phone, fields) {
  await logAudit(env, request, {
    actor: phone || '(알 수 없음)', actorRole: 'student', actorName: '',
    target: phone || '(알 수 없음)', targetName: '본인 비밀번호',
    action: fields.action, summary: fields.summary,
    detail: {
      휴대폰: phone || '(알 수 없음)',
      기기: describeDevice(request.headers.get('user-agent') || '') || '(알 수 없음)',
      ...fields.detail,
      비고: '옛 비밀번호·새 비밀번호·해시·솔트 모두 로그에 남기지 않는다(길이만). 본인이 스스로 바꾼 경우만 이 기록이 남고, 원장이 초기화한 경우는 account.password.reset 으로 따로 남는다.',
    },
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return jsonError('POST만 허용', 405);

  const auth = await requireAuth(env, request);
  if (!auth.ok) {
    // 📓 토큰 없이/만료된 토큰으로 비번을 바꾸려는 시도 — 드물지만 남겨둔다.
    await 비번변경로그(env, request, '', {
      action: 'account.password.change.denied',
      summary: '비밀번호 변경 거절 — 로그인 상태가 아님(토큰 없음·만료)',
      detail: { 사유: '요청에 유효한 로그인 토큰이 없다', 효과: '아무것도 바뀌지 않음' },
    });
    return auth.response;
  }

  // 데모 계정은 비밀번호 변경 불가 (여러 사람에게 배포되는 공용 계정 보호)
  if (auth.phone === '010-1234-1234') {
    await 비번변경로그(env, request, auth.phone, {
      action: 'account.password.change.denied',
      summary: '비밀번호 변경 거절 — 데모 계정(010-1234-1234)은 변경 불가',
      detail: {
        사유: '여러 사람(애플·구글 심사위원 포함)에게 배포된 공용 계정이라 자가 변경을 막아 뒀다',
        효과: '아무것도 바뀌지 않음. 데모 비밀번호는 1234로 고정',
      },
    });
    return jsonError('데모 계정은 비밀번호를 변경할 수 없습니다.', 403);
  }

  let body = {};
  try { body = await request.json(); } catch (_) {}
  const oldPassword = (body.oldPassword || '').toString();
  const newPassword = (body.newPassword || '').toString();

  // 📓 입력값 문제로 거절된 경우 — 사소해 보이지만 남긴다.
  //   "비번을 바꾸려는데 계속 안 된다"는 문의가 오면 무엇 때문에 막혔는지 이 기록으로 바로 안다.
  //   🔴 여기서도 비밀번호 원문은 안 남긴다. 길이·같은지 여부만.
  async function 입력거절(사유, 메시지, code) {
    await 비번변경로그(env, request, auth.phone, {
      action: 'account.password.change.reject',
      summary: '비밀번호 변경 거절 — ' + 사유,
      detail: {
        사유,
        옛비밀번호입력: oldPassword ? oldPassword.length + '자 입력됨' : '입력 안 됨(빈 값)',
        새비밀번호입력: newPassword ? newPassword.length + '자 입력됨' : '입력 안 됨(빈 값)',
        서버가돌려준메시지: 메시지,
        효과: '아무것도 바뀌지 않음. 기존 비밀번호 그대로',
      },
    });
    return jsonError(메시지, code);
  }

  if (!newPassword || newPassword.length < 4) {
    return await 입력거절('새 비밀번호가 4자리 미만(또는 빈 값)', '새 비밀번호는 4자리 이상이어야 합니다.', 400);
  }
  if (newPassword.length > 64) {
    return await 입력거절('새 비밀번호가 64자를 넘음', '새 비밀번호가 너무 깁니다.', 400);
  }
  if (oldPassword === newPassword) {
    return await 입력거절('새 비밀번호가 기존 비밀번호와 동일', '새 비밀번호가 기존 비밀번호와 동일합니다.', 400);
  }

  const account = await findAccountByPhone(env, auth.phone);
  if (!account) {
    // 📓 토큰은 유효한데 계정 행이 없다 = 계정이 지워졌는데 토큰만 살아 있는 상태(좀비 토큰).
    //   드물지만 생기면 반드시 알아야 하는 상황이라 별도 action으로 남긴다.
    await 비번변경로그(env, request, auth.phone, {
      action: 'account.password.change.fail',
      summary: '비밀번호 변경 실패 — 토큰은 유효한데 계정이 없음(좀비 토큰 의심)',
      detail: {
        사유: 'accounts 테이블에 이 번호의 행이 없다',
        해석: '계정이 삭제됐는데 로그인 토큰(R2)은 아직 살아 있는 상태일 수 있다',
        효과: '아무것도 바뀌지 않음',
      },
    });
    return jsonError('계정을 찾을 수 없습니다.', 404);
  }

  const okOld = await verifyPassword(oldPassword, account.hash, account.salt);
  if (!okOld) {
    // 🔴 이건 보안 신호다 — 로그인 토큰은 가졌는데 기존 비밀번호를 모른다.
    //   본인이 까먹었을 수도 있지만, 남의 기기에 남아 있던 세션으로 비번을 바꾸려는 시도일 수도 있다.
    await 비번변경로그(env, request, auth.phone, {
      action: 'account.password.change.fail',
      summary: '비밀번호 변경 실패 — 기존 비밀번호 불일치',
      detail: {
        사유: '입력한 기존 비밀번호가 저장된 것과 다르다',
        옛비밀번호입력: oldPassword ? oldPassword.length + '자 입력됨' : '입력 안 됨(빈 값)',
        새비밀번호입력: newPassword.length + '자 입력됨',
        계정에강제변경걸림: account.mustChangePassword ? '예(0000으로 초기화된 상태 — 옛 비번 칸에 0000을 넣어야 한다)' : '아니오',
        효과: '아무것도 바뀌지 않음. 이 실패는 로그인 잠금(5회 규칙)에 포함되지 않는다 — 여기서는 횟수 제한 없이 계속 시도할 수 있다',
        해석: '로그인 토큰은 유효한데 기존 비밀번호를 모른다는 뜻이다. '
          + '본인이 까먹은 경우가 대부분이지만, 남의 기기에 남아 있던 세션으로 비번을 바꾸려는 시도일 수도 있다. '
          + '같은 번호로 이 기록이 반복되면 그 계정 토큰을 끊고(로그아웃) 비번을 초기화하는 게 안전하다',
      },
    });
    return jsonError('기존 비밀번호가 일치하지 않습니다.', 401);
  }

  const upd = await updateAccountPassword(env, account.id, newPassword);
  if (!upd.ok) {
    await 비번변경로그(env, request, auth.phone, {
      action: 'account.password.change.fail',
      summary: '비밀번호 변경 실패 — DB 저장 단계에서 오류',
      detail: {
        사유: '기존 비밀번호 확인까지는 통과했으나 accounts 갱신이 실패했다',
        오류: upd.error || '(메시지 없음)',
        효과: '아무것도 바뀌지 않음. 기존 비밀번호로 계속 로그인된다',
      },
    });
    return jsonError(upd.error || '비밀번호 변경 실패', 500);
  }

  // 비번 변경 성공 → 혹시 남아있던 로그인 잠금도 해제
  let 잠금해제 = '해제 시도함';
  try { await clearLockout(env, account.id); } catch (e) { 잠금해제 = '해제 실패(무시함): ' + (e && e.message ? e.message : e); }

  // 🔴 실제로 바뀐 순간. "제 비밀번호가 저절로 바뀌었어요"라는 말이 나오면 이 한 줄이 유일한 증거다.
  await 비번변경로그(env, request, auth.phone, {
    action: 'account.password.change',
    summary: '비밀번호 변경 성공 — 본인이 직접 변경',
    detail: {
      옛비밀번호길이: oldPassword.length + '자',
      새비밀번호길이: newPassword.length + '자',
      직전강제변경상태: account.mustChangePassword
        ? '예 — 0000으로 초기화돼 있던 계정이 이번에 스스로 새 비밀번호를 정했다(강제변경 해제됨)'
        : '아니오 — 평소 비밀번호를 스스로 바꿨다',
      로그인잠금: 잠금해제 + ' (비번을 바꿨으니 남아 있던 5회 실패 잠금도 함께 푼다)',
      기존로그인토큰: '그대로 유효하다 — 비밀번호를 바꿔도 이미 로그인된 기기들은 로그아웃되지 않는다. '
        + '남의 기기에서 로그아웃시키려면 그 기기에서 직접 로그아웃해야 한다',
      효과: '다음 로그인부터 새 비밀번호가 필요하다. 원장도 새 비밀번호를 알 수 없다(해시만 저장) — '
        + '학생이 잊으면 /admin에서 0000으로 초기화하는 방법뿐이다',
    },
  });

  return Response.json({ ok: true });
}
