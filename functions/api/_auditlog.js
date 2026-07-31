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
      'actor TEXT, ' +                 // 누가 했나 — 휴대폰번호 · '__admin__' · 'system'(크론)
      'actor_role TEXT, ' +            // 'owner'|'staff'|'student'|'parent'|'system'|'anon'
      'target TEXT, ' +                // 무엇에 대해 — 학생 id · 휴대폰 · R2 키 등
      'summary TEXT, ' +               // 한글 한 줄 요약 (사람이 읽는 용도)
      'detail TEXT, ' +                // JSON 문자열 — before/after 등 세부값 전부
      'device TEXT, ' +                // 사람이 읽는 기기명 (갤럭시 Z폴드6 · 앱)
      'ua TEXT, ' +                    // 원본 User-Agent (최대 400자, 잘라도 앞부분에 기종이 있음)
      'ip_hash TEXT, ' +               // SHA-256(ip|날짜|비밀) 앞16자. 원본 IP 저장 안 함
      'country TEXT)'                  // CF-IPCountry
  ).run();
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

function clientIp(request) {
  try {
    const cf = request.headers.get('CF-Connecting-IP');
    if (cf) return cf.trim();
    return ((request.headers.get('X-Forwarded-For') || '').split(',')[0] || '').trim();
  } catch (_) { return ''; }
}

// 변경 1건 기록. best-effort — 절대 throw 하지 않는다.
//   fields: { action, actor?, actorRole?, target?, summary?, detail?, ua? }
//   request 가 있으면 UA·IP·국가를 자동 수집한다. 크론처럼 request 가 없으면 null 로 넘겨도 된다.
export async function logAudit(env, request, fields = {}) {
  try {
    if (!env || !env.DB || !fields || !fields.action) return;
    await ensureTable(env);

    const ua = String(fields.ua || (request && request.headers.get('User-Agent')) || '');
    const ipHash = request ? await hashIp(env, clientIp(request)) : null;
    const country = (request && request.headers.get('CF-IPCountry')) || null;

    let detail = null;
    if (fields.detail != null) {
      try { detail = typeof fields.detail === 'string' ? fields.detail : JSON.stringify(fields.detail); }
      catch (_) { detail = String(fields.detail); }
      if (detail && detail.length > 20000) detail = detail.slice(0, 20000) + '…(잘림)';
    }

    await env.DB.prepare(
      'INSERT INTO audit_log (ts, action, actor, actor_role, target, summary, detail, device, ua, ip_hash, country) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      new Date().toISOString(),
      String(fields.action).slice(0, 60),
      fields.actor ? String(fields.actor).slice(0, 60) : null,
      fields.actorRole ? String(fields.actorRole).slice(0, 20) : null,
      fields.target ? String(fields.target).slice(0, 200) : null,
      fields.summary ? String(fields.summary).slice(0, 300) : null,
      detail,
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
//   _middleware.js 가 관리자/조교 세션을 Bearer ADMIN_PASSWORD 로 번역하므로,
//   그 경우 개인 식별은 불가능하다 → '__admin__' 으로만 남긴다(원장/조교 구분은 access_events 쪽 login 이벤트로).
export function actorOf(request, env, hint = {}) {
  if (hint && hint.actor) return { actor: String(hint.actor), actorRole: hint.actorRole || null };
  try {
    const authz = (request.headers.get('authorization') || '').replace('Bearer ', '');
    if (authz && env && env.ADMIN_PASSWORD && authz === env.ADMIN_PASSWORD) {
      return { actor: '__admin__', actorRole: 'owner-or-staff' };
    }
  } catch (_) {}
  return { actor: null, actorRole: null };
}
