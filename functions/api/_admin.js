// 관리자 세션 토큰 (HMAC 서명, 무상태)
// 목적: admin 비밀번호 원본을 클라이언트(localStorage)에 저장하지 않기 위함.
//   로그인 시 이 토큰을 발급하고, _middleware.js가 검증해서 다운스트림엔
//   기존 Authorization: Bearer <ADMIN_PASSWORD> 로 "번역"한다 → 31개 endpoint 무수정.
// 토큰 형식:  adm_<expMs>_<hmacHex>   (HMAC key = ADMIN_PASSWORD, msg = expMs 문자열)
// 폐기: ADMIN_PASSWORD를 바꾸면 발급된 모든 토큰이 즉시 무효화됨.

const PREFIX = 'adm_';
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일 (기존 R2 토큰과 동일 UX)

async function hmacHex(key, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 새 관리자 세션 토큰 발급
export async function issueAdminSession(env, ttlMs = DEFAULT_TTL_MS) {
  if (!env.ADMIN_PASSWORD) return null;
  const exp = Date.now() + ttlMs;
  const sig = await hmacHex(env.ADMIN_PASSWORD, String(exp));
  return PREFIX + exp + '_' + sig;
}

// 토큰 검증 (형식·만료·서명). 유효하면 true.
export async function verifyAdminSession(env, token) {
  if (!env.ADMIN_PASSWORD || typeof token !== 'string' || !token.startsWith(PREFIX)) return false;
  const rest = token.slice(PREFIX.length);
  const sep = rest.indexOf('_');
  if (sep < 0) return false;
  const expStr = rest.slice(0, sep);
  const sig = rest.slice(sep + 1);
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = await hmacHex(env.ADMIN_PASSWORD, expStr);
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function isAdminSessionToken(token) {
  return typeof token === 'string' && token.startsWith(PREFIX);
}

// 요청 쿠키에서 name 값 추출 (없으면 null)
export function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// ───────────────────────────────────────────────────────────
// 조교(운영진 staff) 무상태 서명 세션 — adm_(원장 풀권한)와 구분되는 ast_ 토큰.
//   형식:  ast_<expMs>_<phoneDigits>_<hmacHex>   (HMAC key = ADMIN_PASSWORD, msg = expMs + '|staff|' + phoneDigits)
//   조교 신원(전화번호)을 토큰에 서명해 넣어 _middleware.js가 X-Staff-Phone 헤더로 전달 →
//   students/worklog 등에서 "이 조교가 맡은 학원"으로 스코핑할 수 있게 한다.
//   _middleware.js가 ast_ 토큰은 '열람(GET) + 질문답변(/api/qna) + 근무기록'만 ADMIN_PASSWORD로 번역하고,
//   그 외 쓰기·삭제·계정 엔드포인트는 403으로 막는다 → 조교 권한 제한.
//   폐기: ADMIN_PASSWORD 변경 시 발급된 모든 ast_ 토큰도 즉시 무효화.
//   ⚠️ 구(舊) 형식(ast_<exp>_<sig>, 전화번호 없음) 토큰은 이 변경 후 검증 실패 → 조교 재로그인 필요(소수라 OK).
// ───────────────────────────────────────────────────────────
const STAFF_PREFIX = 'ast_';
const STAFF_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일

export async function issueStaffSession(env, phone, ttlMs = STAFF_TTL_MS) {
  if (!env.ADMIN_PASSWORD) return null;
  const ph = String(phone || '').replace(/\D/g, '');
  const exp = Date.now() + ttlMs;
  const sig = await hmacHex(env.ADMIN_PASSWORD, exp + '|staff|' + ph);
  return STAFF_PREFIX + exp + '_' + ph + '_' + sig;
}

// 검증 성공 시 { phone: '<digits>' } 반환, 실패 시 null.
export async function verifyStaffSession(env, token) {
  if (!env.ADMIN_PASSWORD || typeof token !== 'string' || !token.startsWith(STAFF_PREFIX)) return null;
  const rest = token.slice(STAFF_PREFIX.length);
  const parts = rest.split('_');
  if (parts.length !== 3) return null; // 구 형식(2조각)·변형 토큰 거부
  const [expStr, ph, sig] = parts;
  if (!/^[0-9]+$/.test(expStr) || !/^[0-9]+$/.test(ph)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = await hmacHex(env.ADMIN_PASSWORD, expStr + '|staff|' + ph);
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? { phone: ph } : null;
}

export function isStaffSessionToken(token) {
  return typeof token === 'string' && token.startsWith(STAFF_PREFIX);
}

// ───────────────────────────────────────────────────────────
// 🔄 2026-07-29 — 원장·조교도 "계속 로그인" (슬라이딩 갱신). 관우T 지시.
//   예전: 로그인 후 30일이 지나면 매일 쓰고 있어도 예고 없이 튕겨서 비밀번호를 다시 넣어야 했다.
//   지금: 접속할 때마다 만료를 다시 30일 뒤로 민 **새 토큰**을 발급한다.
//         adm_/ast_는 무상태 HMAC 서명(만료가 토큰 안에 박힘)이라 서버가 임의로 늘릴 수 없다.
//         → _middleware.js가 새 토큰을 응답헤더 `X-Kw-Session`으로 내려주고,
//           /session-keep.js가 localStorage('kwmath_admin_token')에 덮어쓴다.
//   30일 내내 한 번도 안 들어오면 그때 만료 = 방치된 토큰은 예전처럼 죽는다(보안 동일).
//   매 응답마다 새로 만들면 낭비라 "발급된 지 하루 지났을 때"만 만든다.
//   ※ 학생·학부모 토큰(R2 저장형)의 같은 기능은 `_auth.js` verifyToken에 있다.
// ───────────────────────────────────────────────────────────
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

// 토큰 문자열에서 만료(ms)만 꺼낸다. adm_<exp>_… · ast_<exp>_<phone>_… 둘 다 첫 조각이 exp.
function expOfToken(token, prefix) {
  if (typeof token !== 'string' || !token.startsWith(prefix)) return NaN;
  const rest = token.slice(prefix.length);
  const sep = rest.indexOf('_');
  if (sep < 0) return NaN;
  const n = Number(rest.slice(0, sep));
  return Number.isFinite(n) ? n : NaN;
}

// 갱신할 때가 됐으면 새 토큰 문자열, 아니면 null. (호출 전에 서명검증이 끝나 있어야 함)
export async function renewAdminSessionIfDue(env, token) {
  const exp = expOfToken(token, PREFIX);
  if (!Number.isFinite(exp)) return null;
  if (exp - Date.now() > DEFAULT_TTL_MS - RENEW_AFTER_MS) return null;   // 발급된 지 아직 하루 안 됨
  return await issueAdminSession(env);
}

export async function renewStaffSessionIfDue(env, token, phoneDigits) {
  const exp = expOfToken(token, STAFF_PREFIX);
  if (!Number.isFinite(exp)) return null;
  if (exp - Date.now() > STAFF_TTL_MS - RENEW_AFTER_MS) return null;
  return await issueStaffSession(env, phoneDigits);
}
