// kwmath 인증 공통 유틸 (Cloudflare Pages Functions / Workers)
// - PBKDF2 SHA-256 비밀번호 해싱 (Web Crypto API)
// - 랜덤 토큰 발급 + R2에 저장
// - 다른 API에서 import해서 토큰 검증

export const ACCOUNTS_DB = '893a626479514059ae309a269b3661b5';
export const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';
export const TOKEN_TTL_DAYS = 30;

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
    return { ok: true, student: students[0], students };
  }
  const target = students.find(s => s.name === studentName.trim());
  if (!target) {
    return { ok: false, students, error: '이 학생 정보에 접근할 권한이 없습니다.' };
  }
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
