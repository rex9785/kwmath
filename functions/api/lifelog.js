// /api/lifelog — 「생활기록」 : 지정 학생 1명 전용 (식사 · 운동 · 학원기기 출석)
// ═══════════════════════════════════════════════════════════════════════════
// ▸ 왜 이 파일이 따로 있나 (2026-08-19, 관우T 요청)
//   서지환 학생 1명만을 위한 기능이다. **퇴원하면 이 기능이 없던 상태로 되돌린다**가
//   요구사항의 1순위였다. 그래서 기존 테이블·기존 API를 일절 건드리지 않고
//   전부 `lifelog_` 접두사 테이블 + R2 `lifelog/` 접두사 안에만 산다.
//   원복 = DELETE ?admin=1&purge=1&confirm=DELETE 한 방 (테이블 4개 DROP + R2 정리).
//   ✋ 기각한 안: 기존 attendance 테이블에 컬럼을 붙이는 안 —
//      지울 때 남의 출결까지 위험해지고, 출석 현황 달력에 이 학생만 다른 규칙으로 섞인다.
//
// ▸ 대상 학생은 하드코딩하지 않는다
//   student_id 는 D1 에만 있고 코드에는 없다. `lifelog_config.target_student_id` 로 둔다.
//   → 퇴원 시 관리자 화면에서 「해제」 한 번이면 학생 화면에서 버튼이 사라진다.
//   ✋ 기각한 안: 이름('서지환') 비교 — 동명이인 안전 규칙 위반. 식별은 언제나 student.id.
//
// ▸ 출석은 왜 「기기 등록」인가
//   집에서 눌러버릴 수 있으면 출석이 아니다. 그래서 학원 폰·태블릿을 1회 등록해 두고
//   그 기기에서만 버튼이 뜨고 서버가 받아준다. 판정은 **두 겹**이다.
//     1) 기기 비밀값(device secret) — 등록할 때 서버가 발급, 그 기기 localStorage 에만 있음
//     2) 그 비밀값이 등록될 때 찍힌 **기기 모델**(UA)과 지금 UA 의 모델이 같은지
//   비밀값만 베껴 다른 폰에 넣어도 모델이 달라 튕긴다. (모델만 보면 같은 기종끼리 뚫린다.)
//   ⚠️ UA 전체가 아니라 '모델'만 본다 — OS 업데이트(안드로이드 16→17)로 UA 뒷자리가
//      바뀌어도 출석이 막히면 안 되기 때문. describeDevice() 의 첫 토막이 모델이다.
//
// ▸ 열람 범위: 학생 본인 + 그 학부모 + 원장.
//   ⚠️ 2026-08-19 관우T 지시로 **학부모가 추가됐다**("학부모도 그거 볼 수 있게 만들어줘").
//      그전 규칙은 "학부모 제외"였다 — 옛 주석·인수인계 문장이 남아 있으면 그게 낡은 것이다.
//   단 학부모는 **보기만** 한다. 쓰기(출석·기기등록·기록저장·삭제)는 studentGate() 가 그대로 막는다.
//      기록을 남기는 주체가 학생 본인이어야 이 기능이 의미가 있기 때문.
//
// ▸ 알림 (2026-08-20 관우T 지시) — 수신자가 규칙마다 다르다. 아래 「🔔 알림」 절이 원문과 표.
//   ① 출석함 · ② 식사/운동 기록함 → 관우T + 학부모   ③ 안 한 것 독촉 → **학생 본인만**
//   ③은 관우T·학부모에게 한 통도 가면 안 된다. 잘못 섞이는 유일한 경로가 "학생 폰 == 학부모 폰"이라
//   그때는 아예 안 보낸다(remindTargets 가드). 발동은 5분 크론(/api/notices-flush)이 건다.
//
// ▸ 데이터
//   lifelog_config(key TEXT PK, value TEXT, updated_at)      target_student_id 등
//   lifelog_entries(id, student_id, date, kind, slot, content,
//                   photo_keys(JSON), photo_count, created_at, updated_at)
//                   UNIQUE(student_id, date, kind, slot)
//   lifelog_checkin(id, student_id, date, ts, device_id, device_label, ua, ua_model,
//                   ip_hash, source)                          UNIQUE(student_id, date)
//   lifelog_devices(id, secret, label, ua, ua_model, enroll_code, code_expires_at,
//                   enrolled_at, last_used_at, active, created_at)
//   R2 키: lifelog/{student_id}/{date}/{ts}_{rand}_{safeName}
//
// ▸ 라우트
//   GET  ?ping=1                          학생: 이 기능이 나에게 켜져 있나 (포털 버튼 노출용)
//   GET  ?name=..&from=..&to=..           학생: 내 기록 + 출석 + 이 기기 등록 여부
//   GET  ?photo=1&key=..                  사진 스트림 (학생=본인 것만 · 원장=전부)
//   GET  ?admin=1                         원장: 설정 · 등록기기 목록 · 최근 요약
//   GET  ?admin=1&entries=1&from=&to=     원장: 기간 기록
//   GET  ?admin=1&export=1&from=&to=      원장: 엑셀 + 사진 ZIP 내려받기
//   POST (multipart: kind,date,slot,content,file[])   학생: 식사·운동 기록 저장/추가
//   POST ?action=checkin                  학생: 출석 (등록기기에서만)
//   POST ?action=enroll   {code}          학원기기: 등록코드로 이 기기 등록
//   POST ?admin=1&action=set_target       원장: 대상 학생 지정 {student_id}
//   POST ?admin=1&action=clear_target     원장: 대상 해제 (기능 off)
//   POST ?admin=1&action=new_code {label} 원장: 기기 등록코드 발급 (30분 유효)
//   POST ?admin=1&action=revoke_device    원장: 기기 등록 해제 {id}
//   POST ?admin=1&action=manual_checkin   원장: 수동 출석/취소 {date, on}
//   POST ?admin=1&action=set_remind       원장: 독촉 알림 켜기/끄기 · 시각 {on, checkin, breakfast, lunch, dinner}
//   DELETE ?key=..                        학생: 내 사진 1장 삭제
//   DELETE ?entry=ID                      학생: 내 기록 1건 삭제(사진 포함)
//   DELETE ?admin=1&purge=1&confirm=DELETE  원장: 전체 원복(테이블 DROP + R2 삭제)

import { requireStudentAccess, normalizePhone } from './_auth.js';
import { getStudentById } from './_db.js';
import { logAudit, actorOf, describeDevice, clientIp } from './_auditlog.js';
import { sendPushToUsers } from './_push.js';
import { createNotification } from './_notifications.js';

// ── 상한 ──
const MAX_PER_UPLOAD = 20;                 // 한 끼에 사진 20장이면 차고 넘친다
const MAX_PER_ENTRY = 60;                  // 한 칸(예: 8/19 점심)에 누적 상한
const MAX_FILE_BYTES = 15 * 1024 * 1024;   // 1장 15MB
const MAX_ZIP_FILES = 250;                 // 내보내기 ZIP 에 담을 사진 장수 상한
const MAX_ZIP_BYTES = 45 * 1024 * 1024;    // 내보내기 ZIP 원본 합계 상한(Workers 메모리 보호)
const CODE_TTL_MIN = 30;                   // 기기 등록코드 유효시간(분)
const MEAL_SLOTS = ['아침', '점심', '저녁', '간식'];
const WORKOUT_SLOT = '운동';

function jsonOk(data, status = 200) { return Response.json(data, { status }); }
function jsonErr(msg, status = 400) { return Response.json({ error: msg }, { status }); }
function nowIso() { return new Date().toISOString(); }

// 서버(UTC) → KST(+9) 기준 오늘 YYYY-MM-DD
function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function dowKo(ymd) {
  const t = Date.parse(ymd + 'T00:00:00+09:00');
  if (Number.isNaN(t)) return '';
  // ⚠️ t 는 그 날 00:00 KST 의 UTC 순간(= 전날 15:00Z)이라, 그대로 getUTCDay() 하면 하루 밀린다.
  //   실제로 2026-08-19(수)가 '화'로 나왔다. +9시간 되돌려 KST 달력의 요일을 본다.
  return ['일', '월', '화', '수', '목', '금', '토'][new Date(t + 9 * 3600 * 1000).getUTCDay()];
}
// UTC ISO → "08-19 07:32" (KST)
function hmKST(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return '';
  return new Date(t + 9 * 3600 * 1000).toISOString().slice(11, 16);
}

function safeName(name) {
  const clean = String(name || 'photo').replace(/[^a-zA-Z0-9가-힣.\-_]/g, '_');
  if (clean.length <= 80) return clean || 'photo';
  const m = clean.match(/\.[a-zA-Z0-9]{1,5}$/);
  const ext = m ? m[0] : '';
  return (clean.slice(0, 80 - ext.length) + ext) || 'photo';
}
function isImageUpload(file) {
  const t = ((file && file.type) || '').toLowerCase();
  if (t.startsWith('image/')) return true;
  const n = ((file && file.name) || '').toLowerCase();
  return /\.(jpg|jpeg|png|gif|webp|heic|heif|bmp)$/.test(n);
}
function parseKeys(row) {
  if (!row || !row.photo_keys) return [];
  try { const a = JSON.parse(row.photo_keys); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}
// lifelog/{studentId}/{date}/{file} → {studentId, date, file}
function parseLifeKey(key) {
  const parts = String(key || '').split('/');
  if (parts[0] !== 'lifelog' || parts.length < 4) return null;
  return { studentId: parts[1], date: parts[2], file: parts.slice(3).join('/') };
}
function randHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

// UA 문자열 → 기기 모델 한 토막("갤럭시 Z폴드6"). OS 버전·앱/웹 꼬리는 일부러 뗀다.
function deviceModelOf(ua) {
  const d = describeDevice(ua);
  if (!d) return '';
  return String(d).split(' · ')[0].trim();
}

// ─────────────────────────── 테이블 ───────────────────────────
let _ready = false;
async function ensureTable(env) {
  if (_ready) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS lifelog_config (' +
    'key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)'
  ).run();
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS lifelog_entries (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'student_id INTEGER NOT NULL, date TEXT NOT NULL, ' +
    'kind TEXT NOT NULL, slot TEXT NOT NULL, content TEXT, ' +
    'photo_keys TEXT, photo_count INTEGER DEFAULT 0, ' +
    'created_at TEXT, updated_at TEXT)'
  ).run();
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS lifelog_checkin (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'student_id INTEGER NOT NULL, date TEXT NOT NULL, ts TEXT, ' +
    'device_id INTEGER, device_label TEXT, ua TEXT, ua_model TEXT, ' +
    'ip_hash TEXT, source TEXT)'
  ).run();
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS lifelog_devices (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'secret TEXT, label TEXT, ua TEXT, ua_model TEXT, ' +
    'enroll_code TEXT, code_expires_at TEXT, enrolled_at TEXT, ' +
    'last_used_at TEXT, active INTEGER DEFAULT 1, created_at TEXT)'
  ).run();
  try { await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_ll_entry_uniq ON lifelog_entries(student_id, date, kind, slot)').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ll_entry_date ON lifelog_entries(student_id, date)').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_ll_checkin_uniq ON lifelog_checkin(student_id, date)').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_ll_dev_secret ON lifelog_devices(secret)').run(); } catch (_) {}
  _ready = true;
}

async function getCfg(env, key) {
  const row = await env.DB.prepare('SELECT value FROM lifelog_config WHERE key=?').bind(key).first();
  return row ? row.value : null;
}
async function setCfg(env, key, value) {
  const existing = await env.DB.prepare('SELECT key FROM lifelog_config WHERE key=?').bind(key).first();
  if (existing) {
    await env.DB.prepare('UPDATE lifelog_config SET value=?, updated_at=? WHERE key=?').bind(value, nowIso(), key).run();
  } else {
    await env.DB.prepare('INSERT INTO lifelog_config (key, value, updated_at) VALUES (?,?,?)').bind(key, value, nowIso()).run();
  }
}
async function targetId(env) {
  const v = await getCfg(env, 'target_student_id');
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ─────────────────── 지각 → 운동 개수 (2026-08-19 추가) ───────────────────
// 규칙(관우T): 아침 8시를 넘겨 출석하면 넘긴 만큼 30초당 운동 1개.
// 세 값 다 원장 화면에서 바꾼다 — 수업 시각이 바뀌어도 코드를 안 고치게.
//   late_base(HH:MM) · late_unit_sec(초) · late_cap(개, 0이면 무제한)
// ⚠️ 올림이다. 8시 00분 01초에 눌러도 1개 — "1초라도 늦으면 지각"이 관우T 규칙에 맞다.
//    내림으로 바꾸려면 아래 Math.ceil 한 곳만 Math.floor 로.
// ★ 확정(2026-08-19, 관우T): "상한 안두고 올림이 맞아"
//   - 상한 없음: 1시간 지각이면 운동 120개가 그대로 나온다. 숫자가 커지는 것을 감수하고
//     "늦은 만큼 그대로"를 택했다. 기각안 = 40개쯤에서 멈추게 하는 상한.
//   - 올림 유지: 8:00:29에 눌러도 1개. 기각안 = 내림(8:00:29까지 0개).
//   두 항목 다 관우T가 답을 준 건이니 다시 제안하지 말 것. 바꾸실 때는 원장 화면 ①에서.
const LATE_BASE_DEFAULT = '08:00';
const LATE_UNIT_DEFAULT = 30;

async function lateRule(env) {
  const b = String((await getCfg(env, 'late_base')) || '').trim();
  const u = Number(await getCfg(env, 'late_unit_sec'));
  const c = Number(await getCfg(env, 'late_cap'));
  return {
    base: /^([01]\d|2[0-3]):[0-5]\d$/.test(b) ? b : LATE_BASE_DEFAULT,
    unitSec: Number.isFinite(u) && u > 0 ? Math.floor(u) : LATE_UNIT_DEFAULT,
    cap: Number.isFinite(c) && c > 0 ? Math.floor(c) : 0,
  };
}

// UTC ISO → 그날 KST 00:00 부터 몇 초인가. 못 읽으면 -1.
function secOfDayKST(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return -1;
  const k = new Date(t + 9 * 3600 * 1000);
  return k.getUTCHours() * 3600 + k.getUTCMinutes() * 60 + k.getUTCSeconds();
}
// 45 → "45초" · 90 → "1분 30초" · 3600 → "1시간" · 3660 → "1시간 1분"
// (시간 단위를 안 쓰면 한 시간 늦었을 때 "959분 59초" 같은 글자가 나온다)
function lateText(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return m ? h + '시간 ' + m + '분' : h + '시간';
  if (m) return s ? m + '분 ' + s + '초' : m + '분';
  return s + '초';
}
// checkin 한 줄 → { late, lateSec, lateText, penalty, capped }
function lateOf(row, rule) {
  const none = { late: false, lateSec: 0, lateText: '', penalty: 0, capped: false };
  if (!row || !row.ts) return none;
  const sec = secOfDayKST(row.ts);
  if (sec < 0) return none;
  const p = String(rule.base).split(':');
  const baseSec = Number(p[0]) * 3600 + Number(p[1]) * 60;
  const over = sec - baseSec;
  if (over <= 0) return none;
  let n = Math.ceil(over / rule.unitSec);
  let capped = false;
  if (rule.cap > 0 && n > rule.cap) { n = rule.cap; capped = true; }
  return { late: true, lateSec: over, lateText: lateText(over), penalty: n, capped };
}

// ─────────────────────── 🔔 알림 (2026-08-20 관우T 지시) ───────────────────────
// 원문 그대로: "푸쉬 알람달아줘 출석버튼 누르면 나랑 부모님한테 알람가게, 그리고 식사 등록하면
//   나랑 부모님한테 알람가게 / 식사 등록 안하거나 출석 안누르면 지환이한테 가고 식사등록하라고 가고
//   그거는 나랑 부모님은 빼고"
//
//   ┌───────────────────────┬────────┬────────┬──────────┐
//   │ 언제                  │ 관우T  │ 학부모 │ 학생본인 │
//   ├───────────────────────┼────────┼────────┼──────────┤
//   │ ① 출석 버튼을 눌렀다  │   O    │   O    │    X     │  ← 본인이 방금 한 일이라 뺀다
//   │ ② 식사·운동을 기록했다│   O    │   O    │    X     │
//   │ ③ 아직 안 했다(독촉)  │   X    │   X    │    O     │  ← 관우T 명시: "나랑 부모님은 빼고"
//   └───────────────────────┴────────┴────────┴──────────┘
//
// ⚠️ 푸시의 수신자 id 는 **하이픈형 휴대폰 번호**(010-1234-5678)다. 포털이 구독을 저장할 때 쓴 형식과
//    같아야 토큰이 조회된다 — 그래서 어디서든 _auth.normalizePhone 을 거쳐서만 넘긴다.
//    (attendance.js:106 · notifications.js:194 와 같은 이유. 숫자만 넘기면 조용히 0대 발송이 된다.)
// ⚠️ ③이 학부모에게 샐 수 있는 경로는 딱 하나 — students 행의 학생 번호와 학부모 번호가 같은 경우다.
//    그때는 보내지 않는다(아래 remindTargets). 학생 번호가 비어 있어도 마찬가지로 안 보낸다.
//    ✋ 기각한 안: 학생 번호가 없으면 학부모 번호로라도 보내기 — ③의 수신자 규칙을 정면으로 어긴다.
// ⚠️ 실패해도 절대 throw 하지 않는다. 알림이 안 갔다고 출석·기록 저장이 실패하면 안 된다.
const ADMIN_PUSH_USERS = ['__admin__'];          // 관우T 원장 앱이 구독하는 가상 채널(다른 기능들과 동일)

// 대상 학생의 수신 번호. 둘 다 하이픈형으로 정규화해서 돌려준다(없으면 '').
async function pushPhonesOf(env, tid) {
  let st = null;
  try { st = await getStudentById(env, tid); } catch (_) {}
  if (!st) return { name: '', student: '', parent: '' };
  return {
    name: st.name || '',
    student: normalizePhone(st.studentPhone) || '',
    parent: normalizePhone(st.parentPhone) || '',
  };
}

// ①② "했다" 알림 — 관우T + 학부모. 학생 본인에게는 안 간다.
//   관우T는 원장 화면(/admin-lifelog)으로, 학부모는 학생 화면(/lifelog)으로 보낸다 → 호출을 둘로 나눈다.
//   밤(KST 23~7) 무음은 **학부모에게만** 적용한다(학원 전체 공통 규칙). 관우T는 밤에도 받는다.
async function notifyDone(env, tid, ev) {
  const who = await pushPhonesOf(env, tid);
  // 알림함(인박스)에도 한 줄. audience:'parent' → 학부모 앱에만 뜨고 학생 앱에는 안 뜬다.
  try {
    await createNotification(env, {
      studentId: tid, type: ev.type, title: ev.title, body: ev.body,
      url: '/lifelog', dedupKey: ev.dedupKey, audience: 'parent',
    });
  } catch (_) { /* best-effort */ }
  if (who.parent) {
    try {
      await sendPushToUsers(env, [who.parent], {
        title: ev.title, body: ev.body, url: '/lifelog', tag: ev.tag,
      }, { nightSilent: [who.parent], kind: ev.type });
    } catch (_) { /* best-effort */ }
  }
  try {
    await sendPushToUsers(env, ADMIN_PUSH_USERS, {
      title: ev.title, body: ev.body, url: '/admin-lifelog', tag: ev.tag,
    }, { kind: ev.type });
  } catch (_) { /* best-effort */ }
  return who;
}

// ③ 독촉이 나가도 되는가 + 받을 번호. 규칙 위반 가능성이 있으면 빈 값을 돌려 아예 안 보내게 한다.
function remindTargets(who) {
  if (!who || !who.student) return { to: '', reason: '학생 휴대폰이 등록돼 있지 않다' };
  if (who.parent && who.student === who.parent) {
    return { to: '', reason: '학생 번호와 학부모 번호가 같다 — 보내면 학부모 폰에도 뜬다' };
  }
  return { to: who.student, reason: '' };
}

// ── 독촉 시각 설정 (원장 화면에서 바꾼다 — 시간이 바뀌어도 코드를 안 고치게) ──
//   관우T가 말한 대상은 **출석과 식사**뿐이다. 간식·운동은 독촉하지 않는다.
//   ✋ 간식을 뺀 이유: 매일 먹는 것이 아니어서 "안 했다"가 성립하지 않는다.
//   ✋ 운동을 뺀 이유: 지시에 없다. 넣으려면 아래 REMIND_PLAN 에 한 줄 + 원장 화면 입력칸 하나.
const REMIND_PLAN = [
  { code: 'checkin',   label: '출석 체크', cfgKey: 'remind_checkin',   def: '08:30' },
  { code: 'meal:아침', label: '아침 기록', cfgKey: 'remind_breakfast', def: '09:30' },
  { code: 'meal:점심', label: '점심 기록', cfgKey: 'remind_lunch',     def: '14:00' },
  { code: 'meal:저녁', label: '저녁 기록', cfgKey: 'remind_dinner',    def: '20:30' },
];
const REMIND_STATE_KEY = 'lifelog/_reminder-state.json';   // lifelog/ 프리픽스 → 원복(purge)에 같이 지워진다
const REMIND_MAX_TRIES = 3;                                 // 한 대도 도착 안 하면 5분 뒤 재시도, 3회까지

function hhmmToMin(s) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s || '').trim());
  return m ? (Number(m[1]) * 60 + Number(m[2])) : null;
}
function remindSetting(cfg) {
  const out = { on: String(cfg.remind_on || '') !== '0', times: {} };
  for (const p of REMIND_PLAN) {
    const v = hhmmToMin(cfg[p.cfgKey]);
    out.times[p.code] = v === null ? hhmmToMin(p.def) : v;
  }
  return out;
}
// 화면에 돌려줄 모양 { on, checkin:'08:30', breakfast:'09:30', ... }
function remindRuleView(cfg) {
  const s = remindSetting(cfg);
  const hm = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  const out = { on: s.on };
  for (const p of REMIND_PLAN) out[p.cfgKey.replace('remind_', '')] = hm(s.times[p.code]);
  return out;
}
async function loadCfgAll(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM lifelog_config').all();
  const cfg = {};
  for (const r of (results || [])) cfg[r.key] = r.value;
  return cfg;
}

// ─────────────────────────── ZIP (무압축 store) ───────────────────────────
// 왜 무압축인가: 사진(JPEG)은 이미 압축돼 있어 deflate 이득이 거의 없고,
// Workers 에 zip 라이브러리가 없다. xlsx 도 결국 zip 이라 같은 함수를 두 번 쓴다.
let _crcTable = null;
function crcTable() {
  if (_crcTable) return _crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  _crcTable = t;
  return t;
}
function crc32(bytes) {
  const t = crcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosDateTime(d) {
  const y = Math.max(1980, d.getUTCFullYear());
  const date = (((y - 1980) & 0x7f) << 9) | (((d.getUTCMonth() + 1) & 0xf) << 5) | (d.getUTCDate() & 0x1f);
  const time = ((d.getUTCHours() & 0x1f) << 11) | ((d.getUTCMinutes() & 0x3f) << 5) | ((d.getUTCSeconds() >> 1) & 0x1f);
  return { date, time };
}
// files: [{ name: string, data: Uint8Array }] → Uint8Array (zip)
function zipStore(files) {
  const enc = new TextEncoder();
  const { date: dosDate, time: dosTime } = dosDateTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const lh = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);        // version needed
    dv.setUint16(6, 0x0800, true);    // UTF-8 파일명
    dv.setUint16(8, 0, true);         // method = stored
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    parts.push(lh, data);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    central.push(ch);

    offset += lh.length + data.length;
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  let total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

// ─────────────────────────── 최소 xlsx ───────────────────────────
function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // 엑셀이 못 읽는 제어문자 제거 (탭·개행은 살림)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}
function colLetter(i) { // 0 → A
  let s = '';
  let n = i;
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
  return s;
}
// rows: 2차원 배열(첫 줄 헤더). 숫자는 숫자셀, 나머지는 inlineStr.
function buildXlsx(rows, widths) {
  const enc = new TextEncoder();
  const sheetRows = rows.map((row, ri) => {
    const cells = row.map((val, ci) => {
      const ref = colLetter(ci) + (ri + 1);
      if (typeof val === 'number' && Number.isFinite(val)) {
        return '<c r="' + ref + '"><v>' + val + '</v></c>';
      }
      const s = xmlEsc(val);
      if (!s) return '<c r="' + ref + '"/>';
      return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + s + '</t></is></c>';
    }).join('');
    return '<row r="' + (ri + 1) + '">' + cells + '</row>';
  }).join('');

  const cols = (widths || []).map((w, i) =>
    '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('');

  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    (cols ? '<cols>' + cols + '</cols>' : '') +
    '<sheetData>' + sheetRows + '</sheetData></worksheet>';

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';

  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="생활기록" sheetId="1" r:id="rId1"/></sheets></workbook>';

  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: 'xl/workbook.xml', data: enc.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheet) },
  ]);
}

// ─────────────────────────── 공통 ───────────────────────────
// 🔒 이중 잠금 — 열람 범위는 "서지환 + 관우T"로 못 박혀 있다(조교 제외).
//   미들웨어가 조교(ast_) 세션도 Bearer ADMIN_PASSWORD 로 번역해 보내므로,
//   토큰만 보면 조교가 원장으로 통과한다. audit-log.js 와 같은 방식으로 여기서 한 번 더 막는다.
//   (_middleware.js 의 STAFF_GET_BLOCK 에도 '/api/lifelog' 를 넣었다 — 둘 다 있어야 한다.)
function isAdminReq(env, request) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) return false;
  const role = request.headers.get('X-Kw-Actor-Role') || '';   // 미들웨어가 붙인 값(외부 주입은 세척됨)
  const staffPhone = request.headers.get('X-Staff-Phone') || '';
  if (role === 'staff' || staffPhone) return false;
  return true;
}
// 기기 비밀값은 쿼리스트링에 실으면 접속로그(path)에 남는다 → 헤더로만 받는다.
function deviceSecretOf(request) {
  return (request.headers.get('x-kw-device') || '').trim().slice(0, 80);
}
async function findDevice(env, secret) {
  if (!secret) return null;
  return await env.DB.prepare('SELECT * FROM lifelog_devices WHERE secret=? AND active=1').bind(secret).first();
}
// 👀 이 계정이 「학부모」인가. 2026-08-19부터 **차단 신호가 아니라 읽기전용 신호**다.
//   - 학부모: 보기 O / 쓰기 X   - 학생 본인: 보기 O / 쓰기 O   - 원장: 전부 O
//   ⚠️ students 행에 학생 전화번호가 없으면 학생·학부모가 같은 번호라 구분할 방법이 없다.
//      그때는 false(=학생 본인)로 본다. 막는 쪽으로 기울이면 **학생 본인이 못 들어온다**.
//      대상 학생은 학생 번호와 보호자 번호가 서로 다르게 등록돼 있어 구분된다(2026-08-19 실측).
function isParentView(access) {
  const sp = String((access.student && access.student.studentPhone) || '').trim();
  if (!sp) return false;
  return String(access.phone || '') !== sp;
}
// 대상 학생 본인인가 — 아니면 그대로 돌려줄 응답, 맞으면 null
function studentGate(access, tid) {
  const s = access.student || {};
  if (!tid || String(tid) !== String(s.id)) return jsonErr('사용할 수 없는 기능입니다.', 403);
  if (isParentView(access)) return jsonErr('학생 본인 계정에서만 쓸 수 있어요.', 403);
  return null;
}
function rowToEntry(r) {
  return {
    id: r.id, date: r.date, kind: r.kind, slot: r.slot,
    content: r.content || '', photos: parseKeys(r), photoCount: Number(r.photo_count) || 0,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
// from/to 기본값: 이번 달 1일 ~ 오늘
function rangeOf(url) {
  const t = todayKST();
  let from = (url.searchParams.get('from') || '').trim();
  let to = (url.searchParams.get('to') || '').trim();
  if (!isYmd(from)) from = t.slice(0, 8) + '01';
  if (!isYmd(to)) to = t;
  if (from > to) { const tmp = from; from = to; to = tmp; }
  return { from, to };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env.DB) return jsonErr('DB가 연결되지 않았습니다.', 500);

  try { await ensureTable(env); }
  catch (e) { return jsonErr('생활기록 DB 초기화에 실패했습니다.', 500); }

  const isAdmin = isAdminReq(env, request);

  try {
    // ═════════════════════════════ GET ═════════════════════════════
    if (request.method === 'GET') {
      // ── 사진 스트림 ──
      if (url.searchParams.get('photo') === '1') {
        const key = url.searchParams.get('key') || '';
        const meta = parseLifeKey(key);
        if (!meta) return jsonErr('잘못된 사진 키입니다.', 400);
        if (!isAdmin) {
          const access = await requireStudentAccess(env, request);
          if (!access.ok) return access.response;
          // 학부모도 자녀 사진은 본다(2026-08-19). 남의 학생 사진은 여전히 못 본다.
          if (String(meta.studentId) !== String(access.student.id)) {
            return jsonErr('본인이 올린 것만 볼 수 있어요.', 403);
          }
        }
        if (!env.BUCKET) return jsonErr('저장소가 연결되지 않았습니다.', 500);
        const object = await env.BUCKET.get(key);
        if (!object) return jsonErr('사진을 찾을 수 없어요.', 404);
        const fileName = meta.file || 'photo.jpg';
        const cleanName = fileName.replace(/^\d{10,}_[a-z0-9]{1,8}_/, '') || fileName;
        const contentType = (object.httpMetadata && object.httpMetadata.contentType) || 'image/jpeg';
        return new Response(object.body, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(cleanName),
            'Cache-Control': 'private, max-age=3600',
          },
        });
      }

      // ── 원장 ──
      if (url.searchParams.get('admin') === '1') {
        if (!isAdmin) return jsonErr('관리자만 볼 수 있습니다.', 403);
        const tid = await targetId(env);

        // 내보내기 (엑셀 + 사진 ZIP)
        if (url.searchParams.get('export') === '1') {
          if (!tid) return jsonErr('대상 학생이 지정돼 있지 않습니다.', 400);
          return await buildExport(env, url, tid);
        }

        // 기간 기록
        if (url.searchParams.get('entries') === '1') {
          if (!tid) return jsonOk({ ok: true, enabled: false, entries: [], checkins: [] });
          const { from, to } = rangeOf(url);
          const { results: er } = await env.DB.prepare(
            'SELECT * FROM lifelog_entries WHERE student_id=? AND date>=? AND date<=? ORDER BY date DESC, kind, slot'
          ).bind(tid, from, to).all();
          const { results: cr } = await env.DB.prepare(
            'SELECT * FROM lifelog_checkin WHERE student_id=? AND date>=? AND date<=? ORDER BY date DESC'
          ).bind(tid, from, to).all();
          const rule = await lateRule(env);
          return jsonOk({
            ok: true, enabled: true, from, to, lateRule: rule,
            entries: (er || []).map(rowToEntry),
            checkins: (cr || []).map(r => Object.assign({
              date: r.date, ts: r.ts, time: hmKST(r.ts),
              device: r.device_label || '', model: r.ua_model || '', source: r.source || 'device',
            }, lateOf(r, rule))),
          });
        }

        // 기본: 설정 + 기기 목록 + 최근 요약
        const student = tid ? await getStudentById(env, tid) : null;
        const { results: devs } = await env.DB.prepare(
          'SELECT id, label, ua_model, enroll_code, code_expires_at, enrolled_at, last_used_at, active, created_at ' +
          'FROM lifelog_devices ORDER BY id DESC'
        ).all();
        let counts = { entries: 0, photos: 0, checkins: 0, firstDate: null, lastDate: null };
        if (tid) {
          const c1 = await env.DB.prepare(
            'SELECT COUNT(*) AS n, COALESCE(SUM(photo_count),0) AS p, MIN(date) AS a, MAX(date) AS b FROM lifelog_entries WHERE student_id=?'
          ).bind(tid).first();
          const c2 = await env.DB.prepare('SELECT COUNT(*) AS n FROM lifelog_checkin WHERE student_id=?').bind(tid).first();
          counts = {
            entries: Number(c1 && c1.n) || 0, photos: Number(c1 && c1.p) || 0,
            checkins: Number(c2 && c2.n) || 0,
            firstDate: (c1 && c1.a) || null, lastDate: (c1 && c1.b) || null,
          };
        }
        return jsonOk({
          ok: true,
          enabled: !!tid,
          target: student ? { id: student.id, name: student.name, className: student.className || student.class_name || '', academy: student.academy || '' } : null,
          targetId: tid,
          devices: (devs || []).map(d => ({
            id: d.id, label: d.label || '', model: d.ua_model || '',
            code: d.enrolled_at ? '' : (d.enroll_code || ''),
            codeExpiresAt: d.code_expires_at || '',
            enrolledAt: d.enrolled_at || '', lastUsedAt: d.last_used_at || '',
            active: d.active === 1, createdAt: d.created_at || '',
          })),
          counts,
          lateRule: await lateRule(env),
          remindRule: remindRuleView(await loadCfgAll(env)),   // 🔔 독촉 알림 설정(켬/끔 · 항목별 예정 시각)
          today: todayKST(),
        });
      }

      // ── 학생 ──
      const access = await requireStudentAccess(env, request);
      if (!access.ok) return access.response;
      const student = access.student;
      const tid = await targetId(env);
      const parentView = isParentView(access);
      // 볼 수 있는 사람 = 대상 학생 본인 + 그 학부모 (2026-08-19 관우T 지시로 학부모 추가)
      const canView = !!tid && String(tid) === String(student.id);
      const canEdit = canView && !parentView;   // 쓰기는 여전히 학생 본인만

      // 포털 버튼 노출용 초경량 응답 — 학부모 계정에도 버튼이 뜬다(예전엔 안 떴다)
      if (url.searchParams.get('ping') === '1') {
        return jsonOk({ ok: true, enabled: canView });
      }
      if (!canView) return jsonErr('사용할 수 없는 기능입니다.', 403);

      const { from, to } = rangeOf(url);
      const { results: er } = await env.DB.prepare(
        'SELECT * FROM lifelog_entries WHERE student_id=? AND date>=? AND date<=? ORDER BY date DESC, kind, slot'
      ).bind(student.id, from, to).all();
      const { results: cr } = await env.DB.prepare(
        'SELECT date, ts, device_label, source FROM lifelog_checkin WHERE student_id=? AND date>=? AND date<=? ORDER BY date DESC'
      ).bind(student.id, from, to).all();

      // 이 기기가 학원 기기인가 (버튼 노출 판정)
      const secret = deviceSecretOf(request);
      const dev = await findDevice(env, secret);
      const ua = request.headers.get('user-agent') || '';
      const model = deviceModelOf(ua);
      const deviceOk = !!(dev && dev.enrolled_at && (!dev.ua_model || !model || dev.ua_model === model));

      const today = todayKST();
      const todayCheckin = (cr || []).find(r => r.date === today) || null;
      const rule = await lateRule(env);

      return jsonOk({
        ok: true, enabled: true, student: { id: student.id, name: student.name },
        // 화면이 이 두 값으로 「보기 전용」을 판단한다. canEdit=false면 저장·삭제·출석 UI를 아예 안 그린다.
        // (화면만 숨기는 게 아니라 서버도 studentGate 로 막는다 — 화면 숨김은 안내용이다.)
        viewer: parentView ? 'parent' : 'student', canEdit,
        from, to, today, todayDow: dowKo(today),
        mealSlots: MEAL_SLOTS, workoutSlot: WORKOUT_SLOT,
        lateRule: rule,
        entries: (er || []).map(rowToEntry),
        checkins: (cr || []).map(r => Object.assign(
          { date: r.date, time: hmKST(r.ts), device: r.device_label || '', source: r.source || 'device' },
          lateOf(r, rule)
        )),
        checkedInToday: !!todayCheckin,
        checkedInAt: todayCheckin ? hmKST(todayCheckin.ts) : '',
        todayLate: lateOf(todayCheckin, rule),
        device: { ok: deviceOk, label: (dev && dev.label) || '', model },
      });
    }

    // ═════════════════════════════ POST ═════════════════════════════
    if (request.method === 'POST') {
      const action = (url.searchParams.get('action') || '').trim();

      // ── 원장 액션 ──
      if (url.searchParams.get('admin') === '1') {
        if (!isAdmin) return jsonErr('관리자만 사용할 수 있습니다.', 403);
        let body = {};
        try { body = await request.json(); } catch (_) {}

        if (action === 'set_target') {
          const sid = Number(body.student_id);
          if (!Number.isFinite(sid) || sid <= 0) return jsonErr('학생을 선택해 주세요.', 400);
          const st = await getStudentById(env, sid);
          if (!st) return jsonErr('그 학생을 찾을 수 없습니다.', 404);
          const before = await targetId(env);
          await setCfg(env, 'target_student_id', String(sid));
          await logAudit(env, request, {
            action: 'lifelog.target.set',
            ...actorOf(request, env),
            target: 'student/' + sid, targetName: st.name || '',
            summary: '생활기록 대상 학생을 [' + (st.name || sid) + ']로 지정',
            detail: { 전: before || null, 후: sid },
          });
          return jsonOk({ ok: true, targetId: sid, name: st.name || '' });
        }

        if (action === 'clear_target') {
          const before = await targetId(env);
          const st = before ? await getStudentById(env, before) : null;
          await setCfg(env, 'target_student_id', '');
          await logAudit(env, request, {
            action: 'lifelog.target.clear',
            ...actorOf(request, env),
            target: before ? ('student/' + before) : 'lifelog',
            targetName: (st && st.name) || '',
            summary: '생활기록 대상 해제 — 학생 화면에서 기능이 사라짐 (데이터는 남아 있음)',
            detail: { 전: before || null, 후: null },
          });
          return jsonOk({ ok: true, targetId: 0 });
        }

        if (action === 'new_code') {
          const label = String(body.label || '').trim().slice(0, 40) || '학원 기기';
          // 6자리 숫자. 사람이 학원 폰에 손으로 치는 값이라 짧게 — 유효 30분 + 1회용이라 충분.
          const code = String(Math.floor(100000 + Math.random() * 900000));
          const exp = new Date(Date.now() + CODE_TTL_MIN * 60 * 1000).toISOString();
          const r = await env.DB.prepare(
            'INSERT INTO lifelog_devices (secret, label, enroll_code, code_expires_at, active, created_at) VALUES (?,?,?,?,1,?)'
          ).bind('', label, code, exp, nowIso()).run();
          await logAudit(env, request, {
            action: 'lifelog.device.code',
            ...actorOf(request, env),
            target: 'lifelog-device', targetName: label,
            summary: '생활기록 기기 등록코드 발급 [' + label + '] (' + CODE_TTL_MIN + '분 유효)',
            detail: { 라벨: label, 만료: exp },
          });
          return jsonOk({ ok: true, id: (r.meta && r.meta.last_row_id) || null, code, label, expiresAt: exp, ttlMin: CODE_TTL_MIN });
        }

        if (action === 'revoke_device') {
          const id = Number(body.id);
          if (!Number.isFinite(id)) return jsonErr('기기를 선택해 주세요.', 400);
          const d = await env.DB.prepare('SELECT * FROM lifelog_devices WHERE id=?').bind(id).first();
          if (!d) return jsonErr('그 기기를 찾을 수 없습니다.', 404);
          await env.DB.prepare('DELETE FROM lifelog_devices WHERE id=?').bind(id).run();
          await logAudit(env, request, {
            action: 'lifelog.device.revoke',
            ...actorOf(request, env),
            target: 'lifelog-device/' + id, targetName: d.label || '',
            summary: '생활기록 등록기기 해제 [' + (d.label || id) + ' · ' + (d.ua_model || '미등록') + ']',
            detail: { 라벨: d.label || '', 모델: d.ua_model || '', 등록시각: d.enrolled_at || '' },
          });
          return jsonOk({ ok: true });
        }

        // ▼▼▼ LIFELOG 지각벌칙 — 규칙 저장 (2026-08-19) ▼▼▼
        if (action === 'set_late') {
          const b = String(body.base || '').trim();
          const u = Number(body.unitSec);
          const c = Number(body.cap);
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b)) return jsonErr('기준 시각을 08:00 처럼 적어 주세요.', 400);
          if (!Number.isFinite(u) || u < 1 || u > 3600) return jsonErr('단위는 1~3600초 사이로 적어 주세요.', 400);
          if (!Number.isFinite(c) || c < 0 || c > 9999) return jsonErr('상한은 0~9999 사이로 적어 주세요 (0이면 상한 없음).', 400);
          const before = await lateRule(env);
          await setCfg(env, 'late_base', b);
          await setCfg(env, 'late_unit_sec', String(Math.floor(u)));
          await setCfg(env, 'late_cap', String(Math.floor(c)));
          const after = await lateRule(env);
          await logAudit(env, request, {
            action: 'lifelog.late.set',
            ...actorOf(request, env),
            target: 'lifelog', targetName: '지각 규칙',
            summary: '생활기록 지각 규칙 변경 — 기준 ' + after.base + ' · ' + after.unitSec + '초당 1개 · 상한 ' + (after.cap || '없음'),
            detail: { 전: before, 후: after },
          });
          return jsonOk({ ok: true, lateRule: after });
        }
        // ▲▲▲ LIFELOG 지각벌칙 끝 ▲▲▲

        // 🔔 독촉 알림 설정 — 켬/끔 + 항목별 예정 시각. 학생에게만 가는 알림이라 원장만 만진다.
        if (action === 'set_remind') {
          const before = remindRuleView(await loadCfgAll(env));
          const on = !(body.on === false || body.on === 0 || body.on === '0' || body.on === 'false');
          for (const p of REMIND_PLAN) {
            const key = p.cfgKey.replace('remind_', '');
            if (body[key] === undefined) continue;
            const v = String(body[key] || '').trim();
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
              return jsonErr(p.label + ' 시각을 ' + p.def + ' 처럼 적어 주세요.', 400);
            }
            await setCfg(env, p.cfgKey, v);
          }
          await setCfg(env, 'remind_on', on ? '1' : '0');
          const after = remindRuleView(await loadCfgAll(env));
          await logAudit(env, request, {
            action: 'lifelog.remind.set',
            ...actorOf(request, env),
            target: 'lifelog', targetName: '독촉 알림 규칙',
            summary: '생활기록 독촉 알림 ' + (on ? '켬' : '끔')
              + ' — 출석 ' + after.checkin + ' · 아침 ' + after.breakfast + ' · 점심 ' + after.lunch + ' · 저녁 ' + after.dinner,
            detail: {
              전: before, 후: after,
              수신자: '학생 본인 폰만. 관우T·학부모에게는 가지 않는다.',
              효과: on
                ? '적힌 시각이 지나도 안 한 항목이 있으면 그 항목당 하루 한 번 지환이 폰에 알림이 간다.'
                : '독촉 알림이 완전히 멈춘다. 출석·기록 알림(관우T·학부모)은 그대로 간다.',
            },
          });
          return jsonOk({ ok: true, remindRule: after });
        }

        if (action === 'manual_checkin') {
          const tid = await targetId(env);
          if (!tid) return jsonErr('대상 학생이 지정돼 있지 않습니다.', 400);
          const date = isYmd(body.date) ? body.date : todayKST();
          const on = body.on !== false;
          // 수동 출석은 원장이 나중에 찍는다. 그대로 두면 "지금 시각"이 도착 시각이 돼 지각이 엉뚱하게 커진다.
          // → HH:MM 을 받으면 그 날짜의 그 시각(KST)으로 넣는다. 안 주면 지금 시각.
          const tm = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.time || '')) ? String(body.time) : '';
          const ts = tm ? new Date(Date.parse(date + 'T' + tm + ':00+09:00')).toISOString() : nowIso();
          if (on) {
            const exists = await env.DB.prepare('SELECT id FROM lifelog_checkin WHERE student_id=? AND date=?').bind(tid, date).first();
            if (!exists) {
              await env.DB.prepare(
                'INSERT INTO lifelog_checkin (student_id, date, ts, device_id, device_label, ua, ua_model, ip_hash, source) VALUES (?,?,?,?,?,?,?,?,?)'
              ).bind(tid, date, ts, null, '원장 수동', '', '', '', 'manual').run();
            } else if (tm) {
              await env.DB.prepare('UPDATE lifelog_checkin SET ts=? WHERE student_id=? AND date=?').bind(ts, tid, date).run();
            }
          } else {
            await env.DB.prepare('DELETE FROM lifelog_checkin WHERE student_id=? AND date=?').bind(tid, date).run();
          }
          await logAudit(env, request, {
            action: on ? 'lifelog.checkin.manual' : 'lifelog.checkin.delete',
            ...actorOf(request, env),
            target: 'student/' + tid, targetName: '',
            summary: '생활기록 출석 ' + (on ? '수동 등록' : '취소') + ' — ' + date + (on ? (' ' + hmKST(ts)) : ''),
            detail: { 날짜: date, 켬: on, 시각: on ? hmKST(ts) : '', 시각입력: tm || '(지금)' },
          });
          return jsonOk({ ok: true, date, on, time: on ? hmKST(ts) : '' });
        }

        return jsonErr('알 수 없는 요청입니다.', 400);
      }

      // ── 학원 기기 등록 (코드 입력) ──
      // 학생 토큰이 있어야 한다(학원 폰에 학생 계정으로 로그인해 등록). 코드는 원장 화면에만 뜬다.
      if (action === 'enroll') {
        const access = await requireStudentAccess(env, request);
        if (!access.ok) return access.response;
        if (isParentView(access)) return jsonErr('학생 본인 계정으로 로그인해 등록해 주세요.', 403);
        let body = {};
        try { body = await request.json(); } catch (_) {}
        const code = String(body.code || '').replace(/\D/g, '').slice(0, 6);
        if (code.length !== 6) return jsonErr('6자리 등록코드를 입력해 주세요.', 400);
        const row = await env.DB.prepare(
          'SELECT * FROM lifelog_devices WHERE enroll_code=? AND (enrolled_at IS NULL OR enrolled_at="") AND active=1'
        ).bind(code).first();
        if (!row) return jsonErr('등록코드가 맞지 않거나 이미 사용됐습니다.', 400);
        if (row.code_expires_at && row.code_expires_at < nowIso()) {
          return jsonErr('등록코드가 만료됐습니다. 원장님께 새 코드를 받아 주세요.', 400);
        }
        const ua = request.headers.get('user-agent') || '';
        const model = deviceModelOf(ua);
        const secret = randHex(24);
        await env.DB.prepare(
          'UPDATE lifelog_devices SET secret=?, ua=?, ua_model=?, enrolled_at=?, enroll_code=NULL WHERE id=?'
        ).bind(secret, String(ua).slice(0, 240), model, nowIso(), row.id).run();
        await logAudit(env, request, {
          action: 'lifelog.device.enroll',
          actor: access.phone || ('student:' + access.student.id),
          actorRole: 'student', actorName: access.student.name || '',
          target: 'lifelog-device/' + row.id, targetName: row.label || '',
          summary: '생활기록 학원기기 등록 [' + (row.label || row.id) + '] · ' + (describeDevice(ua) || '기기 불명'),
          detail: { 라벨: row.label || '', 모델: model, UA: String(ua).slice(0, 240) },
        });
        return jsonOk({ ok: true, secret, label: row.label || '', model, device: describeDevice(ua) || '' });
      }

      // ── 출석 ──
      if (action === 'checkin') {
        const access = await requireStudentAccess(env, request);
        if (!access.ok) return access.response;
        const student = access.student;
        const tid = await targetId(env);
        const gate = studentGate(access, tid);
        if (gate) return gate;

        const secret = deviceSecretOf(request);
        const dev = await findDevice(env, secret);
        if (!dev || !dev.enrolled_at) {
          return jsonErr('학원 기기에서만 출석을 누를 수 있어요.', 403);
        }
        const ua = request.headers.get('user-agent') || '';
        const model = deviceModelOf(ua);
        // 비밀값을 베껴 다른 기기에 넣은 경우를 여기서 잡는다.
        if (dev.ua_model && model && dev.ua_model !== model) {
          await logAudit(env, request, {
            action: 'lifelog.checkin.reject',
            actor: access.phone || ('student:' + student.id),
            actorRole: 'student', actorName: student.name || '',
            target: 'lifelog-device/' + dev.id, targetName: dev.label || '',
            summary: '생활기록 출석 거부 — 등록기기와 기종이 다름 (등록 ' + dev.ua_model + ' / 요청 ' + model + ')',
            detail: { 등록모델: dev.ua_model, 요청모델: model, UA: String(ua).slice(0, 240) },
          });
          return jsonErr('학원 기기에서만 출석을 누를 수 있어요.', 403);
        }

        const date = todayKST();
        const exists = await env.DB.prepare('SELECT id, ts FROM lifelog_checkin WHERE student_id=? AND date=?').bind(tid, date).first();
        if (exists) {
          return jsonOk({ ok: true, already: true, date, time: hmKST(exists.ts) });
        }
        const ts = nowIso();
        const ip = clientIp(request);
        let ipHash = '';
        try {
          const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + '|' + date + '|' + (env.ADMIN_PASSWORD || 'kwmath-salt')));
          ipHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
        } catch (_) {}
        await env.DB.prepare(
          'INSERT INTO lifelog_checkin (student_id, date, ts, device_id, device_label, ua, ua_model, ip_hash, source) VALUES (?,?,?,?,?,?,?,?,?)'
        ).bind(tid, date, ts, dev.id, dev.label || '', String(ua).slice(0, 240), model, ipHash, 'device').run();
        await env.DB.prepare('UPDATE lifelog_devices SET last_used_at=? WHERE id=?').bind(ts, dev.id).run();

        await logAudit(env, request, {
          action: 'lifelog.checkin',
          actor: access.phone || ('student:' + student.id),
          actorRole: 'student', actorName: student.name || '',
          target: 'student/' + tid, targetName: student.name || '',
          summary: '[' + (student.name || tid) + '] 생활기록 출석 ' + date + ' ' + hmKST(ts) + ' (' + (dev.label || '학원기기') + ')',
          detail: { 날짜: date, 기기: dev.label || '', 모델: model },
        });

        // 🔔 ① 출석했다 → 관우T + 학부모. (학생 본인은 방금 눌렀으니 뺀다)
        //   지각이면 제목부터 다르게 — 학부모가 배너만 보고도 알 수 있어야 한다.
        //   waitUntil 로 응답 뒤에 보낸다: 버튼을 누른 학생이 푸시 두 통 나가는 동안 기다리지 않게.
        const rule = await lateRule(env);
        const lt = lateOf({ ts }, rule);
        const nm = student.name || '학생';
        const md = date.slice(5).replace('-', '/');
        const ev = {
          type: 'lifelog_checkin',
          title: lt.late ? ('⏰ ' + nm + ' 지각 ' + hmKST(ts)) : ('✅ ' + nm + ' 출석 ' + hmKST(ts)),
          body: md + '(' + dowKo(date) + ') ' + hmKST(ts) + ' 학원 도착'
            + (lt.late ? (' · ' + lt.lateText + ' 지각 → 운동 ' + lt.penalty + '개') : ' · 제시간에 왔어요'),
          dedupKey: 'lifelog-checkin:' + tid + ':' + date,
          tag: 'kwmath-lifelog-checkin',
        };
        const pDone = notifyDone(env, tid, ev).catch(() => {});
        if (context && typeof context.waitUntil === 'function') context.waitUntil(pDone);
        else await pDone;   // waitUntil 이 없으면 응답 후 취소될 수 있다 — 그때는 기다렸다 보낸다

        return jsonOk({ ok: true, date, time: hmKST(ts), device: dev.label || '' });
      }

      // ── 학생: 식사·운동 기록 저장 (multipart) ──
      const access = await requireStudentAccess(env, request);
      if (!access.ok) return access.response;
      const student = access.student;
      const tid = await targetId(env);
      const gate = studentGate(access, tid);
      if (gate) return gate;

      let form;
      try { form = await request.formData(); }
      catch (e) { return jsonErr('업로드 형식이 올바르지 않습니다.', 400); }

      const kind = (form.get('kind') || '').toString().trim();
      if (kind !== 'meal' && kind !== 'workout') return jsonErr('구분(식사/운동)이 올바르지 않습니다.', 400);
      let slot = (form.get('slot') || '').toString().trim();
      if (kind === 'meal') {
        if (!MEAL_SLOTS.includes(slot)) return jsonErr('아침·점심·저녁·간식 중에서 골라 주세요.', 400);
      } else {
        slot = WORKOUT_SLOT;
      }
      let date = (form.get('date') || '').toString().trim();
      if (!isYmd(date)) date = todayKST();
      const content = (form.get('content') || '').toString().slice(0, 1000);

      const files = form.getAll('file').filter(f => f && typeof f !== 'string');
      if (files.length > MAX_PER_UPLOAD) {
        return jsonErr('한 번에 최대 ' + MAX_PER_UPLOAD + '장까지 올릴 수 있어요.', 400);
      }
      if (!files.length && !content.trim()) {
        return jsonErr('내용을 적거나 사진을 한 장 이상 올려 주세요.', 400);
      }

      const existing = await env.DB.prepare(
        'SELECT * FROM lifelog_entries WHERE student_id=? AND date=? AND kind=? AND slot=?'
      ).bind(student.id, date, kind, slot).first();
      const existingKeys = parseKeys(existing);
      if (existingKeys.length + files.length > MAX_PER_ENTRY) {
        return jsonErr('이 칸에 올릴 수 있는 사진 수(' + MAX_PER_ENTRY + '장)를 넘었어요.', 400);
      }

      const newKeys = [];
      if (files.length) {
        if (!env.BUCKET) return jsonErr('저장소가 연결되지 않았습니다.', 500);
        for (const file of files) {
          if (!isImageUpload(file)) return jsonErr('사진(jpg·png·heic 등)만 올릴 수 있어요.', 400);
          if (file.size > MAX_FILE_BYTES) return jsonErr('사진 하나가 너무 큽니다(최대 15MB): ' + (file.name || ''), 400);
          const key = 'lifelog/' + student.id + '/' + date + '/' +
            Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + safeName(file.name);
          await env.BUCKET.put(key, file.stream(), {
            httpMetadata: { contentType: file.type || 'image/jpeg' },
          });
          newKeys.push(key);
        }
      }

      const allKeys = existingKeys.concat(newKeys);
      const ts = nowIso();
      const 첫등록 = !existing;   // 🔔 ②의 발동 조건 — 아래 참고
      if (existing) {
        // 글은 비워 보내면 기존 글을 지우지 않는다(사진만 추가하는 흐름이 잦다).
        const nextContent = content.trim() ? content : (existing.content || '');
        await env.DB.prepare(
          'UPDATE lifelog_entries SET content=?, photo_keys=?, photo_count=?, updated_at=? WHERE id=?'
        ).bind(nextContent, JSON.stringify(allKeys), allKeys.length, ts, existing.id).run();
      } else {
        await env.DB.prepare(
          'INSERT INTO lifelog_entries (student_id, date, kind, slot, content, photo_keys, photo_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
        ).bind(student.id, date, kind, slot, content, JSON.stringify(allKeys), allKeys.length, ts, ts).run();
      }

      // 🔔 ② 식사·운동을 기록했다 → 관우T + 학부모.
      //   ⚠️ **그 칸의 첫 등록 때만** 보낸다. 사진은 한 끼에 여러 번 나눠 올리는 흐름이 잦아서
      //      저장할 때마다 보내면 한 끼에 알림이 대여섯 통 간다(그런 알림은 곧 안 보게 된다).
      //      "점심에 사진을 더 붙였다"는 앱을 열면 보인다 — 알릴 일이 아니다.
      //   ✋ 기각한 안: 저장마다 발송 + 클라이언트에서 묶기 — 묶는 책임이 화면으로 새고, 화면을 새로 고치면 깨진다.
      if (첫등록) {
        const 끼 = kind === 'meal' ? slot : '운동';
        const 사진 = allKeys.length ? (' · 사진 ' + allKeys.length + '장') : '';
        const 글 = (content || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        const ev2 = {
          type: 'lifelog_entry',
          title: (kind === 'meal' ? '🍚 ' : '💪 ') + (student.name || '학생') + ' ' + 끼 + ' 기록',
          body: date.slice(5).replace('-', '/') + '(' + dowKo(date) + ') ' + 끼
            + (글 ? (' — ' + 글) : '') + 사진,
          dedupKey: 'lifelog-entry:' + tid + ':' + date + ':' + kind + ':' + slot,
          tag: 'kwmath-lifelog-entry',
        };
        const p2 = notifyDone(env, tid, ev2).catch(() => {});
        if (context && typeof context.waitUntil === 'function') context.waitUntil(p2);
        else await p2;
      }

      return jsonOk({ ok: true, date, kind, slot, photoCount: allKeys.length, added: newKeys.length });
    }

    // ═════════════════════════════ DELETE ═════════════════════════════
    if (request.method === 'DELETE') {
      // ── 전체 원복 (퇴원) ──
      if (url.searchParams.get('admin') === '1' && url.searchParams.get('purge') === '1') {
        if (!isAdmin) return jsonErr('관리자만 사용할 수 있습니다.', 403);
        if (url.searchParams.get('confirm') !== 'DELETE') {
          return jsonErr('확인 문구가 없습니다. 되돌릴 수 없는 작업입니다.', 400);
        }
        let deletedPhotos = 0;
        if (env.BUCKET) {
          let cursor;
          for (let guard = 0; guard < 100; guard++) {
            const listed = await env.BUCKET.list({ prefix: 'lifelog/', cursor, limit: 500 });
            const keys = (listed.objects || []).map(o => o.key);
            if (keys.length) { await env.BUCKET.delete(keys); deletedPhotos += keys.length; }
            if (!listed.truncated) break;
            cursor = listed.cursor;
          }
        }
        const dropped = [];
        for (const t of ['lifelog_entries', 'lifelog_checkin', 'lifelog_devices', 'lifelog_config']) {
          try { await env.DB.prepare('DROP TABLE IF EXISTS ' + t).run(); dropped.push(t); } catch (_) {}
        }
        _ready = false; // 다음 요청이 다시 만들 수 있게 (기능을 다시 켤 수도 있으므로)
        await logAudit(env, request, {
          action: 'lifelog.purge',
          ...actorOf(request, env),
          target: 'lifelog', targetName: '',
          summary: '생활기록 전체 삭제(원복) — 사진 ' + deletedPhotos + '장 · 테이블 ' + dropped.length + '개',
          detail: { 사진: deletedPhotos, 테이블: dropped },
        });
        return jsonOk({ ok: true, deletedPhotos, dropped });
      }

      const access = await requireStudentAccess(env, request);
      if (!access.ok) return access.response;
      const student = access.student;
      const tid = await targetId(env);
      const gate = studentGate(access, tid);
      if (gate) return gate;

      // 사진 1장
      const key = url.searchParams.get('key') || '';
      if (key) {
        const meta = parseLifeKey(key);
        if (!meta) return jsonErr('잘못된 사진 키입니다.', 400);
        if (String(meta.studentId) !== String(student.id)) return jsonErr('본인 것만 지울 수 있어요.', 403);
        const row = await env.DB.prepare(
          'SELECT * FROM lifelog_entries WHERE student_id=? AND date=? AND photo_keys LIKE ?'
        ).bind(student.id, meta.date, '%' + meta.file + '%').first();
        if (!row) return jsonErr('그 사진이 붙은 기록을 찾을 수 없어요.', 404);
        const keys = parseKeys(row).filter(k => k !== key);
        await env.DB.prepare('UPDATE lifelog_entries SET photo_keys=?, photo_count=?, updated_at=? WHERE id=?')
          .bind(JSON.stringify(keys), keys.length, nowIso(), row.id).run();
        try { if (env.BUCKET) await env.BUCKET.delete(key); } catch (_) {}
        return jsonOk({ ok: true, photoCount: keys.length });
      }

      // 기록 1건
      const entryId = Number(url.searchParams.get('entry'));
      if (Number.isFinite(entryId) && entryId > 0) {
        const row = await env.DB.prepare('SELECT * FROM lifelog_entries WHERE id=?').bind(entryId).first();
        if (!row) return jsonErr('그 기록을 찾을 수 없어요.', 404);
        if (String(row.student_id) !== String(student.id)) return jsonErr('본인 것만 지울 수 있어요.', 403);
        const keys = parseKeys(row);
        if (env.BUCKET && keys.length) { try { await env.BUCKET.delete(keys); } catch (_) {} }
        await env.DB.prepare('DELETE FROM lifelog_entries WHERE id=?').bind(entryId).run();
        return jsonOk({ ok: true, deletedPhotos: keys.length });
      }

      return jsonErr('무엇을 지울지 지정해 주세요.', 400);
    }

    return jsonErr('지원하지 않는 요청 방식입니다.', 405);
  } catch (e) {
    return jsonErr('처리 중 오류가 발생했습니다: ' + (e && e.message ? e.message : e), 500);
  }
}

// ═════════════ 🔔 ③ 안 한 것 독촉 — 학생 본인에게만 (5분 크론) ═════════════
// 발동: /api/notices-flush(기존 5분 크론)가 매 틱 이 함수를 부른다. 새 크론 잡을 만들지 않는다 —
//   그 틱 하나만 살아 있으면 학원의 자동 알림이 전부 도는 구조다(admin-reminders.js 와 같은 이유).
// 게이트:
//   - 대상 학생이 없거나 테이블이 없으면 즉시 종료. ⚠️ **ensureTable 을 부르지 않는다** —
//     원복(purge)한 뒤에도 크론은 계속 도는데, 여기서 CREATE TABLE 을 하면 지운 기능이 되살아난다.
//   - 항목별 예정 시각이 지났고, 그때까지 안 한 것만.
//   - 항목별 하루 1회 (R2 lifelog/_reminder-state.json · 날짜가 바뀌면 자동 리셋).
//   - 한 대도 도착 안 하면 '알림함'으로 찍지 않고 5분 뒤 재시도(최대 3회) — admin-reminders 와 같은 규칙.
//     (예전에 이걸 안 해서, 정작 알림이 필요한 날 한 대도 안 갔는데 조용히 넘어간 적이 있다.)
//   - KST 06:00 이전·23:00 이후에는 아무것도 안 보낸다. 설정 시각을 이상하게 넣어도 새벽에 안 울리게.
// 수신자: **학생 본인 폰 1대뿐**. 관우T·학부모는 명시적으로 제외(관우T 지시) — remindTargets 가 가드.
// 절대 throw 안 함 — 여기서 터지면 공지 발송 크론까지 멈춘다.
export async function runLifelogReminder(env) {
  if (!env || !env.DB) return { ok: true, fired: false, reason: 'no-db' };

  let cfg;
  try { cfg = await loadCfgAll(env); }
  catch (_) { return { ok: true, fired: false, reason: 'no-table' }; }   // 원복됐거나 아직 한 번도 안 켬

  const tid = Number(cfg.target_student_id) || 0;
  if (!tid) return { ok: true, fired: false, reason: 'no-target' };

  const setting = remindSetting(cfg);
  if (!setting.on) return { ok: true, fired: false, reason: 'off' };

  const k = new Date(Date.now() + 9 * 3600 * 1000);
  const dateStr = k.toISOString().slice(0, 10);
  const nowMin = k.getUTCHours() * 60 + k.getUTCMinutes();
  if (k.getUTCHours() < 6 || k.getUTCHours() >= 23) return { ok: true, fired: false, reason: 'night' };

  const due = REMIND_PLAN.filter((p) => nowMin >= setting.times[p.code]);
  if (!due.length) return { ok: true, fired: false, reason: 'nothing due yet' };

  // 하루 단위 멱등 상태 (날짜가 다르면 통째로 새로 시작)
  let state = { date: dateStr, done: {}, tries: {} };
  try {
    const obj = env.BUCKET ? await env.BUCKET.get(REMIND_STATE_KEY) : null;
    if (obj) {
      const j = JSON.parse(await obj.text());
      if (j && j.date === dateStr && j.done && typeof j.done === 'object') {
        state = { date: dateStr, done: j.done, tries: (j.tries && typeof j.tries === 'object') ? j.tries : {} };
      }
    }
  } catch (_) {}

  const pending = due.filter((p) => !state.done[p.code]);
  if (!pending.length) return { ok: true, fired: false, reason: 'all handled today' };

  // 오늘 무엇을 했나 — 출석 1건 + 오늘 기록 전부. 조회가 실패하면 이번 틱은 아무 판단도 하지 않는다
  //   (실패를 '안 했다'로 읽으면 다 해 놓은 날 독촉이 간다).
  let hasCheckin = false;
  const doneSlots = new Set();
  try {
    const c = await env.DB.prepare('SELECT id FROM lifelog_checkin WHERE student_id=? AND date=?').bind(tid, dateStr).first();
    hasCheckin = !!c;
    const { results } = await env.DB.prepare('SELECT kind, slot FROM lifelog_entries WHERE student_id=? AND date=?').bind(tid, dateStr).all();
    for (const r of (results || [])) doneSlots.add(String(r.kind) + ':' + String(r.slot));
  } catch (_) { return { ok: true, fired: false, reason: 'query failed' }; }

  const missing = [];
  let changed = false;
  for (const p of pending) {
    const ok = p.code === 'checkin' ? hasCheckin : doneSlots.has(p.code);
    if (ok) { state.done[p.code] = 'done'; changed = true; }   // 이미 했다 — 오늘 다시 안 본다
    else missing.push(p);
  }

  let sent = 0;
  let 재시도예정 = false;
  let 발송오류 = '';
  let 못보낸이유 = '';
  const who = await pushPhonesOf(env, tid);
  const t = remindTargets(who);

  if (missing.length) {
    const body = missing.map((p) => '· ' + p.label).join('\n') + '\n생활기록에서 지금 등록해 주세요.';
    if (!t.to) {
      // 보낼 곳이 없거나, 보내면 규칙(관우T·학부모 제외)을 어기는 상태. 재시도로 낫지 않으니 오늘은 닫는다.
      못보낸이유 = t.reason;
      for (const p of missing) state.done[p.code] = 'no-target';
      changed = true;
    } else {
      // 알림함에도 남긴다. audience:'student' → 지환이 앱에만 뜨고 학부모 앱에는 안 뜬다.
      for (const p of missing) {
        try {
          await createNotification(env, {
            studentId: tid, type: 'lifelog_remind',
            title: '⏰ ' + p.label + ' 아직 안 했어요',
            body: dateStr.slice(5).replace('-', '/') + ' ' + p.label + ' — 생활기록에서 등록해 주세요.',
            url: '/lifelog', dedupKey: 'lifelog-remind:' + tid + ':' + dateStr + ':' + p.code,
            audience: 'student',
          });
        } catch (_) { /* best-effort */ }
      }
      try {
        const res = await sendPushToUsers(env, [t.to], {
          title: '⏰ 아직 안 한 게 있어요 (' + missing.length + '개)',
          body, url: '/lifelog', tag: 'kwmath-lifelog-remind',
        }, { kind: 'lifelog_remind' });
        // ⚠️ nightSilent 안 씀 — 밤 무음은 학부모 규칙이고 수신자는 학생이다. 시간은 위 06~23시 게이트가 본다.
        sent = (res && res.sent) || 0;
      } catch (e) { 발송오류 = String((e && e.message) || e); }

      for (const p of missing) {
        if (sent > 0) { state.done[p.code] = 'alerted'; delete state.tries[p.code]; }
        else {
          const n = (Number(state.tries[p.code]) || 0) + 1;
          if (n >= REMIND_MAX_TRIES) { state.done[p.code] = 'undelivered'; delete state.tries[p.code]; }
          else { state.tries[p.code] = n; 재시도예정 = true; }
        }
      }
      changed = true;
    }

    // 📓 실제로 쏜 때(또는 못 쏜 때)만 1건. 5분 크론이 하루 288번 부르므로 조용한 틱은 남기지 않는다.
    await logAudit(env, null, {
      action: (발송오류 || 못보낸이유) ? 'lifelog.remind.fail' : 'lifelog.remind.push',
      actor: 'system', actorRole: 'system', actorName: '자동 독촉(생활기록)',
      target: 'student/' + tid, targetName: who.name || '',
      path: 'cron runLifelogReminder() ← /api/notices-flush',
      summary: '생활기록 독촉 ' + ((발송오류 || 못보낸이유) ? '발송 실패' : '발송') + ' — ' + dateStr + ' · '
        + missing.map((p) => p.label).join(', ') + ' · 기기 ' + sent + '대',
      detail: {
        날짜: dateStr,
        안한것: missing.map((p) => p.label),
        받는사람: t.to ? [t.to] : [],
        수신자규칙: '학생 본인만. 관우T·학부모에게는 보내지 않는다(관우T 지시).',
        보낸기기수: sent,
        발송오류: 발송오류 || '없음',
        못보낸이유: 못보낸이유 || '없음',
        알림본문: body,
        효과: sent
          ? '지환이 폰에만 독촉 알림이 갔다. 이 항목들은 오늘 다시 알리지 않는다.'
          : (못보낸이유
            ? '한 통도 보내지 않았다. 학부모 폰에 뜰 위험이 있어 일부러 멈춘 것이다 — students 의 학생 휴대폰을 확인해야 한다.'
            : (재시도예정
              ? '보낼 기기가 없거나 발송이 실패해 한 대도 도착하지 않았다. 5분 뒤 다음 틱에 다시 시도한다.'
              : '한 대도 도착하지 않았고 오늘 재시도 한도(' + REMIND_MAX_TRIES + '회)를 다 썼다 — 학생 폰의 알림 구독이 살아 있는지 확인이 필요하다.')),
        재시도: sent ? '불필요(도달함)' : (재시도예정 ? '예정 — 다음 5분 틱' : '없음'),
        비고: '예정 시각은 원장 화면에서 바꾼다. 간식·운동은 독촉 대상이 아니다.',
      },
    });
  }

  if (changed && env.BUCKET) {
    try {
      await env.BUCKET.put(REMIND_STATE_KEY, JSON.stringify(state), {
        httpMetadata: { contentType: 'application/json' },
      });
    } catch (_) {}
  }

  return {
    ok: true, fired: missing.length > 0 && sent > 0, date: dateStr,
    missing: missing.map((p) => p.code), sent, retry: 재시도예정,
    reason: 못보낸이유 || '',
  };
}

// ─────────────────────────── 내보내기 ───────────────────────────
// 엑셀 1장 + 사진(날짜 폴더)을 ZIP 하나로. 엑셀의 '사진파일' 칸이 ZIP 안 경로와 같아
// 표에서 본 줄의 사진을 바로 찾을 수 있다.
async function buildExport(env, url, tid) {
  const { from, to } = rangeOf(url);
  const student = await getStudentById(env, tid);
  const sname = (student && student.name) || ('student' + tid);

  const { results: er } = await env.DB.prepare(
    'SELECT * FROM lifelog_entries WHERE student_id=? AND date>=? AND date<=? ORDER BY date, kind DESC, slot'
  ).bind(tid, from, to).all();
  const { results: cr } = await env.DB.prepare(
    'SELECT * FROM lifelog_checkin WHERE student_id=? AND date>=? AND date<=? ORDER BY date'
  ).bind(tid, from, to).all();

  const checkinBy = new Map();
  for (const c of (cr || [])) checkinBy.set(c.date, c);

  // 날짜별 사진 이름 충돌 방지용 카운터
  const seq = new Map();
  const photoJobs = [];   // { zipName, key }
  const rule = await lateRule(env);
  const rows = [['날짜', '요일', '출석', '지각', '벌칙운동', '구분', '시간대', '내용', '사진수', '사진파일']];

  const dates = new Set();
  for (const r of (er || [])) dates.add(r.date);
  for (const c of (cr || [])) dates.add(c.date);
  const sortedDates = Array.from(dates).sort();

  for (const d of sortedDates) {
    const ci = checkinBy.get(d);
    const checkinText = ci ? (hmKST(ci.ts) + (ci.source === 'manual' ? ' (수동)' : '')) : '';
    const L = lateOf(ci, rule);
    const lateT = L.late ? L.lateText : (ci ? '정시' : '');
    const penT = L.late ? (L.penalty + '개' + (L.capped ? ' (상한)' : '')) : (ci ? 0 : '');
    const dayEntries = (er || []).filter(r => r.date === d);
    if (!dayEntries.length) {
      rows.push([d, dowKo(d), checkinText, lateT, penT, '출석만', '', '', 0, '']);
      continue;
    }
    let first = true;
    for (const r of dayEntries) {
      const keys = parseKeys(r);
      const names = [];
      for (const k of keys) {
        const n = (seq.get(d + '|' + r.slot) || 0) + 1;
        seq.set(d + '|' + r.slot, n);
        const ext = (k.match(/\.[a-zA-Z0-9]{1,5}$/) || ['.jpg'])[0];
        const zipName = '사진/' + d + '/' + r.slot + '_' + n + ext;
        names.push(zipName);
        photoJobs.push({ zipName, key: k });
      }
      rows.push([
        d, dowKo(d), first ? checkinText : '', first ? lateT : '', first ? penT : '',
        r.kind === 'meal' ? '식사' : '운동',
        r.slot, r.content || '', keys.length, names.join('\n'),
      ]);
      first = false;
    }
  }

  if (photoJobs.length > MAX_ZIP_FILES) {
    return jsonErr('사진이 ' + photoJobs.length + '장이라 한 번에 받기엔 많습니다(최대 ' + MAX_ZIP_FILES + '장). 기간을 나눠서 받아 주세요.', 400);
  }

  const files = [{ name: sname + '_생활기록.xlsx', data: buildXlsx(rows, [12, 6, 12, 10, 10, 8, 10, 60, 8, 40]) }];
  let bytes = files[0].data.length;
  const missing = [];
  if (env.BUCKET) {
    for (const job of photoJobs) {
      const obj = await env.BUCKET.get(job.key);
      if (!obj) { missing.push(job.zipName); continue; }
      const buf = new Uint8Array(await obj.arrayBuffer());
      bytes += buf.length;
      if (bytes > MAX_ZIP_BYTES) {
        return jsonErr('사진 용량이 너무 큽니다(약 ' + Math.round(bytes / 1048576) + 'MB). 기간을 나눠서 받아 주세요.', 400);
      }
      files.push({ name: job.zipName, data: buf });
    }
  }
  if (missing.length) {
    files.push({ name: '없는사진.txt', data: new TextEncoder().encode(missing.join('\n')) });
  }

  const zip = zipStore(files);
  const fname = sname + '_생활기록_' + from + '_' + to + '.zip';
  return new Response(zip, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fname),
      'Cache-Control': 'no-store',
    },
  });
}
