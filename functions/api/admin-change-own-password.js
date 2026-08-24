// POST /api/admin-change-own-password — 원장(관우T) 본인 계정 비밀번호 변경
// 헤더: Authorization: Bearer <adm_ 세션>   (_middleware.js가 Bearer <ADMIN_PASSWORD> 로 번역 + X-Kw-Actor-Role: owner)
// body: { oldPassword, newPassword }
// 응답: { ok:true }
//
// 📓 2026-08-24 — 관우T 지시 "관리자 비밀번호 바꾸고 싶어" 에서 나온 신설 엔드포인트.
//   [왜 만들었나] 원장 계정(010-4114-9785)의 비밀번호를 **바꿀 방법이 아예 없었다.**
//     · portal.html 에 「비밀번호 변경」 UI가 있지만, 원장은 로그인하면 role:'owner' 로 분기돼
//       adminToken 만 받고 곧장 /admin 으로 이동한다(portal.html 로그인 핸들러). 포털 화면을 못 본다.
//     · /api/auth/change-password 는 requireAuth(= R2 포털 토큰)를 요구하는데,
//       login.js 의 원장 분기 응답에는 포털 토큰(token)이 아예 없다 → 401.
//     · /api/admin-reset-password 는 값이 '0000' 고정이라 임의의 새 비번을 못 넣는다.
//       (이 파일이 생기기 **전까지는** 본인 번호로 「비번 초기화」를 누르면 0000에서 빠져나올 길이 없어 영구 고정이었다.
//        이제는 여기가 그 탈출구다 → 초기화(0000) 후 이 문으로 새 비번을 정하면 된다.
//        login.js 원장 분기는 must_change_pw 를 막지 않고, updateAccountPassword 가 그 플래그를 0으로 되돌린다.)
//   🔴 [당일 정정 · 관우T 지적] "초기화하려면 관리자로 들어가야 하는데 비번을 모르면 어떻게 들어가나?"
//     → 두 비밀번호가 **다르다**는 게 답이다. /admin 로그인(/api/admin-auth)은 번호 없이
//       env.ADMIN_PASSWORD 하나만 보는 별개의 문이고, 여기서 바꾸는 값(accounts 테이블 해시)과 무관하다.
//       그래서 이 비번을 잊어도 /admin 에는 계속 들어올 수 있고, 거기서 초기화 → 여기서 재설정이 가능하다.
//     🔴 다만 「비번 초기화」 버튼이 **원장 번호엔 없었다.** _db.js listStudents()가 OWNER_PHONES(01041149785)를
//       명단에서 걸러내는데(_db.js 229-243) 그 버튼은 학생 카드 안에만 있기 때문(admin.html 5763-5764).
//       → admin.html 「내 비밀번호 변경」 패널에 원장 전용 초기화 버튼을 직접 넣어 이 구멍을 메웠다.
//       (서버는 기존 admin-reset-password 그대로 사용 — 새 엔드포인트를 만들지 않았다.)
//   [무엇을 버렸나]
//     · (기각) login.js 원장 분기에서 포털 토큰도 같이 발급 → 원장은 students 행이 없을 수 있어
//       포털 화면 자체가 깨진다. 로그인이라는 제일 위험한 경로를 건드리는 것도 부담.
//     · (기각) change-password.js 에 관리자 인증 분기 추가 → 학생용 자가변경 경로에
//       관리자 권한 분기가 섞이면 나중에 둘 중 하나를 고칠 때 다른 하나가 조용히 깨진다.
//     → 원장 전용 문을 따로 낸다. 학생 경로(change-password.js)는 손대지 않는다.
//
// 🔒 이 문을 열 수 있는 조건 (둘 다 필요)
//   ① Authorization 이 ADMIN_PASSWORD 와 일치     ← 미들웨어가 adm_/ast_ 세션을 이 형태로 번역
//   ② X-Kw-Actor-Role === 'owner'                  ← 미들웨어가 **원장 세션일 때만** 붙이는 헤더
//   ②가 없으면 조교(ast_ → role:'staff')와, ADMIN_PASSWORD 원본을 직접 쓰는 호출(MathOS·크론)이
//   원장 비밀번호를 갈아치울 수 있다. 이 헤더는 미들웨어가 요청 진입 즉시 무조건 지운 뒤 다시
//   붙이므로(SPOOFABLE 세척) 밖에서 손으로 넣어 흉내낼 수 없다.
//   ※ POST 라 STAFF_WRITE_ALLOW 화이트리스트에도 없어 조교는 미들웨어에서 이미 403 이다. ②는 이중 잠금.
import { findAccountByPhone, updateAccountPassword, verifyPassword, normalizePhone, jsonError } from './_auth.js';
import { clearLockout } from './_lockout.js';
import { safeError } from './_errors.js';
import { logAudit, describeDevice } from './_auditlog.js';

// 원장 번호 — login.js·staff-register.js·me.js 의 ADMIN_PHONES 와 같은 값을 쓴다.
//   저장은 정규화된 '010-4114-9785' 형태(accounts PK). 숫자만 적어두고 여기서 정규화한다.
const OWNER_PHONE_DIGITS = '01041149785';
const OWNER_PHONE = normalizePhone(OWNER_PHONE_DIGITS);

// 🔴 옛 비번·새 비번·해시·솔트는 **무엇도 남기지 않는다**(길이와 성공 여부만).
//   change-password.js 의 같은 규칙을 그대로 따른다.
//
// 🔴 행위자(actor)를 여기서 지정하지 않는 이유 — logAudit은 actor를 넘기면 actorOf()를 **덮어쓴다**(_auditlog.js 190).
//   처음엔 actor: OWNER_PHONE / actorName: '관우T' 를 박아뒀는데, 그러면 아래 **거절 기록에도 관우T 이름이 찍힌다**.
//   이 문에서 거절당하는 요청은 정의상 관우T가 아닌 호출(조교 세션·ADMIN_PASSWORD 원본 직접 사용)인데,
//   그게 관우T가 한 일로 남으면 "누가 원장 비번을 두드렸나"를 못 가려낸다 = 로그를 통째로 못 믿게 된다.
//   → actorOf()에 맡긴다. 헤더는 미들웨어가 지우고 다시 붙이므로 위조가 안 되고, 셋을 정확히 갈라준다:
//     원장 세션 → __owner__ / 조교 세션 → 조교 번호·이름 / 비번 원본 직접 → __adminkey__
//   대상(target)만 항상 원장 계정으로 고정한다. 이 문이 건드릴 수 있는 계정은 그거 하나뿐이다.
async function 비번변경로그(env, request, fields) {
  await logAudit(env, request, {
    target: OWNER_PHONE, targetName: '원장 본인 비밀번호',
    action: fields.action, summary: fields.summary,
    detail: {
      기기: describeDevice(request.headers.get('user-agent') || '') || '(알 수 없음)',
      ...fields.detail,
      비고: '옛 비밀번호·새 비밀번호·해시·솔트 모두 로그에 남기지 않는다(길이만). '
        + '이 기록은 /admin 화면에서 원장이 스스로 바꾼 경우에만 남는다. '
        + '앱 로그인 비밀번호(휴대폰+비번)가 대상이며, Cloudflare 환경변수 ADMIN_PASSWORD 는 여기서 안 바뀐다.',
    },
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return jsonError('POST만 허용', 405);

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const actorRole = request.headers.get('X-Kw-Actor-Role') || '';

  // ① 관리자 인증
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) {
    await 비번변경로그(env, request, {
      action: 'account.password.change.denied',
      summary: '원장 비밀번호 변경 거절 — 관리자 인증 실패',
      detail: {
        사유: env.ADMIN_PASSWORD ? '토큰이 관리자 비밀번호와 다르다' : '서버에 ADMIN_PASSWORD가 설정돼 있지 않다',
        토큰입력: token ? token.length + '자 들어옴' : '헤더 없음',
        효과: '아무것도 바뀌지 않음',
      },
    });
    return jsonError('인증 실패', 401);
  }

  // ② 원장 세션인가 (조교·서버내부 호출 차단)
  if (actorRole !== 'owner') {
    await 비번변경로그(env, request, {
      action: 'account.password.change.denied',
      summary: '원장 비밀번호 변경 거절 — 원장 세션이 아님',
      detail: {
        들어온역할: actorRole || '(헤더 없음 — ADMIN_PASSWORD 원본을 직접 쓴 호출)',
        사유: '이 문은 원장 본인 세션(adm_)으로 /admin 화면에서만 열 수 있다',
        효과: '아무것도 바뀌지 않음',
        해석: '조교 세션이거나 MathOS·크론처럼 비번 원본을 직접 쓰는 호출이다. '
          + '조교 이름이 여기 반복해서 찍히면 그 조교 계정을 확인해야 한다',
      },
    });
    return jsonError('원장 본인 세션에서만 변경할 수 있습니다.', 403);
  }

  let body = {};
  try { body = await request.json(); } catch (_) {}
  const oldPassword = (body.oldPassword || '').toString();
  const newPassword = (body.newPassword || '').toString();

  async function 입력거절(사유, 메시지) {
    await 비번변경로그(env, request, {
      action: 'account.password.change.reject',
      summary: '원장 비밀번호 변경 거절 — ' + 사유,
      detail: {
        사유,
        옛비밀번호입력: oldPassword ? oldPassword.length + '자 입력됨' : '입력 안 됨(빈 값)',
        새비밀번호입력: newPassword ? newPassword.length + '자 입력됨' : '입력 안 됨(빈 값)',
        서버가돌려준메시지: 메시지,
        효과: '아무것도 바뀌지 않음. 기존 비밀번호 그대로',
      },
    });
    return jsonError(메시지, 400);
  }

  if (!newPassword || newPassword.length < 4) {
    return await 입력거절('새 비밀번호가 4자리 미만(또는 빈 값)', '새 비밀번호는 4자리 이상이어야 합니다.');
  }
  if (newPassword.length > 64) {
    return await 입력거절('새 비밀번호가 64자를 넘음', '새 비밀번호가 너무 깁니다.');
  }
  if (oldPassword === newPassword) {
    return await 입력거절('새 비밀번호가 기존 비밀번호와 동일', '새 비밀번호가 기존 비밀번호와 동일합니다.');
  }

  try {
    const account = await findAccountByPhone(env, OWNER_PHONE);
    if (!account) {
      await 비번변경로그(env, request, {
        action: 'account.password.change.fail',
        summary: '원장 비밀번호 변경 실패 — 원장 계정 행이 없음',
        detail: {
          대상번호: OWNER_PHONE,
          사유: 'accounts 테이블에 원장 번호의 행이 없다',
          해석: '원장 계정이 지워졌거나, ADMIN_PHONES 의 번호와 accounts 의 번호가 어긋났다. '
            + 'login.js·staff-register.js·me.js·이 파일 네 곳의 번호가 같은지 확인할 것',
          효과: '아무것도 바뀌지 않음',
        },
      });
      return jsonError('원장 계정을 찾을 수 없습니다.', 404);
    }

    // 🔴 현재 비밀번호 확인 — 세션만으로는 못 바꾸게 한다.
    //   남의 손에 열려 있는 /admin 화면(로그아웃 안 한 기기)으로 비번이 갈아치워지는 걸 막는 유일한 장치다.
    const okOld = await verifyPassword(oldPassword, account.hash, account.salt);
    if (!okOld) {
      await 비번변경로그(env, request, {
        action: 'account.password.change.fail',
        summary: '원장 비밀번호 변경 실패 — 현재 비밀번호 불일치',
        detail: {
          사유: '입력한 현재 비밀번호가 저장된 것과 다르다',
          옛비밀번호입력: oldPassword ? oldPassword.length + '자 입력됨' : '입력 안 됨(빈 값)',
          새비밀번호입력: newPassword.length + '자 입력됨',
          효과: '아무것도 바뀌지 않음. 이 실패는 로그인 잠금(5회 규칙)에 포함되지 않는다 '
            + '— change-password.js(학생 자가변경)와 같은 규칙이다. '
            + '여기까지 오려면 이미 원장 세션이 있어야 하고, 여기서 잠그면 관우T 본인이 앱 로그인에서 막힌다',
          해석: '관리자 세션은 가졌는데 현재 비밀번호를 모르는 상태다. '
            + '본인이 헷갈린 경우가 대부분이지만, 로그아웃 안 한 남의 기기에서의 시도일 수도 있다. '
            + '이 기록이 반복되면 ADMIN_PASSWORD 교체를 검토할 것',
        },
      });
      return jsonError('현재 비밀번호가 일치하지 않습니다.', 401);
    }

    const upd = await updateAccountPassword(env, account.id, newPassword);
    if (!upd.ok) {
      await 비번변경로그(env, request, {
        action: 'account.password.change.fail',
        summary: '원장 비밀번호 변경 실패 — DB 저장 단계에서 오류',
        detail: {
          사유: '현재 비밀번호 확인까지는 통과했으나 accounts 갱신이 실패했다',
          오류: upd.error || '(메시지 없음)',
          효과: '아무것도 바뀌지 않음. 기존 비밀번호로 계속 로그인된다',
        },
      });
      return safeError(upd.error || '비밀번호 변경 실패', env, { message: '비밀번호 변경에 실패했습니다.' });
    }

    let 잠금해제 = '해제 시도함';
    try { await clearLockout(env, account.id); } catch (e) { 잠금해제 = '해제 실패(무시함): ' + (e && e.message ? e.message : e); }

    // 🔴 실제로 바뀐 순간.
    await 비번변경로그(env, request, {
      action: 'account.password.change',
      summary: '원장 비밀번호 변경 성공 — /admin 「내 비밀번호 변경」에서 본인이 직접 변경',
      detail: {
        옛비밀번호길이: oldPassword.length + '자',
        새비밀번호길이: newPassword.length + '자',
        로그인잠금: 잠금해제 + ' (비번을 바꿨으니 남아 있던 5회 실패 잠금도 함께 푼다)',
        기존관리자세션: '그대로 유효하다 — adm_ 세션은 ADMIN_PASSWORD로 서명돼 있어 계정 비번과 무관하다. '
          + '지금 보고 있는 /admin 화면에서 튕겨나가지 않는다',
        효과: '다음 앱·포털 로그인부터 새 비밀번호가 필요하다. 서버도 원문을 모른다(해시만 저장). '
          + '잊었을 때의 되찾는 길 = /admin(ADMIN_PASSWORD로 여는 별개의 문)에 들어가 '
          + '「내 비밀번호 변경」 패널의 「현재 비밀번호를 잊으셨나요?」 → 0000 초기화 → 이 문으로 다시 정하기. '
          + '(학생 목록에는 원장 행이 안 뜬다 — _db.js listStudents가 원장 번호를 거른다. 그래서 초기화 버튼을 패널에 직접 뒀다.) '
          + '0000은 코드에 박힌 공개값이므로 초기화했다면 즉시 바꿔야 한다',
      },
    });

    return Response.json({ ok: true });
  } catch (e) {
    try {
      await 비번변경로그(env, request, {
        action: 'account.password.change.fail',
        summary: '원장 비밀번호 변경 실패 — 예기치 못한 오류',
        detail: {
          오류: (e && e.message) ? e.message : String(e),
          효과: '바뀌었는지 여부가 불확실하다 — 위쪽 성공 기록이 없으면 안 바뀐 것이다',
        },
      });
    } catch (_) {}
    return safeError(e, env, { message: '비밀번호 변경 중 오류가 발생했습니다.' });
  }
}
