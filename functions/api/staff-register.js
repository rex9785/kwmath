// POST /api/staff-register — 조교(운영진) 회원가입 신청
//   body: { name, phone, password }
//   accounts(D1)에 계정 생성 + R2 staff/{phone}.json(approved:false) 저장. 학생 레코드는 안 만듦.
//   → 학생 명단·랭킹·통계에서 자동 제외. 관우T가 admin에서 승인해야 로그인 가능(login.js가 확인).
import { normalizePhone, findAccountByPhone, createAccount } from './_auth.js';
import { getStaffRecord, putStaffRecord } from './_staff.js';

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

  if (!name) return Response.json({ error: '이름을 입력해주세요.' }, { status: 400 });
  if (!phone) return Response.json({ error: '휴대폰 번호를 정확히 입력해주세요.' }, { status: 400 });
  if (password.length < 4) return Response.json({ error: '비밀번호는 4자 이상으로 설정해주세요.' }, { status: 400 });

  // 원장 번호로는 조교 가입 불가
  if (ADMIN_PHONES.includes(onlyDigits(phone)))
    return Response.json({ error: '이 번호는 운영진(원장) 번호입니다.' }, { status: 400 });

  // 이미 가입된 번호 방어 — 학생/학부모 계정 비번을 덮어쓰지 않도록
  const existingStaff = await getStaffRecord(env, phone);
  if (existingStaff) {
    return Response.json({
      error: existingStaff.approved
        ? '이미 조교로 등록된 번호입니다. 로그인해주세요.'
        : '이미 가입 신청된 번호입니다. 관우T 승인을 기다려주세요.',
    }, { status: 409 });
  }
  const existingAcct = await findAccountByPhone(env, phone);
  if (existingAcct) {
    return Response.json({
      error: '이미 다른 용도(학생/학부모)로 가입된 번호입니다. 다른 번호를 쓰거나 관우T께 문의해주세요.',
    }, { status: 409 });
  }

  // 계정 생성 (본인이 설정한 비번 — 변경 강제 안 함)
  const acct = await createAccount(env, phone, password, false, 'staff:' + name);
  if (!acct.ok) return Response.json({ error: '가입 처리에 실패했습니다. 잠시 후 다시 시도해주세요.' }, { status: 500 });

  await putStaffRecord(env, phone, {
    phone, name, role: 'staff', approved: false, createdAt: new Date().toISOString(),
    account,
  });

  return Response.json({
    ok: true, pending: true,
    message: '조교 가입 신청이 접수됐어요. 관우T 승인 후 같은 번호·비밀번호로 로그인하실 수 있습니다.',
  });
}
