// POST /api/staff-register — 조교(운영진) 회원가입 신청
//   body: { name, phone, password }
//   accounts(D1)에 계정 생성 + R2 staff/{phone}.json(approved:false) 저장. 학생 레코드는 안 만듦.
//   → 학생 명단·랭킹·통계에서 자동 제외. 관우T가 admin에서 승인해야 로그인 가능(login.js가 확인).
import { normalizePhone, findAccountByPhone, createAccount } from './_auth.js';
import { getStaffRecord, putStaffRecord } from './_staff.js';
import { logAudit, describeDevice } from './_auditlog.js';

const ADMIN_PHONES = ['01041149785']; // 원장(owner) — 조교 가입 불가
const onlyDigits = (p) => String(p || '').replace(/\D/g, '');

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용' }, { status: 405 });

  let body = {};
  try { body = await request.json(); } catch (_) {}

  // 이름 살균 — 저장형 XSS 방지(admin 승인화면 onclick 등 렌더 보호)
  const name = String(body.name || '').replace(/[<>"'`]/g, '').trim().slice(0, 40);
  const phone = normalizePhone(body.phone || '');
  const password = String(body.password || '');
  // 계좌(은행명+번호 자유텍스트) — 선택 입력. XSS 방지 살균 후 60자 제한.
  const account = String(body.account || '').replace(/[<>"'`]/g, '').trim().slice(0, 60);

  // ═══════════════════════════════════════════════════════════════════════════
  // 📓 2026-07-31 — 조교 가입은 "학생 개인정보를 볼 계정이 생기는 첫 단계"다. 전부 남긴다.
  //   ⚠️ 이 API는 로그인 **전**이라 actorOf(request)가 아무도 못 잡는다(헤더가 없다).
  //      그대로 두면 '누가'가 통째로 비므로 **신청자 본인**을 actor로 못박는다.
  //      (선례: inquiry.js 가 홈페이지 방문자를, makeup.js 가 학생을 actor로 명시한다.)
  //   🔴 비밀번호 원문은 어떤 경우에도 기록하지 않는다 — 길이만 남긴다.
  //   🟠 계좌는 월급 받는 실계좌다 — 뒤 4자리만 남긴다(선례: payroll-reminder.js).
  //   실패·거부도 전부 남긴다: "가입이 안 된다"는 문의가 왔을 때 이게 유일한 근거다.
  // ═══════════════════════════════════════════════════════════════════════════
  const 기기 = describeDevice(request.headers.get('User-Agent')) || '(알 수 없음)';
  const 신청자 = {
    actor: phone || onlyDigits(body.phone) || '(번호없음)',
    actorRole: 'applicant',
    actorName: name || '(이름없음)',
  };
  const 계좌표시 = (v) => {
    const d = String(v || '').replace(/\D/g, '');
    return d ? ('****' + d.slice(-4) + ' · 숫자 ' + d.length + '자리') : '(미입력)';
  };
  const 입력값 = () => ({
    이름: name || '(빈칸)',
    휴대폰: phone || '(형식 오류 또는 빈칸)',
    보낸번호원문: String(body.phone || '').slice(0, 40) || '(빈칸)',
    비밀번호: password ? (password.length + '자 입력됨') : '(빈칸)',
    계좌: 계좌표시(account),
    기기: 기기,
  });
  const 거부 = async (사유) => {
    await logAudit(env, request, {
      action: 'staff.register.reject',
      ...신청자,
      target: 신청자.actor, targetName: name || '',
      summary: '조교 가입 신청 거부 — ' + 사유 + ' · ' + (name || '(이름없음)'),
      detail: {
        결과: '거부(400). D1 계정도 R2 조교 레코드도 만들어지지 않았다.',
        사유: 사유,
        입력값: 입력값(),
        효과: '없음 — 아무것도 저장되지 않았다. 신청자는 그 칸을 고쳐 다시 제출해야 한다.',
        비고: '비밀번호 원문은 기록하지 않는다(길이만). 계좌는 뒤 4자리만 남긴다.',
      },
    });
  };

  if (!name) { await 거부('이름 미입력'); return Response.json({ error: '이름을 입력해주세요.' }, { status: 400 }); }
  if (!phone) { await 거부('휴대폰 번호 형식 오류 또는 미입력'); return Response.json({ error: '휴대폰 번호를 정확히 입력해주세요.' }, { status: 400 }); }
  if (password.length < 4) { await 거부('비밀번호 4자 미만'); return Response.json({ error: '비밀번호는 4자 이상으로 설정해주세요.' }, { status: 400 }); }

  // 원장 번호로는 조교 가입 불가
  if (ADMIN_PHONES.includes(onlyDigits(phone))) {
    // 🔴 원장 번호로 조교 계정을 만들려는 시도. 원장 본인의 실수일 수도, 사칭 시도일 수도 있다.
    //   막힌 시도라도 "누가 언제 어떤 기기로 시도했는지"가 남아야 뒤에 판단할 수 있다.
    await logAudit(env, request, {
      action: 'staff.register.blocked',
      ...신청자,
      target: phone, targetName: name,
      summary: '⚠️ 원장 번호로 조교 가입 시도 차단 — ' + name + ' / ' + phone + ' · ' + 기기,
      detail: {
        결과: '차단(400). D1 계정도 R2 조교 레코드도 만들어지지 않았다.',
        사유: '원장(owner) 전용 번호로는 조교 가입을 할 수 없다.',
        입력값: 입력값(),
        효과: '없음. 다만 원장 번호를 아는 사람이 그 번호로 계정을 만들려 한 시도이므로, '
          + '원장 본인이 한 게 아니라면 사칭 가능성을 확인할 것.',
        비고: '비밀번호 원문은 기록하지 않는다(길이만).',
      },
    });
    return Response.json({ error: '이 번호는 운영진(원장) 번호입니다.' }, { status: 400 });
  }

  // 이미 가입된 번호 방어 — 학생/학부모 계정 비번을 덮어쓰지 않도록
  const existingStaff = await getStaffRecord(env, phone);
  if (existingStaff) {
    // 📓 기존 레코드는 위에서 **이미 읽었다** — 추가 R2 조회 없이 그대로 before로 남긴다.
    //   같은 번호로 반복 신청이 들어오는 것 자체가 "승인이 안 나 계속 시도 중"이라는 단서다.
    await logAudit(env, request, {
      action: 'staff.register.duplicate',
      ...신청자,
      target: phone, targetName: name,
      summary: '조교 가입 신청 중복 — ' + name + ' / ' + phone + ' (기존: '
        + (existingStaff.approved ? '이미 승인된 조교' : '승인 대기중') + ')',
      detail: {
        결과: '거부(409). 기존 조교 레코드도 기존 비밀번호도 전혀 건드리지 않았다.',
        사유: existingStaff.approved ? '이미 승인된 조교 번호' : '이미 신청되어 승인 대기중인 번호',
        기존레코드: {
          이름: existingStaff.name || '',
          승인여부: !!existingStaff.approved,
          신청일: existingStaff.createdAt || '',
          승인일: existingStaff.approvedAt || '(미승인)',
          담당학원: existingStaff.academy || '(미배정)',
          시급: existingStaff.hourlyWage || 0,
          계좌: 계좌표시(existingStaff.account),
        },
        이번신청: 입력값(),
        기존과이름이다름: String(existingStaff.name || '') !== name,   // true면 남의 번호로 신청했을 수 있다
        효과: '없음 — 이미 있는 조교 계정의 비밀번호가 새 비번으로 덮어써지는 것을 막았다.',
        비고: '비밀번호 원문은 기록하지 않는다(길이만). 계좌는 뒤 4자리만 남긴다.',
      },
    });
    return Response.json({
      error: existingStaff.approved
        ? '이미 조교로 등록된 번호입니다. 로그인해주세요.'
        : '이미 가입 신청된 번호입니다. 관우T 승인을 기다려주세요.',
    }, { status: 409 });
  }
  const existingAcct = await findAccountByPhone(env, phone);
  if (existingAcct) {
    // 🔴 이 방어가 없으면 createAccount 의 upsert 가 학생/학부모 비밀번호를 통째로 덮어쓴다.
    //   막힌 순간을 남겨야 "비번이 갑자기 안 먹는다"류 사건과 구분된다.
    await logAudit(env, request, {
      action: 'staff.register.duplicate',
      ...신청자,
      target: phone, targetName: name,
      summary: '조교 가입 거부 — ' + phone + '은(는) 이미 학생/학부모 계정으로 쓰는 번호 (' + name + ')',
      detail: {
        결과: '거부(409). 기존 계정의 비밀번호를 덮어쓰지 않고 멈췄다.',
        사유: 'accounts(D1)에 같은 번호의 계정이 이미 있다(학생 또는 학부모).',
        기존계정: {
          번호: existingAcct.phone,
          초기비번강제변경대기: !!existingAcct.mustChangePassword,
        },
        이번신청: 입력값(),
        효과: '없음. 이 방어가 없었다면 학생/학부모가 쓰던 비밀번호가 조교 신청 비번으로 바뀌어 '
          + '그 학생/학부모가 로그인하지 못했을 것이다.',
        비고: '비밀번호 원문·해시·솔트는 기록하지 않는다.',
      },
    });
    return Response.json({
      error: '이미 다른 용도(학생/학부모)로 가입된 번호입니다. 다른 번호를 쓰거나 관우T께 문의해주세요.',
    }, { status: 409 });
  }

  // 계정 생성 (본인이 설정한 비번 — 변경 강제 안 함)
  const acct = await createAccount(env, phone, password, false, 'staff:' + name);
  if (!acct.ok) {
    await logAudit(env, request, {
      action: 'staff.register.fail',
      ...신청자,
      target: phone, targetName: name,
      summary: '조교 가입 실패 — 계정 생성 단계에서 오류 (' + name + ' / ' + phone + ')',
      detail: {
        결과: '실패(500). D1 계정이 만들어지지 않아 R2 조교 레코드도 쓰지 않았다.',
        오류: String(acct.error || '(내용 없음)').slice(0, 1000),
        입력값: 입력값(),
        효과: '신청이 접수되지 않았다. 승인 화면(/admin-staff)에도 안 뜬다. 신청자는 다시 시도해야 한다.',
        비고: '비밀번호 원문은 기록하지 않는다(길이만). 이 로그가 "가입했는데 목록에 없다"는 문의의 근거다.',
      },
    });
    return Response.json({ error: '가입 처리에 실패했습니다. 잠시 후 다시 시도해주세요.' }, { status: 500 });
  }

  const 새레코드 = {
    phone, name, role: 'staff', approved: false, createdAt: new Date().toISOString(),
    account,
  };
  await putStaffRecord(env, phone, 새레코드);

  // 📓 여기서 "나중에 학생 개인정보를 볼 수 있게 될 계정"이 하나 생긴다(아직 권한은 0).
  //   전(before)은 없다 — 위에서 기존 레코드·기존 계정이 둘 다 없음을 확인하고 온 자리다.
  await logAudit(env, request, {
    action: 'staff.register',
    ...신청자,
    target: phone, targetName: name,
    summary: '조교 가입 신청 접수 — ' + name + ' / ' + phone + ' (승인 대기) · ' + 기기,
    detail: {
      결과: 'D1 accounts 계정 1건 생성 + R2 staff/' + phone + '.json 생성(approved=false).',
      만든레코드: { ...새레코드, account: 계좌표시(account) },
      계정: { 번호: phone, 비밀번호강제변경: false, 계정메모: 'staff:' + name },
      비밀번호: password.length + '자 (본인이 설정 · 원문은 기록하지 않음)',
      기기: 기기,
      효과: '아직 아무 권한도 없다. 원장이 /admin-staff에서 승인해야 로그인이 되고, '
        + '담당 학원을 배정해야 학생이 보인다. 승인 전까지는 로그인해도 아무 학생도 안 보인다.',
      비고: '학생 레코드는 만들지 않는다 → 학생 명단·랭킹·통계에 섞이지 않는다. '
        + '비밀번호 원문은 기록하지 않는다(길이만). 계좌는 뒤 4자리만 남긴다.',
    },
  });

  return Response.json({
    ok: true, pending: true,
    message: '조교 가입 신청이 접수됐어요. 관우T 승인 후 같은 번호·비밀번호로 로그인하실 수 있습니다.',
  });
}
