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
// 📓 감사로그(2026-07-31) — "알림이 안 왔다"는 신고에 답할 근거를 남긴다.
//   ⚠️ 이 두 함수는 5분 크론이 하루 288번 부른다. 대부분의 틱은 "수업 없음/이미 확인함"으로 그냥 끝나는데,
//      그것까지 남기면 변경이력이 크론 틱으로 뒤덮인다 → **실제로 알림을 쏜 때(또는 쏘려다 실패한 때)만** 1건.
//      크론이 request 없이 부르므로 actor 는 'system' 으로 명시한다(사람에게 귀속시키면 거짓 기록이 된다).
import { logAudit } from './_auditlog.js';

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
    let 발송오류 = '';
    try {
      const res = await sendPushToUsers(env, ADMIN_PUSH_USERS, {
        title: '⏰ 오늘 출결 미입력 (' + missing.length + '개 반)',
        body, url: '/admin', tag: 'kwmath-att-reminder',
      });
      sent = (res && res.sent) || 0;
    } catch (e) { 발송오류 = String((e && e.message) || e); }

    await logAudit(env, null, {
      action: 발송오류 ? 'reminder.attendance.fail' : 'reminder.attendance.push',
      actor: 'system', actorRole: 'system', actorName: '자동 리마인드(출결 미입력)',
      target: now.dateStr,
      path: 'cron runAttendanceReminder() ← /api/notices-flush',
      summary: '출결 미입력 알림 ' + (발송오류 ? '발송 실패' : '발송') + ' — ' + now.dateStr + ' · '
        + missing.length + '개 반(' + missing.join(', ').slice(0, 120) + ') · 기기 ' + sent + '대',
      detail: {
        날짜: now.dateStr,
        미입력반: missing,
        확인한반수: pending.length,
        받는사람: ADMIN_PUSH_USERS,
        보낸기기수: sent,
        발송오류: 발송오류 || '없음',
        알림본문: body,
        효과: sent
          ? '원장 폰에 "오늘 출결 미입력" 알림이 갔다. 이 반들은 오늘 다시 알리지 않는다(반별 하루 1회).'
          : '보낼 기기가 없거나 발송이 실패해 알림이 실제로 도착하지 않았다. 그래도 "오늘 확인함"으로 표시되어 오늘은 다시 알리지 않는다.',
        비고: '기준은 수업 시작 +30분 · KST 08~22시. 판단 근거는 R2 auth/class-options.json 의 수업 시간표.',
      },
    });
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

// ═══════════ 📝 리포트 미작성 리마인드 ═══════════
// (2026-07-29 · 4관점 점검 1-2 "리포트를 안 쓴 날이 조용히 지나간다")
//
// 왜 "어제" 수업을 보나 — 리포트는 MathOS에서 수업이 다 끝난 뒤 한참 있다가 올라온다.
//   출결처럼 "수업 시작 +30분"에 확인하면 아직 안 올렸을 뿐인 반까지 알림이 가고,
//   그런 알림은 두세 번만 헛나가도 그냥 안 보게 된다. 그래서 하루를 통째로 기다렸다가
//   다음 날 아침에 딱 한 번만 알린다. 빨리 알리는 게 목적이 아니라 "그냥 지나가지 않게" 하는 게 목적이다.
//   (덤: 밤 10시에 끝나는 반은 종료+30분이 심야 차단 구간이라 당일 확인 자체가 불가능하다.)
//
// 출결 게이트 — 어제 그 반 출결이 0건이면 리포트는 아예 묻지 않는다.
//   수업이 없었거나 출결 자체를 빠뜨린 건데, 후자는 위 출결 리마인드가 어제 이미 알렸다. 두 번 울리지 않는다.
//   다만 출결을 다음 날 늦게 채워 넣는 경우가 있어 낮 12시까지는 판정을 미루고 다음 틱에 다시 본다.
//
// 멱등 — R2 reminders/reports-state.json { alerted: { "학원/반|YYYY-MM-DD": ... } }.
//   출결 쪽(하루 단위로 통째 리셋)과 달리 키에 날짜를 박는다. "어제"를 보므로 날짜가 바뀌어도 기억해야 하기 때문.
//   4일 지난 기록은 저장할 때 버려서 파일이 무한히 커지지 않게 한다.
const REPORT_STATE_KEY = 'reminders/reports-state.json';

// KST 기준 n일 전(음수)/후 날짜와 요일. offsetDays=0 이면 오늘.
function kstDay(offsetDays) {
  const k = new Date(Date.now() + 9 * 3600 * 1000 + (offsetDays || 0) * 86400 * 1000);
  return {
    dateStr: k.getUTCFullYear() + '-' + String(k.getUTCMonth() + 1).padStart(2, '0') + '-' + String(k.getUTCDate()).padStart(2, '0'),
    dow: k.getUTCDay(),
  };
}

// D1은 한 쿼리의 바인딩 개수에 한계가 있어 90개씩 끊어 COUNT를 합산한다.
//   (한 반이 90명을 넘을 일은 없지만, 학원 전체를 한 반처럼 쓰는 설정이 생겨도 안 터지게 방어)
async function countChunked(env, sqlHead, list, dateStr) {
  let total = 0;
  for (let i = 0; i < list.length; i += 90) {
    const chunk = list.slice(i, i + 90);
    if (!chunk.length) continue;
    const r = await env.DB.prepare(sqlHead + chunk.map(() => '?').join(',') + ')')
      .bind(dateStr, ...chunk).first();
    total += (r && Number(r.c)) || 0;
  }
  return total;
}

export async function runReportReminder(env) {
  const now = kstNow();
  if (now.hour < 8 || now.hour >= 22) return { ok: true, fired: false, reason: 'not daytime window' };

  const y = kstDay(-1);   // 어제(KST)

  let schedules = {};
  try { schedules = await loadClassSchedules(env); } catch (_) { return { ok: false, reason: 'schedules load failed' }; }
  const due = Object.keys(schedules).filter((key) => {
    const sch = schedules[key];
    return !!(sch && Array.isArray(sch.days) && sch.days.includes(y.dow));
  });
  if (!due.length) return { ok: true, fired: false, reason: 'no class yesterday' };

  let alerted = {};
  try {
    const obj = await env.BUCKET.get(REPORT_STATE_KEY);
    if (obj) {
      const j = JSON.parse(await obj.text());
      if (j && j.alerted && typeof j.alerted === 'object') alerted = j.alerted;
    }
  } catch (_) {}

  const pending = due.filter((k) => !alerted[k + '|' + y.dateStr]);
  if (!pending.length) return { ok: true, fired: false, reason: 'all checked' };

  let students = [];
  try { students = await listStudents(env); } catch (_) { return { ok: false, reason: 'students load failed' }; }

  const missing = [];
  let changed = false;
  for (const key of pending) {
    const slash = key.indexOf('/');
    const academy = slash >= 0 ? key.slice(0, slash) : key;
    const className = slash >= 0 ? key.slice(slash + 1) : '';
    const roster = students.filter((s) => (s.academy || '') === academy && (s.className || '') === className);
    const mark = (v) => { alerted[key + '|' + y.dateStr] = v; changed = true; };
    if (!roster.length) { mark('no-students'); continue; }

    // ① 어제 그 반 수업이 실제로 있었나 (출결 존재 여부)
    const ids = roster.map((s) => s.id).filter((v) => v !== undefined && v !== null);
    let att = 0;
    try {
      att = await countChunked(env, 'SELECT COUNT(*) AS c FROM attendance WHERE date=? AND student_id IN (', ids, y.dateStr);
    } catch (_) { continue; }             // 조회 실패 — 다음 틱에 재시도
    if (!att) { if (now.hour >= 12) mark('no-attendance'); continue; }

    // ② 리포트가 한 건이라도 있나
    //    ⚠️ reports 테이블은 아직 이름 키다(MathOS가 이름+날짜로 올림 — _db.js:277 주석).
    //    동명이인이 다른 반에서 리포트를 받으면 "있다"로 세어 알림을 한 번 덜 보낼 수는 있지만,
    //    없는데 있다고 착각해 잘못된 알림을 보내는 방향은 아니다(조용한 누락 < 잘못된 알림).
    const names = [...new Set(roster.map((s) => s.name).filter(Boolean))];
    if (!names.length) { mark('no-names'); continue; }
    let rep = 0;
    try {
      rep = await countChunked(env, 'SELECT COUNT(*) AS c FROM reports WHERE class_date=? AND student_name IN (', names, y.dateStr);
    } catch (_) { continue; }
    if (rep === 0) { missing.push(key); mark('alerted'); }
    else mark('written');
  }

  let sent = 0;
  if (missing.length) {
    const md = y.dateStr.slice(5).replace('-', '/');
    const body = missing.map((k) => '· ' + k.replace('/', ' — ')).join('\n')
      + '\n어제(' + md + ') 수업 리포트가 아직 없어요.';
    let 발송오류 = '';
    try {
      const res = await sendPushToUsers(env, ADMIN_PUSH_USERS, {
        title: '📝 리포트 미작성 (' + missing.length + '개 반)',
        // ⚠️ 목적지 주의: /admin-report 는 「진단평가 보고서 생성기」(다른 기능)다.
        //    이 알림은 "어제 수업 리포트가 안 올라왔다"는 뜻이므로 리포트 확인 화면으로 보낸다.
        body, url: '/staff-reports', tag: 'kwmath-report-reminder',
      });
      sent = (res && res.sent) || 0;
    } catch (e) { 발송오류 = String((e && e.message) || e); }

    await logAudit(env, null, {
      action: 발송오류 ? 'reminder.report.fail' : 'reminder.report.push',
      actor: 'system', actorRole: 'system', actorName: '자동 리마인드(리포트 미작성)',
      target: y.dateStr,
      path: 'cron runReportReminder() ← /api/notices-flush',
      summary: '리포트 미작성 알림 ' + (발송오류 ? '발송 실패' : '발송') + ' — 어제(' + y.dateStr + ') 수업 '
        + missing.length + '개 반(' + missing.join(', ').slice(0, 120) + ') · 기기 ' + sent + '대',
      detail: {
        대상날짜: y.dateStr + ' (어제 수업분)',
        미작성반: missing,
        확인한반수: pending.length,
        받는사람: ADMIN_PUSH_USERS,
        보낸기기수: sent,
        발송오류: 발송오류 || '없음',
        알림본문: body,
        효과: sent
          ? '원장 폰에 "어제 리포트가 없다" 알림이 갔다. 이 반·이 날짜로는 다시 알리지 않는다.'
          : '보낼 기기가 없거나 발송이 실패해 알림이 실제로 도착하지 않았다. 그래도 "확인함"으로 표시되어 다시 알리지 않는다.',
        비고: '어제 그 반 출결이 0건이면 아예 묻지 않는다(수업이 없었던 것으로 본다). '
          + '리포트 유무는 학생 이름+수업날짜로 세므로 동명이인이 있으면 "있다"로 셀 수 있다.',
      },
    });
  }

  if (changed) {
    const cutoff = kstDay(-4).dateStr;
    for (const k of Object.keys(alerted)) {
      const d = k.slice(k.lastIndexOf('|') + 1);
      if (d < cutoff) delete alerted[k];
    }
    try {
      await env.BUCKET.put(REPORT_STATE_KEY, JSON.stringify({ alerted }), {
        httpMetadata: { contentType: 'application/json' },
      });
    } catch (_) {}
  }

  return { ok: true, fired: missing.length > 0, date: y.dateStr, missing, sent, checked: pending.length };
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return Response.json({ ok: false, error: 'GET only' }, { status: 405 });
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const auth = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const authed = (env.CRON_KEY && key && key === env.CRON_KEY) ||
                 (env.ADMIN_PASSWORD && auth === env.ADMIN_PASSWORD);
  if (!authed) {
    await logAudit(env, request, {
      action: 'reminder.manual.denied',
      summary: '리마인더 수동 실행 인증 실패 — 거부(401)',
      detail: {
        결과: '거부(401). 아무 알림도 발송되지 않았다.',
        사유: '?key=CRON_KEY 도 관리자 Bearer 도 일치하지 않음',
        효과: '없음.',
        비고: '입력된 키·토큰 원문은 기록하지 않는다.',
      },
    });
    return Response.json({ ok: false, error: '인증이 필요합니다.' }, { status: 401 });
  }
  // 수동 점검용 — 출결·리포트 둘 다 돌려 본다. (평소 발동은 notices-flush 5분 크론이 담당)
  //   ?only=attendance / ?only=reports 로 하나만 돌릴 수 있다. 게이트는 각 함수 내부가 전담하므로
  //   여기서 눌러도 조건이 안 맞으면 fired:false 와 그 이유(reason)가 그대로 나온다.
  const only = (url.searchParams.get('only') || '').trim();
  const attendance = only === 'reports' ? { skipped: true } : await runAttendanceReminder(env);
  const reports    = only === 'attendance' ? { skipped: true } : await runReportReminder(env);

  // 📓 사람이 직접 눌러 돌린 경우만 남긴다.
  //    ?key=CRON_KEY 로 들어온 기계 호출까지 남기면(5분 주기라면) 하루 288건이 쌓인다.
  //    실제 발송이 일어났다면 위 두 함수가 이미 각자 1건씩 남겼으므로, 여기는 "누가 눌렀나"만 담는다.
  if (env.ADMIN_PASSWORD && auth === env.ADMIN_PASSWORD) {
    await logAudit(env, request, {
      action: 'reminder.manual.run',
      summary: '리마인더 수동 실행 — 출결: ' + (attendance.skipped ? '건너뜀' : (attendance.fired ? '발송함' : ('발송 안 함(' + (attendance.reason || '') + ')')))
        + ' · 리포트: ' + (reports.skipped ? '건너뜀' : (reports.fired ? '발송함' : ('발송 안 함(' + (reports.reason || '') + ')'))),
      detail: {
        요청범위: only ? ('only=' + only) : '출결·리포트 둘 다',
        출결결과: attendance,
        리포트결과: reports,
        효과: (attendance.fired || reports.fired)
          ? '실제로 알림이 나갔다. 무엇이 나갔는지는 같은 시각의 reminder.attendance.push / reminder.report.push 로그에 있다.'
          : '조건(시간대·수업 유무·이미 확인함)이 안 맞아 아무 알림도 나가지 않았다. 데이터는 바뀌지 않았다.',
        비고: '평소 발동은 /api/notices-flush 5분 크론이 담당한다. 이 로그는 사람이 직접 눌렀을 때만 남는다.',
      },
    });
  }

  return Response.json({ ok: true, attendance, reports });
}
