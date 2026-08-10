// kwmath 인증 공통 유틸 (Cloudflare Pages Functions / Workers)
// - PBKDF2 SHA-256 비밀번호 해싱 (Web Crypto API)
// - 랜덤 토큰 발급 + R2에 저장
// - 다른 API에서 import해서 토큰 검증

export const ACCOUNTS_DB = '893a626479514059ae309a269b3661b5';
export const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';
export const TOKEN_TTL_DAYS = 30;

// ── 🎓 2026-08-10 — 학생 상태(`students.approval_status`)의 단일 정의 ──
//   왜 생겼나: 학기가 끝나면 안 오는 학생을 「퇴원」시켰는데, 퇴원은 students 행을 실제로 DELETE 하는 일이라
//   ① 로그인 열쇠 ② 수업 명단 ③ 반 소속이 한꺼번에 끊겼다. 앱에서 튕겨 나가니 재등록·특강 모집을 알릴
//   채널이 그 자리에서 사라졌다. 그래서 「수료」를 만들었다 — 행은 남기고 명단에서만 뺀다.
//
//   '' (빈 값) : 승인 시스템 도입 전 옛 학생. 재원생으로 친다.
//   '대기중'   : 가입 신청했고 원장 승인 대기. 로그인 불가.
//   '승인'     : 재원생.
//   '거부'     : 등록 거부. 로그인 불가.
//   '수료'     : 다녔던 학생. **로그인 되고 본인 리포트·성적은 계속 보이지만, 수업영상은 잠긴다.**
//              명단·출결·집계·알림의 기본 대상에서는 빠진다.
//   '졸업'     : 학교를 졸업해 더는 올 일이 없는 학생. **앱에서의 대우는 수료와 글자 하나 다르지 않다.**
//              (2026-08-10 관우T: "그만두면 무조건 수료로 빠지게 될건데 퇴원생은 안쓰잖아 …
//               학교 졸업을 해서 내 수업을 들을 일이 없으면 몰라도 그냥 졸업생으로 해버려")
export const STATUS_ACTIVE    = '승인';
export const STATUS_PENDING   = '대기중';
export const STATUS_REJECTED  = '거부';
export const STATUS_COMPLETED = '수료';
export const STATUS_GRADUATED = '졸업';

const 상태 = (v) => String(v || '').trim();

// 🔴 수료와 졸업은 **서버에서 한 덩어리로 다룬다.** 둘의 차이는 관리자 화면의 이름표와 탭뿐이고,
//    로그인·영상·명단·알림에서의 대우는 완전히 같다. 그래서 아래 isCompleted() 가 둘 다 참을 돌려준다.
//    ⚠️ 새 가드를 만들 때 `=== '수료'` 로 직접 비교하지 말 것 — 졸업생이 그 가드를 그냥 통과해 버린다.
//       반드시 isCompleted() 를 쓴다. (이 설계 덕에 class-videos·notify-class-materials·me·login·
//        class-options 의 기존 가드가 한 줄도 안 고치고 졸업생까지 덮는다.)
const 수업끝난상태 = new Set([STATUS_COMPLETED, STATUS_GRADUATED]);

// 앱에 들어올 수 있는가 (로그인·토큰 검증)
// 🔴 login.js 와 auth/me.js **둘 다** 이 함수를 써야 한다. 한 곳만 고치면 "로그인은 되는데 빈 화면"이 된다.
export function canSignIn(approvalStatus) {
  const s = 상태(approvalStatus);
  return s === '' || s === STATUS_ACTIVE || 수업끝난상태.has(s);
}

// 지금 다니는 학생인가 (명단·출결·집계·알림·수업영상의 기본 대상)
export function isEnrolled(approvalStatus) {
  const s = 상태(approvalStatus);
  return s === '' || s === STATUS_ACTIVE;
}

// 수업이 끝난 학생인가 (수료 + 졸업). 영상 잠금·발송 제외 판정은 전부 이걸 쓴다.
export function isCompleted(approvalStatus) {
  return 수업끝난상태.has(상태(approvalStatus));
}

// 둘을 갈라 봐야 할 때만 (관리자 화면의 탭·이름표). 접근 권한 판정에는 쓰지 않는다.
export function isGraduated(approvalStatus) {
  return 상태(approvalStatus) === STATUS_GRADUATED;
}

// 🔄 2026-07-29 — 로그인 유지(슬라이딩 갱신).
//   예전: 로그인하고 30일이 지나면 매일 쓰고 있어도 예고 없이 로그아웃됐습니다.
//   지금: 접속할 때마다 만료를 다시 30일 뒤로 밉니다 → 계속 쓰는 분은 영원히 로그인 유지.
//         30일 내내 한 번도 안 들어오면 그때 만료(방치된 토큰은 계속 정리됨).
//   R2 쓰기를 아끼려고 "마지막 갱신 후 하루 지났을 때"만 다시 씁니다.
const TOKEN_RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ── 휴대폰 번호 정규화 (010-1234-5678) ──
export function normalizePhone(input) {
  const digits = (input || '').replace(/[^0-9]/g, '');
  if (digits.length === 10) return digits.slice(0,3) + '-' + digits.slice(3,6) + '-' + digits.slice(6);
  if (digits.length === 11) return digits.slice(0,3) + '-' + digits.slice(3,7) + '-' + digits.slice(7);
  return null; // 유효하지 않은 형식
}

// ── PBKDF2 비밀번호 해싱 ──
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i*2, 2), 16);
  return out;
}

async function pbkdf2(password, saltBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, HASH_BYTES * 8
  );
  return new Uint8Array(derived);
}

export async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hashBytes = await pbkdf2(password, saltBytes);
  return { hash: bytesToHex(hashBytes), salt: bytesToHex(saltBytes) };
}

export async function verifyPassword(password, hashHex, saltHex) {
  if (!password || !hashHex || !saltHex) return false;
  const saltBytes = hexToBytes(saltHex);
  const candidateBytes = await pbkdf2(password, saltBytes);
  const expectedBytes = hexToBytes(hashHex);
  if (candidateBytes.length !== expectedBytes.length) return false;
  // timing-safe 비교
  let diff = 0;
  for (let i = 0; i < candidateBytes.length; i++) diff |= candidateBytes[i] ^ expectedBytes[i];
  return diff === 0;
}

// ── 랜덤 토큰 발급 (R2 저장) ──
function generateRandomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

// ── 🔑 2026-08-03 — 폰별 토큰 색인 (§11-12) ──
//   문제: 토큰은 `auth/tokens/{난수}.json` 으로만 저장돼서 "이 번호의 토큰을 지워라"를 할 방법이 없었다.
//         그래서 퇴원·거부 처리를 해도 이미 나간 토큰이 계속 살아 있었다(verifyToken은 만료만 보고,
//         슬라이딩 갱신 때문에 계속 쓰면 만료도 안 된다).
//   해법: 발급할 때 `auth/phone-index/{폰}/{토큰}` 빈 객체를 하나 더 남긴다. 폐기할 땐 이 접두사만 훑으면 된다.
//         요청당 추가 비용 0 — 발급(로그인)할 때 R2 쓰기 1회가 늘 뿐이다.
function tokenKey(token) { return 'auth/tokens/' + token + '.json'; }
function indexKey(phone, token) { return 'auth/phone-index/' + phone + '/' + token; }

// 색인 쓰기는 로그인의 성패를 좌우하면 안 된다 → 실패해도 조용히 넘어간다(폐기 정확도만 조금 떨어짐).
async function putTokenIndex(env, phone, token) {
  if (!phone || !token) return;
  try { await env.BUCKET.put(indexKey(phone, token), ''); } catch (_) { /* 비치명적 */ }
}
async function deleteTokenIndex(env, phone, token) {
  if (!phone || !token) return;
  try { await env.BUCKET.delete(indexKey(phone, token)); } catch (_) { /* 비치명적 */ }
}

export async function issueToken(env, phone) {
  const token = generateRandomToken();
  const expires = Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  const payload = JSON.stringify({ phone, expires, createdAt: Date.now() });
  await env.BUCKET.put(tokenKey(token), payload, {
    httpMetadata: { contentType: 'application/json' },
  });
  await putTokenIndex(env, phone, token);
  return { token, expires };
}

export async function verifyToken(env, token) {
  if (!token) return null;
  const obj = await env.BUCKET.get(tokenKey(token));
  if (!obj) return null;
  try {
    const payload = await obj.json();
    if (!payload || !payload.phone) return null;
    const now = Date.now();
    if (typeof payload.expires === 'number' && payload.expires < now) {
      // 만료 → 정리 (색인도 같이 지운다 — 안 지우면 폐기 목록에 유령이 쌓인다)
      try { await env.BUCKET.delete(tokenKey(token)); } catch(_) {}
      await deleteTokenIndex(env, payload.phone, token);
      return null;
    }
    // 🔄 슬라이딩 갱신 — 지금 접속했으니 만료를 다시 30일 뒤로. 하루에 한 번만 R2에 씁니다.
    const fullMs = TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
    if (typeof payload.expires !== 'number' || (payload.expires - now) < (fullMs - TOKEN_RENEW_INTERVAL_MS)) {
      const renewed = { ...payload, expires: now + fullMs, renewedAt: now };
      try {
        await env.BUCKET.put(tokenKey(token), JSON.stringify(renewed), {
          httpMetadata: { contentType: 'application/json' },
        });
        // 📌 색인 백필 — 2026-08-03 이전에 발급된 토큰은 색인이 없다. 갱신은 하루 한 번뿐이라
        //    여기서 같이 써두면, 계속 쓰는 옛 토큰도 하루 안에 폐기 대상으로 잡힌다.
        await putTokenIndex(env, payload.phone, token);
        return renewed;
      } catch (_) { /* 갱신 실패해도 이번 요청은 통과 — 다음 접속 때 다시 시도합니다. */ }
    }
    return payload; // { phone, expires, createdAt, renewedAt? }
  } catch (e) {
    return null;
  }
}

export async function revokeToken(env, token) {
  if (!token) return;
  // 색인을 지우려면 이 토큰이 누구 것인지 알아야 한다 → 지우기 전에 한 번 읽는다.
  let phone = '';
  try {
    const obj = await env.BUCKET.get(tokenKey(token));
    if (obj) { const p = await obj.json(); phone = (p && p.phone) || ''; }
  } catch (_) { /* 못 읽어도 토큰 파일은 아래에서 지운다 */ }
  try { await env.BUCKET.delete(tokenKey(token)); } catch(_) {}
  await deleteTokenIndex(env, phone, token);
}

// ── 이 번호로 발급된 토큰 전부 폐기 (퇴원·거부·계정삭제) ──
//   반환: 지운 개수. 색인이 없는 옛 토큰(2026-08-03 이전 발급 + 그 뒤로 한 번도 접속 안 함)은 못 잡는다.
export async function revokeTokensForPhone(env, phone) {
  if (!phone) return 0;
  let count = 0;
  try {
    const prefix = 'auth/phone-index/' + phone + '/';
    let cursor;
    // 한 사람의 토큰이 1000개를 넘을 일은 없지만, 커서를 돌려 끝까지 지운다.
    for (let page = 0; page < 5; page++) {
      const listed = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
      for (const obj of (listed.objects || [])) {
        const tok = obj.key.slice(prefix.length);
        if (!tok) continue;
        try { await env.BUCKET.delete(tokenKey(tok)); } catch (_) {}
        try { await env.BUCKET.delete(obj.key); } catch (_) {}
        count++;
      }
      if (!listed.truncated) break;
      cursor = listed.cursor;
    }
  } catch (_) { /* 폐기 실패는 호출부가 감사로그에 남긴다 */ }
  return count;
}

// ── 이 번호에 연결된 학생이 하나도 안 남았을 때만 폐기 (형제 로그인 보호) ──
//   퇴원/거부 처리 뒤에 부른다. 형제가 아직 다니면 부모 계정은 그대로 써야 하므로 토큰을 살린다.
//   반환: { revoked, kept, error }
//   🔴 2026-08-10 — 아래 SELECT에 `AND approval_status = '승인'` 같은 조건을 **붙이지 말 것.**
//     수료생은 students 행이 그대로 남아 있어야 여기서 "아직 쓰는 번호"로 잡히고 토큰이 유지된다.
//     조건을 붙이면 수료 처리하는 순간 앱에서 튕겨나가, 「수료해도 앱은 계속 쓴다」는 설계가 통째로 무의미해진다.
export async function revokeTokensIfUnused(env, phone) {
  if (!phone) return { revoked: 0, kept: false };
  try {
    const stillUsed = await env.DB.prepare(
      'SELECT 1 FROM students WHERE parent_phone = ? OR student_phone = ? LIMIT 1'
    ).bind(phone, phone).first();
    if (stillUsed) return { revoked: 0, kept: true };
  } catch (e) {
    // 판단을 못 했으면 지우지 않는다 — 멀쩡한 형제를 로그아웃시키는 쪽이 더 나쁘다.
    return { revoked: 0, kept: true, error: e.message || 'lookup failed' };
  }
  return { revoked: await revokeTokensForPhone(env, phone), kept: false };
}

// ── Authorization 헤더에서 Bearer 토큰 추출 ──
export function bearerFromRequest(request) {
  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return '';
}

// ── 토큰으로 phone 가져오고, 학생 DB에서 그 휴대폰이 연결된 학생들 조회 ──
//   학부모 휴대폰 / 학생 휴대폰 둘 중 어디에 있어도 매칭
export async function fetchStudentsByPhone(env, phone) {
  if (!phone) return [];
  const { results } = await env.DB.prepare(
    'SELECT * FROM students WHERE parent_phone = ? OR student_phone = ? ORDER BY id'
  ).bind(phone, phone).all();
  return (results || []).map(r => ({
    id: r.id,
    name: r.name || '',
    school: r.school || '',
    grade: r.grade || '',
    academy: r.academy || '',
    className: r.class_name || '',
    approvalStatus: r.approval_status || '',
    role: (phone === r.student_phone) ? 'student'
        : (phone === r.parent_phone ? 'parent' : 'other'),
    parentPhone: r.parent_phone || '',
    studentPhone: r.student_phone || '',
  }));
}

// ── 계정 조회 (D1 accounts, phone = PK) ──
export async function findAccountByPhone(env, phone) {
  if (!phone) return null;
  const r = await env.DB.prepare(
    'SELECT phone, password_hash, salt, must_change_pw FROM accounts WHERE phone = ?'
  ).bind(phone).first();
  if (!r) return null;
  return {
    id: r.phone,                 // D1은 phone이 키 (update/touch가 이걸 받음)
    phone: r.phone,
    hash: r.password_hash || '',
    salt: r.salt || '',
    mustChangePassword: r.must_change_pw === 1,
  };
}

// ── 계정 신규 생성 (D1, upsert) ──
export async function createAccount(env, phone, password, mustChangePassword = true, note = '') {
  const { hash, salt } = await hashPassword(password);
  try {
    await env.DB.prepare(
      'INSERT INTO accounts (phone, password_hash, salt, must_change_pw, note) VALUES (?,?,?,?,?) ' +
      'ON CONFLICT(phone) DO UPDATE SET password_hash=excluded.password_hash, salt=excluded.salt, ' +
      'must_change_pw=excluded.must_change_pw, note=excluded.note'
    ).bind(phone, hash, salt, mustChangePassword ? 1 : 0, note || '').run();
    return { ok: true, id: phone };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 계정 비밀번호 업데이트 (D1, phone 기준) ──
export async function updateAccountPassword(env, phoneOrId, newPassword) {
  const { hash, salt } = await hashPassword(newPassword);
  try {
    await env.DB.prepare('UPDATE accounts SET password_hash=?, salt=?, must_change_pw=0 WHERE phone=?')
      .bind(hash, salt, phoneOrId).run();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 마지막 로그인 시각 갱신 (D1, phone 기준, 비치명적) ──
export async function touchLastLogin(env, phoneOrId) {
  try {
    await env.DB.prepare('UPDATE accounts SET last_login=? WHERE phone=?')
      .bind(new Date().toISOString(), phoneOrId).run();
  } catch (_) { /* 비치명적 */ }
}

// ── 표준 응답 헬퍼 ──
export function jsonError(message, status = 400) {
  return Response.json({ error: message }, { status });
}

export async function requireAuth(env, request) {
  const token = bearerFromRequest(request);
  const payload = await verifyToken(env, token);
  if (!payload) return { ok: false, response: jsonError('로그인이 필요합니다.', 401) };
  return { ok: true, phone: payload.phone, token, payload };
}

// ── 토큰의 휴대폰이 특정 학생(이름)과 연결됐는지 검증 ──
//   학생 이름이 비어있으면 자동으로 첫 자녀 반환. 그 외엔 일치 검사.
//   반환: { ok, student, students, error? }
export async function resolveStudent(env, phone, studentName) {
  const students = await fetchStudentsByPhone(env, phone);
  if (!students.length) {
    return { ok: false, students: [], error: '이 휴대폰에 연결된 학생이 없습니다.' };
  }
  if (!studentName || !studentName.trim()) {
    // 학생 이름 명시 안 됐으면 첫 번째 자녀 사용
    // 🎓 2026-08-10 — 단, **재원 중인 자녀를 먼저** 고른다.
    //   수료 행이 남기 시작하면서, 겸반·형제로 여러 행이 있을 때 id 순 첫 행이 수료생일 수 있게 됐다.
    //   그러면 이름을 안 넘긴 화면(영상·출결 등)이 멀쩡히 다니는 자녀 대신 수료생을 집어
    //   "영상이 잠겼다"고 보여준다. 재원생이 하나도 없을 때만 수료생으로 떨어진다.
    const 재원 = students.find(s => isEnrolled(s.approvalStatus));
    return { ok: true, student: 재원 || students[0], students };
  }
  // 🎓 2026-08-10 — 이름을 받은 경로도 **재원 행을 먼저** 고른다. (위 무명 경로와 같은 이유·같은 규칙)
  //   겸반이면 같은 이름의 students 행이 여러 개다. 「시동반 (26-1)=수료 · 공통수학2 (26-2)=재원」인 학생이
  //   find() 로 수료 행에 먼저 걸리면, 멀쩡히 다니는 아이 화면에 "수강이 끝난 반입니다"가 뜨고 영상이 잠긴다.
  //   report.html·출결·성적 화면은 전부 ?name= 으로 오므로 **여기가 실제 경로**다. 위만 고치면 못 막는다.
  //   재원 행이 하나도 없을 때만(전부 수료) 첫 행으로 떨어진다 — 그때는 잠기는 게 맞다.
  const matches = students.filter(s => s.name === studentName.trim());
  if (!matches.length) {
    return { ok: false, students, error: '이 학생 정보에 접근할 권한이 없습니다.' };
  }
  const target = matches.find(s => isEnrolled(s.approvalStatus)) || matches[0];
  return { ok: true, student: target, students };
}

// ── 한 번에 인증 + 학생 매칭 (대부분의 API에서 사용) ──
//   request에서 토큰 추출 → ?name=... 또는 body.name으로 학생 매칭
export async function requireStudentAccess(env, request, options = {}) {
  const auth = await requireAuth(env, request);
  if (!auth.ok) return { ok: false, response: auth.response };

  const url = new URL(request.url);
  const name = url.searchParams.get('name') || options.name || '';

  const resolved = await resolveStudent(env, auth.phone, name);
  if (!resolved.ok) {
    return { ok: false, response: jsonError(resolved.error || '권한 없음', 403) };
  }
  return {
    ok: true, phone: auth.phone, token: auth.token,
    student: resolved.student, students: resolved.students,
  };
}
