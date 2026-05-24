// kwmath 인증 공통 유틸 (Cloudflare Pages Functions / Workers)
// - PBKDF2 SHA-256 비밀번호 해싱 (Web Crypto API)
// - 랜덤 토큰 발급 + R2에 저장
// - 다른 API에서 import해서 토큰 검증

export const ACCOUNTS_DB = '893a626479514059ae309a269b3661b5';
export const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';
export const TOKEN_TTL_DAYS = 30;

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

export async function issueToken(env, phone) {
  const token = generateRandomToken();
  const expires = Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  const payload = JSON.stringify({ phone, expires, createdAt: Date.now() });
  await env.BUCKET.put('auth/tokens/' + token + '.json', payload, {
    httpMetadata: { contentType: 'application/json' },
  });
  return { token, expires };
}

export async function verifyToken(env, token) {
  if (!token) return null;
  const obj = await env.BUCKET.get('auth/tokens/' + token + '.json');
  if (!obj) return null;
  try {
    const payload = await obj.json();
    if (!payload || !payload.phone) return null;
    if (typeof payload.expires === 'number' && payload.expires < Date.now()) {
      // 만료 → 정리
      try { await env.BUCKET.delete('auth/tokens/' + token + '.json'); } catch(_) {}
      return null;
    }
    return payload; // { phone, expires, createdAt }
  } catch (e) {
    return null;
  }
}

export async function revokeToken(env, token) {
  if (!token) return;
  try { await env.BUCKET.delete('auth/tokens/' + token + '.json'); } catch(_) {}
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
  const res = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: {
        or: [
          { property: '학부모 휴대폰', rich_text: { equals: phone } },
          { property: '학생 연락처',   rich_text: { equals: phone } },
        ],
      },
      page_size: 20,
    }),
  });
  const data = await res.json();
  if (data.object === 'error') return [];
  const rt   = (p, k) => (p[k]?.rich_text || [])[0]?.plain_text || '';
  const sel  = (p, k) => p[k]?.select?.name || '';
  const ttl  = (p, k) => (p[k]?.title || [])[0]?.plain_text || '';
  return (data.results || []).filter(p => !p.archived && !p.in_trash).map(p => {
    const props = p.properties || {};
    const parentPhone  = rt(props, '학부모 휴대폰');
    const studentPhone = rt(props, '학생 연락처');
    return {
      id: p.id,
      name: ttl(props, '이름'),
      school: rt(props, '학교'),
      grade: sel(props, '학년'),
      academy: sel(props, '학원'),
      className: sel(props, '반'),
      // 이 휴대폰이 학부모/학생 중 어느 쪽으로 매칭됐는지
      role: phone === parentPhone ? 'parent' : (phone === studentPhone ? 'student' : 'other'),
      parentPhone, studentPhone,
    };
  });
}

// ── 계정 DB에서 휴대폰으로 계정 조회 ──
export async function findAccountByPhone(env, phone) {
  if (!phone) return null;
  const res = await fetch(`https://api.notion.com/v1/databases/${ACCOUNTS_DB}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: { property: '휴대폰', title: { equals: phone } },
      page_size: 1,
    }),
  });
  const data = await res.json();
  if (data.object === 'error') return null;
  const page = (data.results || []).find(p => !p.archived && !p.in_trash);
  if (!page) return null;
  const p = page.properties || {};
  const rt = (k) => (p[k]?.rich_text || [])[0]?.plain_text || '';
  return {
    id: page.id,
    phone,
    hash: rt('비밀번호 해시'),
    salt: rt('salt'),
    mustChangePassword: p['변경 필요']?.checkbox === true,
  };
}

// ── 계정 신규 생성 ──
export async function createAccount(env, phone, password, mustChangePassword = true, note = '') {
  const { hash, salt } = await hashPassword(password);
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: ACCOUNTS_DB },
      properties: {
        '휴대폰':       { title:     [{ text: { content: phone } }] },
        '비밀번호 해시': { rich_text: [{ text: { content: hash } }] },
        'salt':         { rich_text: [{ text: { content: salt } }] },
        '변경 필요':    { checkbox: !!mustChangePassword },
        '비고':         { rich_text: [{ text: { content: note || '' } }] },
      },
    }),
  });
  const data = await res.json();
  if (data.object === 'error') return { ok: false, error: data.message };
  return { ok: true, id: data.id };
}

// ── 계정 비밀번호 업데이트 ──
export async function updateAccountPassword(env, accountPageId, newPassword) {
  const { hash, salt } = await hashPassword(newPassword);
  const res = await fetch(`https://api.notion.com/v1/pages/${accountPageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        '비밀번호 해시': { rich_text: [{ text: { content: hash } }] },
        'salt':         { rich_text: [{ text: { content: salt } }] },
        '변경 필요':    { checkbox: false },
      },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { ok: false, error: err.message || 'Notion 수정 실패' };
  }
  return { ok: true };
}

// ── 마지막 로그인 시각 갱신 ──
export async function touchLastLogin(env, accountPageId) {
  try {
    await fetch(`https://api.notion.com/v1/pages/${accountPageId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          '마지막 로그인': { date: { start: new Date().toISOString() } },
        },
      }),
    });
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

// ── 토큰의 휴대폰이 특정 학생(이름)과 연결됐는지 검증 ──
//   학생 이름이 비어있으면 자동으로 첫 자녀 반환. 그 외엔 일치 검사.
//   반환: { ok, student, students, error? }
export async function resolveStudent(env, phone, studentName) {
  const students = await fetchStudentsByPhone(env, phone);
  if (!students.length) {
    return { ok: false, students: [], error: '이 휴대폰에 연결된 학생이 없습니다.' };
  }
  if (!studentName || !studentName.trim()) {
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
  const name = url.searchParams.get('name') || (options && options.name) || '';

  const resolved = await resolveStudent(env, auth.phone, name);
  if (!resolved.ok) {
    return { ok: false, response: jsonError(resolved.error || '권한 없음', 403) };
  }
  return {
    ok: true, phone: auth.phone, token: auth.token,
    student: resolved.student, students: resolved.students,
  };
}
