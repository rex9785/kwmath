// /api/admin-reminders  (GET, ?key=CRON_KEY 또는 admin Bearer) + runAttendanceReminder(env) (내부 재사용)
// ───────────────────────────────────────────────────────────
// "출결 미입력 감지" — 오늘 수업이 있는 반(수업 스케줄 설정 기준)인데
// 수업 시작 +30분이 지나도록 그 반 학생 출결이 한 건도 없으면 관우T(__admin__) 폰으로 푸시.
// (2026-07-16 관우T 지시: "출결 미입력 감지 해결해야 해, 이번에도 까먹었어")
//
// 기준 데이터: R2 auth/class-options.json 의 schedules ("학원/반": {days,start,end}) —
//   admin.html 🏫 학원·반 관리에서 🕘 칩으로 설정. 스케줄 미설정 반은 감지 대상 아님.
// 트리거: notices-flush.js(기존 cron-job.org 5분 크론)가 매 틱마다 이 함수를 같이 호출
//   (payroll-reminder와 동일 패턴 — 새 크론 잡 등록 불필요).
// 게이트:
//   - KST 08:00~22:00 에만 (심야 알림 방지)
//   - 반별 하루 1회만 (R2 reminders/state.json { date, alerted:{...} } 멱등 — 날짜 바뀌면 자동 리셋)
//   - 출결이 이미 입력된 반은 그날 재확인하지 않음 (비용 절약)
// 절대 throw 안 함(베스트에포트) — 실패해도 공지 발송 크론을 막지 않는다.
// ───────────────────────────────────────────────────────────
import { sendPushToUsers } from './_push.js';
import { loadClassSchedules } from './class-options.js';
import { listStudents } from './_db.js';

const ADMIN_PUSH_USERS = ['__admin__'];
const STATE_KEY = 'reminders/state.json';

// 한국 시간(UTC+9). 한국은 서머타임 없음 → 고정 +9 안전.
function kstNow() {
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  const y = k.getUTCFullYear(), m = k.getUTCMonth() + 1, d = k.getUTCDate();
  return {
    dateStr: y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'),
    dow: k.getUTCDay(),                      // 0=일 ~ 6=토 (schedules.days와 동일 규약)
    minutes: k.getUTCHours() * 60 + k.getUTCMinutes(),
    hour: k.getUTCHours(),
  };
}

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(v) ? v : null;
}

export async function runAttendanceReminder(env) {
  const now = kstNow();
  if (now.hour < 8 || now.hour >= 22) return { ok: true, fired: false, reason: 'not daytime window' };

  // 오늘 수업 있고, 시작 +30분이 지난 반만 후보
  let schedules = {};
  try { schedules = await loadClassSchedules(env); } catch (_) { return { ok: false, reason: 'schedules load failed' }; }
  const due = [];
  for (const key of Object.keys(schedules)) {
    const sch = schedules[key];
    if (!sch || !Array.isArray(sch.days) || !sch.days.includes(now.dow)) continue;
    const start = parseHHMM(sch.start);
    if (start === null) continue;
    if (now.minutes >= start + 30) due.push(key);
  }
  if (!due.length) return { ok: true, fired: false, reason: 'no class due' };

  // 멱등 state (하루 단위 — 날짜 바뀌면 자동 리셋)
  let state = { date: now.dateStr, alerted: {} };
  try {
    const obj = await env.BUCKET.get(STATE_KEY);
    if (obj) {
      const j = JSON.parse(await obj.text());
      if (j && j.date === now.dateStr && j.alerted && typeof j.alerted === 'object') state = j;
    }
  } catch (_) {}

  const pending = due.filter((k) => !state.alerted[k]);
  if (!pending.length) return { ok: true, fired: false, reason: 'all checked today' };

  let students = [];
  try { students = await listStudents(env); } catch (_) { return { ok: false, reason: 'students load failed' }; }

  const missing = [];
  let changed = false;
  for (const key of pending) {
    const slash = key.indexOf('/');
    const academy = slash >= 0 ? key.slice(0, slash) : key;
    const className = slash >= 0 ? key.slice(slash + 1) : '';
    const roster = students.filter((s) => (s.academy || '') === academy && (s.className || '') === className);
    if (!roster.length) { state.alerted[key] = 'no-students'; changed = true; continue; }
    const ids = roster.map((s) => s.id).filter((v) => v !== undefined && v !== null);
    let cnt = 0;
    try {
      const ph = ids.map(() => '?').join(',');
      const r = await env.DB.prepare(
        'SELECT COUNT(*) AS c FROM attendance WHERE date=? AND student_id IN (' + ph + ')'
      ).bind(now.dateStr, ...ids).first();
      cnt = (r && Number(r.c)) || 0;
    } catch (_) { continue; }   // 조회 실패 반은 다음 틱에 재시도
    if (cnt === 0) { missing.push(key); state.alerted[key] = 'alerted'; }
    else { state.alerted[key] = 'entered'; }   // 이미 입력됨 — 오늘 재확인 안 함
    changed = true;
  }

  let sent = 0;
  if (missing.length) {
    const body = missing.map((k) => '· ' + k.replace('/', ' — ')).join('\n')
      + '\n수업 시작 30분이 지났는데 출결이 입력되지 않았어요.';
    try {
      const res = await sendPushToUsers(env, ADMIN_PUSH_USERS, {
        title: '⏰ 오늘 출결 미입력 (' + missing.length + '개 반)',
        body, url: '/admin', tag: 'kwmath-att-reminder',
      });
      sent = (res && res.sent) || 0;
    } catch (_) {}
  }

  if (changed) {
    try {
      await env.BUCKET.put(STATE_KEY, JSON.stringify(state), {
        httpMetadata: { contentType: 'application/json' },
      });
    } catch (_) {}
  }

  return { ok: true, fired: missing.length > 0, missing, sent, checked: pending.length };
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return Response.json({ ok: false, error: 'GET only' }, { status: 405 });
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const auth = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const authed = (env.CRON_KEY && key && key === env.CRON_KEY) ||
                 (env.ADMIN_PASSWORD && auth === env.ADMIN_PASSWORD);
  if (!authed) return Response.json({ ok: false, error: '인증이 필요합니다.' }, { status: 401 });
  const r = await runAttendanceReminder(env);
  return Response.json(r);
}
