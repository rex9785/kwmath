// kwmath 변경이력(감사) 로그 — "무슨 일이 있었는지 영구히 남긴다".
// ═══════════════════════════════════════════════════════════════════════════
// 왜 만들었나 (2026-07-31, 관우T 지시: "로그가 정말 중요해. 디테일한 것까지 로그 남겨")
//   기존 저장 구조는 대부분 "지금 상태"만 들고 있었다.
//     예) fcm-tokens/{전화번호}.json 은 마지막 등록 시각만 남아서,
//         "이 폰이 언제 붙었다 떨어졌다 다시 붙었는지"를 사후에 알 수 없었다.
//         실제로 2026-07-31 푸시 오배송을 추적할 때 이것 때문에 애먹었다.
//   → 이 파일은 상태가 아니라 **사건**을 쌓는다. 지워지지 않는다.
//
// access_events(_eventlog.js)와 무엇이 다른가
//   _eventlog.js  = 트래픽 로그. 누가 어느 페이지/API를 열었나. 120일 뒤 자동삭제. 백업 제외.
//   _auditlog.js  = 변경 로그. 무엇이 생기고 바뀌고 지워졌나. **자동삭제 없음.** 백업 포함.
//   둘은 목적이 달라 합치지 않았다. 트래픽은 양이 많아 오래 두면 손해고,
//   변경이력은 양이 적고 오래 둘수록 가치가 커진다.
//
// 설계 원칙
//   ① 로깅 실패가 본 작업을 절대 막지 않는다 (전부 try/catch, throw 안 함).
//   ② 지우는 일에는 **지우기 전 값(before)** 을 반드시 같이 남긴다. 그래야 되돌릴 수 있다.
//   ③ 기기는 코드(SM-S928N)만 남기지 말고 **사람이 읽는 이름**(갤럭시 S24 울트라)도 같이 남긴다.
//      단 원본 UA도 통째로 보관한다 — 변환표가 모르는 신형이 나와도 정보가 사라지면 안 되므로.
//   ④ 원본 IP는 저장하지 않는다(_eventlog.js와 동일한 일별 해시 정책 — 추적없음 선언 유지).

let _ready = false;

async function ensureTable(env) {
  if (_ready) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS audit_log (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
      'ts TEXT NOT NULL, ' +           // ISO8601(UTC) 발생시각
      'action TEXT NOT NULL, ' +       // 'push.register' 'student.delete' 처럼 점으로 구분한 사건 이름
      'actor TEXT, ' +                 // 누가 했나 — 휴대폰번호 · '__owner__' · 'system'(크론)
      'actor_role TEXT, ' +            // 'owner'|'staff'|'student'|'parent'|'system'|'anon'
      'actor_name TEXT, ' +            // 사람 이름 — '원장' · 조교 이름. 번호만 보면 누군지 모른다.
      'target TEXT, ' +                // 무엇에 대해 — 학생 id · 휴대폰 · R2 키 등
      'target_name TEXT, ' +           // 대상의 사람이 읽는 이름 — 학생 이름 등 (id만 남기면 나중에 못 읽는다)
      'summary TEXT, ' +               // 한글 한 줄 요약 (사람이 읽는 용도)
      'detail TEXT, ' +                // JSON 문자열 — before/after 등 세부값 전부
      'path TEXT, ' +                  // 어느 API/화면에서 일어났나 (method + pathname + 쿼리)
      'device TEXT, ' +                // 사람이 읽는 기기명 (갤럭시 Z폴드6 · 앱)
      'ua TEXT, ' +                    // 원본 User-Agent (최대 400자, 잘라도 앞부분에 기종이 있음)
      'ip_hash TEXT, ' +               // SHA-256(ip|날짜|비밀) 앞16자. 원본 IP 저장 안 함
      'country TEXT)'                  // CF-IPCountry
  ).run();
  // 이미 만들어진 표에는 CREATE TABLE IF NOT EXISTS 가 새 컬럼을 안 붙인다 → 하나씩 ALTER.
  //   이미 있으면 예외가 나는데, 그게 정상이라 조용히 넘긴다.
  for (const col of ['actor_name TEXT', 'target_name TEXT', 'path TEXT']) {
    try { await env.DB.prepare('ALTER TABLE audit_log ADD COLUMN ' + col).run(); } catch (_) {}
  }
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_al_ts ON audit_log(ts)').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_al_action ON audit_log(action)').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_al_target ON audit_log(target)').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_al_actor ON audit_log(actor)').run(); } catch (_) {}
  _ready = true;
}

// ───────────────────────── 기기 이름 변환 ─────────────────────────
// 삼성 모델코드 → 사람이 읽는 이름. 국내 접미사(N 자급제 · K KT · L LGU+ · S SKT)와
// 뒤 한 자리는 떼고 앞 7자리(SM-S928)로 맞춘다. 표에 없으면 코드 그대로 남긴다(정보 손실 금지).
const SAMSUNG = {
  // 폴더블
  'SM-F966': '갤럭시 Z폴드7', 'SM-F956': '갤럭시 Z폴드6', 'SM-F946': '갤럭시 Z폴드5',
  'SM-F936': '갤럭시 Z폴드4', 'SM-F926': '갤럭시 Z폴드3', 'SM-F916': '갤럭시 Z폴드2',
  'SM-F958': '갤럭시 Z트라이폴드',
  'SM-F766': '갤럭시 Z플립7', 'SM-F741': '갤럭시 Z플립6', 'SM-F731': '갤럭시 Z플립5',
  'SM-F721': '갤럭시 Z플립4', 'SM-F711': '갤럭시 Z플립3',
  // S 시리즈
  'SM-S938': '갤럭시 S25 울트라', 'SM-S936': '갤럭시 S25+', 'SM-S931': '갤럭시 S25', 'SM-S937': '갤럭시 S25 엣지',
  'SM-S928': '갤럭시 S24 울트라', 'SM-S926': '갤럭시 S24+', 'SM-S921': '갤럭시 S24', 'SM-S721': '갤럭시 S24 FE',
  'SM-S918': '갤럭시 S23 울트라', 'SM-S916': '갤럭시 S23+', 'SM-S911': '갤럭시 S23', 'SM-S711': '갤럭시 S23 FE',
  'SM-S908': '갤럭시 S22 울트라', 'SM-S906': '갤럭시 S22+', 'SM-S901': '갤럭시 S22',
  'SM-G998': '갤럭시 S21 울트라', 'SM-G996': '갤럭시 S21+', 'SM-G991': '갤럭시 S21', 'SM-G990': '갤럭시 S21 FE',
  'SM-G988': '갤럭시 S20 울트라', 'SM-G986': '갤럭시 S20+', 'SM-G981': '갤럭시 S20', 'SM-G780': '갤럭시 S20 FE',
  // 노트
  'SM-N986': '갤럭시 노트20 울트라', 'SM-N981': '갤럭시 노트20',
  'SM-N976': '갤럭시 노트10+', 'SM-N971': '갤럭시 노트10',
  // A 시리즈 (학생들이 가장 많이 쓴다)
  'SM-A566': '갤럭시 A56', 'SM-A556': '갤럭시 A55', 'SM-A546': '갤럭시 A54', 'SM-A536': '갤럭시 A53',
  'SM-A528': '갤럭시 A52s', 'SM-A526': '갤럭시 A52',
  'SM-A366': '갤럭시 A36', 'SM-A356': '갤럭시 A35', 'SM-A346': '갤럭시 A34', 'SM-A336': '갤럭시 A33',
  'SM-A326': '갤럭시 A32',
  'SM-A266': '갤럭시 A26', 'SM-A256': '갤럭시 A25', 'SM-A245': '갤럭시 A24', 'SM-A235': '갤럭시 A23',
  'SM-A226': '갤럭시 점프', 'SM-A236': '갤럭시 점프2',
  'SM-A166': '갤럭시 A16', 'SM-A156': '갤럭시 A15', 'SM-A155': '갤럭시 A15',
  'SM-A136': '갤럭시 와이드6', 'SM-A146': '갤럭시 와이드7',
  'SM-A426': '갤럭시 A42', 'SM-A716': '갤럭시 퀀텀2',
  'SM-M156': '갤럭시 M15',
  // 탭
  'SM-X926': '갤럭시 탭 S10 울트라', 'SM-X916': '갤럭시 탭 S9 울트라', 'SM-X816': '갤럭시 탭 S9+',
  'SM-X710': '갤럭시 탭 S9', 'SM-X716': '갤럭시 탭 S9', 'SM-X510': '갤럭시 탭 S9 FE',
  'SM-X200': '갤럭시 탭 A8', 'SM-X210': '갤럭시 탭 A9+', 'SM-T500': '갤럭시 탭 A7',
};

// 아이폰은 UA에 모델이 안 실린다(애플 정책). iOS 버전까지만 알 수 있다 — 그대로 정직하게 적는다.
function iosName(ua) {
  const m = /(iPhone|iPad|iPod).*?OS (\d+)[._](\d+)/.exec(ua);
  if (!m) return /iPad/.test(ua) ? '아이패드' : '아이폰';
  const kind = m[1] === 'iPad' ? '아이패드' : (m[1] === 'iPod' ? '아이팟' : '아이폰');
  const os = m[1] === 'iPad' ? 'iPadOS' : 'iOS';
  return `${kind} (${os} ${m[2]}.${m[3]})`;
}

// UA 문자열 → "갤럭시 Z폴드6 · 안드로이드 16 · 앱" 같은 한 줄.
// 모르면 억지로 지어내지 않고 원문 조각을 남긴다. ("알 수 없음"으로 뭉개면 추적이 끊긴다.)
export function describeDevice(ua) {
  const s = String(ua || '');
  if (!s) return null;
  const parts = [];

  const sm = /\b(SM-[A-Z]\d{3})\w*/.exec(s);          // SM-S928N → SM-S928
  if (sm) {
    parts.push(SAMSUNG[sm[1]] || sm[0]);              // 표에 없으면 코드 그대로(SM-A999N)
  } else if (/iPhone|iPad|iPod/.test(s)) {
    parts.push(iosName(s));
  } else if (/\bLM-[A-Z]\d+/.test(s)) {
    parts.push('LG ' + (/(LM-[A-Z]\d+)/.exec(s) || [])[1]);
  } else if (/Android/.test(s)) {
    // 삼성이 아닌 안드로이드(픽셀·샤오미 등) → UA의 모델 자리(Android 버전 뒤, Build 앞)를 그대로 쓴다.
    //   "Pixel 8 Pro"처럼 공백이 든 이름도 통째로 잡히므로 기종별 특례를 둘 필요가 없다.
    const m = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(s);
    parts.push(m ? m[1].trim() : '안드로이드 기기');
  } else if (/Windows NT/.test(s)) {
    parts.push('윈도우 PC');
  } else if (/Macintosh|Mac OS X/.test(s)) {
    parts.push('맥');
  } else {
    parts.push(s.slice(0, 40));
  }

  const av = /Android (\d+(?:\.\d+)?)/.exec(s);
  if (av) parts.push('안드로이드 ' + av[1]);

  // 앱(Capacitor WebView)인지 브라우저인지 — 오배송 추적에 결정적이었다.
  if (/;\s*wv\)/.test(s)) parts.push('앱');
  else if (/Android|iPhone|iPad/.test(s)) parts.push('웹');

  return parts.filter(Boolean).join(' · ').slice(0, 120);
}

// ───────────────────────── 기록 ─────────────────────────
async function hashIp(env, ip) {
  if (!ip) return null;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const secret = (env && env.ADMIN_PASSWORD) || 'kwmath-salt';
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + '|' + day + '|' + secret));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch (_) { return null; }
}

// 📤 2026-08-03 (§11-16) — _lockout.js 가 「같은 IP 기준 잠금」에 쓰려고 가져다 쓴다.
//    IP 를 꺼내는 규칙이 두 곳으로 갈라지지 않도록 여기 하나만 두고 내보낸다.
export function clientIp(request) {
  try {
    const cf = request.headers.get('CF-Connecting-IP');
    if (cf) return cf.trim();
    return ((request.headers.get('X-Forwarded-For') || '').split(',')[0] || '').trim();
  } catch (_) { return ''; }
}

// 요청 URL을 "POST /api/attendance?id=24" 형태로. 어느 화면에서 벌어진 일인지가 사후 추적에 크다.
//   ⚠️ 쿼리스트링에 개인정보가 실릴 수 있으므로 아래 민감 키는 값을 가린다.
const QUERY_MASK = new Set(['token', 'pw', 'password', 'phone', 'key', 'secret']);
function describePath(request) {
  try {
    if (!request) return null;
    const u = new URL(request.url);
    const qs = [];
    for (const [k, v] of u.searchParams) {
      qs.push(k + '=' + (QUERY_MASK.has(k.toLowerCase()) ? '***' : String(v).slice(0, 60)));
    }
    return ((request.method || 'GET') + ' ' + u.pathname + (qs.length ? '?' + qs.join('&') : '')).slice(0, 300);
  } catch (_) { return null; }
}

// 변경 1건 기록. best-effort — 절대 throw 하지 않는다.
//   fields: { action, actor?, actorRole?, actorName?, target?, targetName?, summary?, detail?, ua?, path? }
//   request 가 있으면 UA·IP·국가·경로를 자동 수집한다. 크론처럼 request 가 없으면 null 로 넘겨도 된다.
//   actor 계열을 안 넘기면 요청 헤더에서 자동으로 알아낸다(actorOf) — 넘기는 걸 잊어도 '누가'가 안 비도록.
export async function logAudit(env, request, fields = {}) {
  try {
    if (!env || !env.DB || !fields || !fields.action) return;
    await ensureTable(env);

    const ua = String(fields.ua || (request && request.headers.get('User-Agent')) || '');
    const ipHash = request ? await hashIp(env, clientIp(request)) : null;
    const country = (request && request.headers.get('CF-IPCountry')) || null;

    // 부르는 쪽이 actor 를 안 줬으면 헤더에서 캐낸다. 이게 없으면 "누가"가 통째로 비어버린다.
    let actor = fields.actor, actorRole = fields.actorRole, actorName = fields.actorName;
    if (!actor && request) {
      const w = actorOf(request, env);
      actor = w.actor; actorRole = actorRole || w.actorRole; actorName = actorName || w.actorName;
    }

    let detail = null;
    if (fields.detail != null) {
      try { detail = typeof fields.detail === 'string' ? fields.detail : JSON.stringify(fields.detail); }
      catch (_) { detail = String(fields.detail); }
      if (detail && detail.length > 20000) detail = detail.slice(0, 20000) + '…(잘림)';
    }

    await env.DB.prepare(
      'INSERT INTO audit_log (ts, action, actor, actor_role, actor_name, target, target_name, summary, detail, path, device, ua, ip_hash, country) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      new Date().toISOString(),
      String(fields.action).slice(0, 60),
      actor ? String(actor).slice(0, 60) : null,
      actorRole ? String(actorRole).slice(0, 20) : null,
      actorName ? String(actorName).slice(0, 60) : null,
      fields.target != null && fields.target !== '' ? String(fields.target).slice(0, 200) : null,
      fields.targetName ? String(fields.targetName).slice(0, 60) : null,
      fields.summary ? String(fields.summary).slice(0, 300) : null,
      detail,
      fields.path ? String(fields.path).slice(0, 300) : describePath(request),
      describeDevice(ua),
      ua ? ua.slice(0, 400) : null,
      ipHash,
      country,
    ).run();
  } catch (_) {
    // 로깅 실패는 본 작업을 절대 막지 않는다.
  }
}

// 여러 건을 한 번에 (등록 1회에 여러 계정이 정리되는 경우 등). 실패해도 조용히 넘어간다.
export async function logAuditMany(env, request, list) {
  if (!Array.isArray(list) || !list.length) return;
  for (const f of list) { await logAudit(env, request, f); }
}

// 요청에서 "누가 했는지"를 최대한 알아낸다.
// ═══════════════════════════════════════════════════════════════════════════
// 📓 2026-07-31 개정 — 관우T 지시 "어떤 조교가 뭘 만졌고 뭘 바꿨는지도 로그에 남겨야 돼".
//   예전엔 _middleware.js 가 원장·조교 세션을 모두 Bearer ADMIN_PASSWORD 로 번역해 버려서,
//   여기서 알 수 있는 게 '__admin__' 한 덩어리뿐이었다. 조교 셋이 같은 학생 성적을 고쳐도
//   로그가 전부 똑같이 찍혀서 누구 소행인지 영영 알 수 없었다.
//   → 미들웨어가 X-Staff-Phone / X-Staff-Name / X-Kw-Actor-Role 을 실어 보내도록 고쳤고,
//     여기서 그걸 읽는다. 이 헤더들은 미들웨어가 **외부 주입분을 지운 뒤** 세팅하므로 위조 불가.
//
//   판정 순서(위가 우선):
//     1) hint.actor        — 부르는 쪽이 학생·학부모 전화번호처럼 더 정확한 걸 아는 경우
//     2) X-Staff-Phone     — 검증된 조교. actor=전화번호, actorName=조교 이름
//     3) X-Kw-Actor-Role=owner — 원장(adm_ 세션). 원장은 한 명이라 '__owner__' 로 고정
//     4) Bearer == ADMIN_PASSWORD 인데 위 헤더가 없음
//        → 미들웨어를 안 거친 **비번 원본 직접 호출**(MathOS 로컬앱·크론·외부 도구).
//          이건 사람이 아니라 기계일 수 있으므로 원장과 반드시 구분해서 남긴다.
// ═══════════════════════════════════════════════════════════════════════════
export function actorOf(request, env, hint = {}) {
  if (hint && hint.actor) {
    return { actor: String(hint.actor), actorRole: hint.actorRole || null, actorName: hint.actorName || null };
  }
  try {
    const staffPhone = String(request.headers.get('X-Staff-Phone') || '').replace(/\D/g, '');
    if (staffPhone) {
      let nm = request.headers.get('X-Staff-Name') || '';
      try { nm = decodeURIComponent(nm); } catch (_) { /* 인코딩 안 된 값이면 원문 그대로 */ }
      return { actor: staffPhone, actorRole: 'staff', actorName: nm || null };
    }
    const role = String(request.headers.get('X-Kw-Actor-Role') || '');
    if (role === 'owner') return { actor: '__owner__', actorRole: 'owner', actorName: '원장' };

    const authz = (request.headers.get('authorization') || '').replace('Bearer ', '');
    if (authz && env && env.ADMIN_PASSWORD && authz === env.ADMIN_PASSWORD) {
      // 미들웨어 번역을 안 거친 = 비번 원본을 아는 호출. 사람이 아닐 수 있다.
      return { actor: '__adminkey__', actorRole: 'admin-key', actorName: '관리자 비밀번호 직접 사용' };
    }
  } catch (_) {}
  return { actor: null, actorRole: null, actorName: null };
}

// ───────────────────────── 무엇이 어떻게 바뀌었나 ─────────────────────────
// 관우T 지시: "대충 남기거나 간략하게 남기는 것들 있으면 싹다 구체적으로 하게 바꿔."
//   "수정했음" 한 줄만 남기면 나중에 아무 쓸모가 없다. **어느 칸이 무엇에서 무엇으로** 바뀌었는지를 남긴다.
//   반환: { 바뀐칸: ['점수','메모'], 변경: { 점수:{전:'80', 후:'95'}, … }, 요약: '점수 80→95 · 메모 …' }
//   fields 를 주면 그 칸만 본다(안 주면 before/after 양쪽 키 전부).
export function diffFields(before, after, fields) {
  const out = { 바뀐칸: [], 변경: {}, 요약: '' };
  try {
    const b = before || {}, a = after || {};
    const keys = Array.isArray(fields) && fields.length
      ? fields
      : Array.from(new Set(Object.keys(b).concat(Object.keys(a))));
    const bits = [];
    for (const k of keys) {
      const bv = b[k], av = a[k];
      // undefined(안 넘어온 칸)는 "안 건드림"으로 본다. null·''(비움)은 진짜 변경이므로 본다.
      if (av === undefined && bv === undefined) continue;
      if (av === undefined) continue;
      const bs = bv === null || bv === undefined ? '' : (typeof bv === 'object' ? JSON.stringify(bv) : String(bv));
      const as = av === null ? '' : (typeof av === 'object' ? JSON.stringify(av) : String(av));
      if (bs === as) continue;
      out.바뀐칸.push(k);
      out.변경[k] = { 전: bs.slice(0, 500), 후: as.slice(0, 500) };
      bits.push(k + ' ' + (bs === '' ? '(빈칸)' : bs.slice(0, 40)) + '→' + (as === '' ? '(비움)' : as.slice(0, 40)));
    }
    out.요약 = bits.join(' · ').slice(0, 300);
  } catch (_) {}
  return out;
}
