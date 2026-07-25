// kwmath 접근 이벤트 로깅 (Cloudflare D1) — "조용히 기록만" 하는 유틸.
// ───────────────────────────────────────────────────────────────
// 목적: 홈페이지·앱의 접속/로그인/기능사용을 D1(access_events)에 남긴다.
//   평상시엔 어떤 화면에도 안 보이고, 필요할 때 관우T(또는 Claude)가
//   쿼리/코딩으로 꺼내 본다. (admin UI 없음 = 의도된 설계)
//
// 무엇을 남기나
//   * kind='login' : 로그인 성공 이벤트 — 누가(phone·role·name) 언제 들어왔는지. (login.js가 호출)
//   * kind='page'  : HTML 페이지 내비게이션 (홈페이지·포털·admin 등). (_middleware.js가 호출)
//   * kind='api'   : /api/* 호출 = 로그인 사용자의 기능/데이터 접근 자취. (_middleware.js가 호출)
//   비로그인(익명) 방문도 page/api로 남되, 신원(phone)은 비고 ip_hash·referer·country만 남는다.
//
// 개인정보/추적없음 유지 (앱스토어 'App 개인정보=추적 없음' 선언과 무충돌)
//   * 원본 IP는 저장하지 않는다. SHA-256(ip|날짜|ADMIN_PASSWORD) 앞 16자만 저장(ip_hash).
//     - 같은 날 같은 IP는 같은 해시 → 하루 안에서 익명 방문 묶기 가능.
//     - 날짜가 바뀌면 해시가 달라짐 → 장기 프로파일링 불가(개인정보 최소화).
//   * 쿠키·제3자 스크립트·기기ID 없음. 전부 1st-party 서버 로그(운영/보안 목적).
//     → 홈페이지 상담폼 유입로깅(referrer·utm)과 동일한 정책 라인.
//
// 가용성 우선 — 이 파일의 모든 DB 작업은 try/catch로 감싼다.
//   로깅이 실패해도 실제 요청(로그인·페이지·API)은 절대 막지 않는다.

let _ready = false;

async function ensureTable(env) {
  if (_ready) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS access_events (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
      'ts TEXT NOT NULL, ' +          // ISO8601(UTC) 발생시각
      'kind TEXT NOT NULL, ' +        // 'login' | 'page' | 'api'
      'method TEXT, ' +               // GET/POST/PATCH/DELETE
      'path TEXT, ' +                 // URL pathname (쿼리스트링 제외)
      'status INTEGER, ' +            // 응답 상태코드 (page/api). login은 null
      'phone TEXT, ' +                // 식별된 계정 휴대폰(있으면). 익명은 null
      'role TEXT, ' +                 // 'owner'|'staff'|'student'|'parent'|'user'|null
      'name TEXT, ' +                 // 이름(주로 login 이벤트). 없으면 null
      'ip_hash TEXT, ' +             // SHA-256(ip|날짜|비밀) 앞16자. 원본IP 저장 안 함
      'country TEXT, ' +             // CF-IPCountry (예: KR)
      'ua TEXT, ' +                   // User-Agent (최대 240자)
      'referer TEXT)'                 // 유입 출처 URL (최대 300자)
  ).run();
  // 조회 성능용 인덱스 (없으면 생성)
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ae_ts ON access_events(ts)').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ae_kind ON access_events(kind)').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ae_phone ON access_events(phone)').run(); } catch (_) {}
  _ready = true;
}

// 정적 자원 확장자 — 이건 기록하지 않는다(로그 폭증·용량 방지).
const SKIP_EXT = /\.(css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|ogg|pdf|txt|xml|webmanifest)$/i;

// 경로를 로깅 종류로 분류. null이면 기록 안 함.
//   /api/*            → 'api'
//   정적 자원(확장자) → null (제외)
//   그 외(.html·확장자 없는 경로) → 'page'
export function classifyPath(pathname) {
  if (!pathname || typeof pathname !== 'string') return null;
  if (pathname.startsWith('/api/')) return 'api';
  if (SKIP_EXT.test(pathname)) return null;
  return 'page';
}

// 원본 IP를 저장하지 않기 위한 일방향 해시 (하루 단위 솔트).
async function hashIp(env, ip) {
  if (!ip) return null;
  try {
    const day = new Date().toISOString().slice(0, 10);           // YYYY-MM-DD (UTC)
    const secret = (env && env.ADMIN_PASSWORD) || 'kwmath-salt';
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(ip + '|' + day + '|' + secret));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch (_) {
    return null;
  }
}

function clientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const xff = request.headers.get('X-Forwarded-For') || '';
  return (xff.split(',')[0] || '').trim();
}

// 접근 이벤트 1건 기록 (best-effort — 절대 throw 안 함).
//   fields: { kind, method?, path?, status?, phone?, role?, name? }
//   request 헤더에서 ip/country/ua/referer를 자동 수집.
export async function logEvent(env, request, fields = {}) {
  try {
    if (!env || !env.DB) return;
    await ensureTable(env);

    let path = fields.path;
    if (!path) { try { path = new URL(request.url).pathname; } catch (_) { path = ''; } }

    const ipHash  = await hashIp(env, clientIp(request));
    const country = request.headers.get('CF-IPCountry') || null;
    const ua      = (request.headers.get('User-Agent') || '').slice(0, 240) || null;
    const referer = (request.headers.get('Referer') || '').slice(0, 300) || null;

    await env.DB.prepare(
      'INSERT INTO access_events (ts, kind, method, path, status, phone, role, name, ip_hash, country, ua, referer) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      new Date().toISOString(),
      fields.kind || 'page',
      fields.method || (request && request.method) || null,
      (path || '').slice(0, 300),
      (fields.status == null ? null : fields.status),
      fields.phone || null,
      fields.role || null,
      fields.name || null,
      ipHash,
      country,
      ua,
      referer,
    ).run();

    // 크론 없이 자동 용량관리 — 가끔(≈0.5%) 오래된 로그 삭제. 보존 120일.
    if (Math.random() < 0.005) {
      try {
        const cutoff = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare('DELETE FROM access_events WHERE ts < ?').bind(cutoff).run();
      } catch (_) { /* 정리 실패는 무시 */ }
    }
  } catch (_) {
    // 로깅 실패는 실제 요청을 절대 막지 않는다.
  }
}
