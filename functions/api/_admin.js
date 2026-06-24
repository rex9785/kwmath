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
