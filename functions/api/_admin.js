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
