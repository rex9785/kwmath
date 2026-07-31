// POST /api/admin-reset-password (admin only) — Cloudflare D1 accounts (이전엔 Notion)
// body: { phone } → 비번 '0000' 리셋 + must_change=true (재로그인 시 강제 변경)
//   예외: 데모 계정(010-1234-1234)은 자가변경 불가라 '1234'로 되돌리고 강제변경 안 검.
import { findAccountByPhone, updateAccountPassword } from './_auth.js';
import { getStudentsByPhone } from './_db.js';
import { clearLockout } from './_lockout.js';
import { safeError } from './_errors.js';
import { logAudit } from './_auditlog.js';

// 📓 2026-07-31 — 남의 비밀번호를 강제로 바꾸는 곳인데 여태 아무 기록이 없었다.
//   원장·조교 누구든 번호만 넣으면 그 계정 비번이 0000이 된다. 누가 누구 것을 언제 초기화했는지가
//   남아야 "제 비번이 갑자기 0000이 됐어요"라는 말에 답할 수 있다.
//   🔴 새 비밀번호(0000/1234)는 코드에 박힌 공개값이라 남겨도 되지만, 옛 비밀번호·해시·솔트는 남기지 않는다.
//   actorOf()가 조교 번호/이름을 잡아주므로 행위자는 지정하지 않는다(미들웨어가 실어 보낸 값 사용).
async function 초기화로그(env, request, fields) {
  await logAudit(env, request, {
    target: fields.target || '(번호 미입력)', targetName: fields.targetName || '',
    action: fields.action, summary: fields.summary,
    detail: {
      ...fields.detail,
      비고: '옛 비밀번호·해시·솔트는 로그에 남기지 않는다. 새 비밀번호는 코드에 고정된 공개값(0000, 데모는 1234)이라 그대로 적는다.'
        + ' 학생이 스스로 바꾼 경우는 account.password.change 로 따로 남는다.',
    },
  });
}

const INITIAL_PASSWORD = '0000';
// 데모 계정(여러 명에게 배포되는 공용 심사 계정)은 자가 비밀번호 변경이 막혀 있다(change-password.js).
// 일반 학생처럼 0000+강제변경으로 초기화하면 데모가 영영 못 바꿔 잠기므로,
// 데모는 공지된 데모 비밀번호(1234)로 되돌리고 강제변경 플래그도 걸지 않는다.
const DEMO_PHONE = '010-1234-1234';
const DEMO_PASSWORD = '1234';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) {
    // 📓 관리자 인증 없이 남의 비번을 초기화하려는 시도 — 드물지만 반드시 남긴다.
    await 초기화로그(env, request, {
      action: 'account.password.reset.denied',
      summary: '비밀번호 초기화 거절 — 관리자 인증 실패',
      detail: {
        사유: env.ADMIN_PASSWORD ? '토큰이 관리자 비밀번호와 다르다' : '서버에 ADMIN_PASSWORD가 설정돼 있지 않다',
        토큰입력: token ? token.length + '자 들어옴' : '헤더 없음',
        효과: '아무것도 바뀌지 않음',
      },
    });
    return Response.json({ error: '인증 실패' }, { status: 401 });
  }

  let body = {};
  try { body = await request.json(); } catch {}
  const phone = (body.phone || '').toString().trim();
  if (!phone) {
    await 초기화로그(env, request, {
      action: 'account.password.reset.reject',
      summary: '비밀번호 초기화 거절 — 대상 번호(phone)가 비어 있음',
      detail: { 사유: 'body.phone 이 빈 값', 효과: '아무것도 바뀌지 않음' },
    });
    return Response.json({ error: 'phone 필요 (010-XXXX-XXXX)' }, { status: 400 });
  }

  try {
    const account = await findAccountByPhone(env, phone);
    if (!account) {
      await 초기화로그(env, request, {
        action: 'account.password.reset.miss',
        target: phone,
        summary: '비밀번호 초기화 실패 — 그 번호의 계정이 없음 [' + phone + ']',
        detail: {
          대상번호: phone,
          사유: 'accounts 테이블에 이 번호의 행이 없다',
          해석: '학생 명단에는 있어도 아직 회원가입(계정 생성)을 안 했으면 여기서 안 잡힌다',
          효과: '아무것도 바뀌지 않음',
        },
      });
      return Response.json({ error: '해당 휴대폰의 계정을 찾을 수 없습니다.' }, { status: 404 });
    }

    const isDemo = account.phone === DEMO_PHONE;
    const newPw = isDemo ? DEMO_PASSWORD : INITIAL_PASSWORD;

    // 📓 번호만으로는 나중에 "누구 것이었는지" 알아보기 어렵다 → 그 번호에 연결된 학생 이름을 함께 남긴다.
    //   (초기화는 하루 몇 번 안 일어나는 일이라 조회 1번 추가는 감당한다.)
    let 연결된학생 = [];
    try {
      연결된학생 = (await getStudentsByPhone(env, account.phone) || [])
        .map(s => ({ id: String(s.id), 이름: s.name || '', 학원: s.academy || '', 반: s.className || '', 관계: s.role || '' }));
    } catch (_) { 연결된학생 = []; }
    const 대상이름 = 연결된학생.length
      ? 연결된학생.map(s => s.이름).filter(Boolean).join(', ')
      : '';

    const result = await updateAccountPassword(env, account.id, newPw);
    if (!result.ok) {
      await 초기화로그(env, request, {
        action: 'account.password.reset.fail',
        target: account.phone, targetName: 대상이름,
        summary: '비밀번호 초기화 실패 — DB 저장 단계에서 오류 [' + account.phone + (대상이름 ? ' · ' + 대상이름 : '') + ']',
        detail: {
          대상번호: account.phone, 연결된학생,
          오류: result.error || '(메시지 없음)',
          효과: '아무것도 바뀌지 않음. 기존 비밀번호가 그대로 유효하다',
        },
      });
      return safeError(result.error || '비번 리셋 실패', env, { message: '비밀번호 초기화에 실패했습니다.' });
    }

    // 일반 계정만 재로그인 시 강제 변경(0000→본인 비번). 데모는 자가변경이 막혀 있어 강제변경을 걸지 않는다
    // (updateAccountPassword가 이미 must_change_pw=0으로 세팅).
    let 강제변경설정 = isDemo ? '걸지 않음(데모 계정)' : '걸림(must_change_pw=1)';
    if (!isDemo) {
      try { await env.DB.prepare('UPDATE accounts SET must_change_pw = 1 WHERE phone = ?').bind(account.id).run(); }
      catch (e) { 강제변경설정 = '⚠️ 설정 실패(무시됨): ' + (e && e.message ? e.message : e) + ' — 0000으로 로그인해도 변경을 강요하지 않는다'; }
    }

    // 비번 초기화 시 로그인 잠금도 함께 해제 → 잠긴 학생을 관우T가 즉시 풀어줄 수 있음
    let 잠금해제 = '해제함(남아 있던 5회 실패 잠금도 함께 풀림)';
    try { await clearLockout(env, account.id); }
    catch (e) { 잠금해제 = '⚠️ 해제 실패(무시됨): ' + (e && e.message ? e.message : e); }

    // 🔴 실제로 남의 비밀번호가 바뀐 순간. 이 한 줄이 "누가 언제 누구 비번을 초기화했는지"의 유일한 증거다.
    await 초기화로그(env, request, {
      action: 'account.password.reset',
      target: account.phone, targetName: 대상이름,
      summary: '비밀번호 초기화 [' + account.phone + (대상이름 ? ' · ' + 대상이름 : '') + '] → '
        + newPw + (isDemo ? ' (데모 계정 — 강제변경 없음)' : ' (다음 로그인 때 강제 변경)'),
      detail: {
        대상번호: account.phone,
        연결된학생: 연결된학생.length ? 연결된학생 : '(이 번호에 연결된 학생이 없다 — 조교/원장 계정이거나 명단에서 빠진 번호)',
        새비밀번호: newPw + (isDemo ? ' (공지된 데모 비밀번호)' : ' (초기 비밀번호)'),
        옛비밀번호: '(로그에 남기지 않는다 — 해시만 저장돼 있어 서버도 원문을 모른다)',
        데모계정여부: isDemo ? '예 — 자가변경이 막힌 공용 심사 계정이라 1234로 되돌리고 강제변경을 걸지 않는다' : '아니오',
        강제변경플래그: 강제변경설정,
        로그인잠금: 잠금해제,
        기존로그인토큰: '그대로 유효하다 — 비번을 초기화해도 이미 로그인돼 있는 기기는 로그아웃되지 않는다',
        효과: '이 번호는 지금부터 ' + newPw + ' 로 로그인된다. '
          + (isDemo ? '데모 계정이라 본인이 바꿀 수 없다.' : '학생이 새 비밀번호를 정할 때까지 0000을 아는 누구나 로그인할 수 있으니, 초기화 사실을 학부모/학생에게 바로 알려야 한다.'),
      },
    });

    return Response.json({ ok: true, phone, message: isDemo ? '데모 계정 비밀번호를 1234로 되돌렸습니다.' : '비밀번호가 0000으로 초기화되었습니다. 학부모/학생에게 알려주세요.' });
  } catch (e) {
    try {
      await 초기화로그(env, request, {
        action: 'account.password.reset.fail',
        target: phone,
        summary: '비밀번호 초기화 실패 — 예기치 못한 오류 [' + phone + ']',
        detail: { 대상번호: phone, 오류: (e && e.message) ? e.message : String(e), 효과: '바뀌었는지 여부가 불확실하다 — 위쪽 성공 기록이 없으면 안 바뀐 것이다' },
      });
    } catch (_) {}
    return safeError(e, env, { message: '비밀번호 초기화 중 오류가 발생했습니다.' });
  }
}
