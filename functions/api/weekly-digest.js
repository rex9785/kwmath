// /api/weekly-digest  (GET, admin Bearer 또는 ?key=CRON_KEY) + runWeeklyDigestReminder(env) (내부 재사용)
// ───────────────────────────────────────────────────────────
// 「주말 한 줄 요약」 — 학생 한 명 한 명의 **이번 주 테스트 숫자**를 자동으로 모아
// 학부모에게 보낼 문장 초안을 만들어 준다. 발송은 하지 않는다(관우T가 화면에서 승인해야 나간다).
//
// 왜 만들었나 (2026-08-07 관우T 지시)
//   "월말에 너를 부르는 건 확정인데 주말에는 어떻게해 내가 편하려면"
//   → 주중엔 아무것도 안 하고, 토요일에 폰 알림 한 번 받고, 표를 훑고, 보내기만 누르면 끝나게.
//   보고서(PDF)는 여전히 월말에 한 번만 나간다. 이건 그 사이를 메우는 **문자 한 줄**이다.
//
// ⚠️ 진도 문구는 넣지 않는다 (관우T 확정: "아냐 개인숫자만하자 다음주진도말고").
//   "다음 주엔 삼각함수 나갑니다" 같은 줄을 넣으면 매주 관우T가 진도를 입력해야 한다 —
//   그 순간 "내가 편하려면"이라는 목적이 깨진다. 그래서 문장은 **그 학생의 숫자만**으로 만든다.
//
// 데이터 출처 = exam_scores 중 퀴즈 자동반영분(일일/주간/월말테스트).
//   퀴즈 빌더에서 「테스트 종류」만 골라 두면 채점과 동시에 여기 쌓인다(_scores.js). 별도 입력 없음.
//   ⚠️ 「테스트 종류」를 안 고른 퀴즈는 성적에 안 들어가므로 이 요약에도 안 잡힌다.
//
// 반 구분 — 시동반/공통수학2는 절대 안 섞는다는 규칙이 여기선 자동으로 지켜진다.
//   모든 숫자가 **그 학생 개인의 것**이라 반 평균·등수를 아예 계산하지 않기 때문이다.
//
// 📅 날짜 경계 주의 — exam_date 는 채점 시각의 **UTC 날짜**다(_scores.js).
//   KST 00:00~09:00 에 응시하면 전날로 기록된다. 학원 테스트가 그 시간대에 있을 일은 없어
//   실무상 문제가 없지만, 주 경계(월요일 새벽)에 본 테스트는 지난주로 잡힐 수 있다.
// ───────────────────────────────────────────────────────────
import { sendPushToUsers } from './_push.js';
import { listStudents } from './_db.js';
import { ensureExamScoresTable, TEST_KINDS } from './_scores.js';
import { staffScopeAcademy } from './_staff.js';
import { logAudit } from './_auditlog.js';

const ADMIN_PUSH_USERS = ['__admin__'];
const STATE_KEY = 'weekly-digest/state.json';

// 🔁 미도달 재시도 — admin-reminders.js §11-10 과 같은 이유.
//   sendPushToUsers 는 보낼 기기가 없어도 throw 하지 않고 { sent: 0 } 을 준다.
//   그때 "이번 주 보냄"으로 찍어 버리면 알림이 한 대도 안 갔는데 그 주가 조용히 넘어간다.
const MAX_PUSH_TRIES = 3;

function ymdUTC(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

// 한국 시간(UTC+9). 한국은 서머타임 없음 → 고정 +9 안전.
function kstNow() {
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  return { at: k, dow: k.getUTCDay(), hour: k.getUTCHours() };   // dow 0=일 … 6=토
}

// KST 기준 '이번 주'(월~일). offsetWeeks=-1 이면 지난주.
//   주를 월요일에 끊는 이유 — 토요일 저녁에 보내는데 일요일 시작이면 그 주가 아직 하루 남는다.
function weekRangeKST(offsetWeeks) {
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  const backToMon = (k.getUTCDay() + 6) % 7;                     // 일요일이면 6일 뒤로
  const monMs = k.getTime() - backToMon * 86400000 + (offsetWeeks || 0) * 7 * 86400000;
  const from = ymdUTC(new Date(monMs));
  const to = ymdUTC(new Date(monMs + 6 * 86400000));
  return { from, to };
}

// '2026-08-03' → '8/3'
function md(s) {
  const p = String(s || '').split('-');
  return p.length === 3 ? (Number(p[1]) + '/' + Number(p[2])) : String(s || '');
}

// 기간 안의 테스트 점수 행 → { studentId: [ {label, type, score, date}, … ] }
async function fetchWeek(env, from, to) {
  const kinds = [...TEST_KINDS];
  const { results } = await env.DB.prepare(
    'SELECT student_id, exam_type, label, raw_score, exam_date FROM exam_scores ' +
    'WHERE exam_type IN (' + kinds.map(() => '?').join(',') + ') ' +
    'AND raw_score IS NOT NULL AND exam_date >= ? AND exam_date <= ? ' +
    'ORDER BY exam_date ASC, id ASC'
  ).bind(...kinds, from, to).all();
  const by = {};
  for (const r of (results || [])) {
    const k = String(r.student_id);
    if (!by[k]) by[k] = [];
    by[k].push({ label: r.label || '', type: r.exam_type || '', score: Number(r.raw_score), date: r.exam_date || '' });
  }
  return by;
}

function avgOf(list) {
  if (!list || !list.length) return null;
  let sum = 0;
  for (const t of list) sum += t.score;
  return Math.round(sum / list.length);
}

// 학부모에게 나갈 문장 — **그 학생의 숫자만**. 진도·다짐·평가 문구 없음.
function bodyOf(n, avg, prevN, prevAvg) {
  let s = '이번 주 테스트 ' + n + '회, 평균 ' + avg + '점입니다.';
  if (prevN > 0) {
    const delta = avg - prevAvg;
    s += ' (지난주 ' + prevAvg + '점 · ' + (delta > 0 ? '+' : '') + delta + '점)';
  }
  return s;
}

// 초안 계산 — 읽기만 한다. 아무것도 저장하지 않고 아무것도 발송하지 않는다.
export async function buildWeeklyDigest(env) {
  await ensureExamScoresTable(env);

  const cur = weekRangeKST(0);
  const prev = weekRangeKST(-1);
  const weekLabel = md(cur.from) + '~' + md(cur.to);

  let students = [];
  try { students = await listStudents(env); } catch (_) { return { ok: false, error: '학생 명단을 불러오지 못했습니다.' }; }

  let curBy = {}, prevBy = {};
  try {
    curBy = await fetchWeek(env, cur.from, cur.to);
    prevBy = await fetchWeek(env, prev.from, prev.to);
  } catch (_) { return { ok: false, error: '테스트 점수를 불러오지 못했습니다.' }; }

  const items = [];       // 보낼 수 있는 학생(이번 주 테스트 1회 이상)
  const noData = [];      // 이번 주 기록이 없는 학생 — 보내지 않지만 몇 명인지는 보여 준다
  for (const s of students) {
    const key = String(s.id);
    const tests = curBy[key] || [];
    const prevTests = prevBy[key] || [];
    const base = {
      studentId: String(s.id), name: s.name || '',
      academy: s.academy || '', className: s.className || '', grade: s.grade || '',
    };
    if (!tests.length) {
      // 시험을 안 본 주에 "0회"라고 보내면 그 문자는 학부모에게 아무 정보도 아니다 — 조용히 뺀다.
      noData.push(Object.assign({}, base, { prevN: prevTests.length }));
      continue;
    }
    const n = tests.length, avg = avgOf(tests);
    const prevN = prevTests.length, prevAvg = avgOf(prevTests);
    items.push(Object.assign({}, base, {
      n, avg, prevN, prevAvg,
      delta: prevN > 0 ? (avg - prevAvg) : null,
      title: '📊 이번 주 테스트 요약 (' + weekLabel + ')',
      body: bodyOf(n, avg, prevN, prevAvg),
      // 화면 검증용 — 이 목록은 **문자에 들어가지 않는다**. 관우T가 숫자가 맞는지 눈으로 보는 용도.
      tests: tests.map((t) => ({ label: t.label, type: t.type, score: t.score, date: t.date })),
    }));
  }

  // 이름순 정렬(반 → 이름) — 화면에서 반별로 뭉쳐 보이게. 숫자는 전부 개인 것이라 반끼리 안 섞인다.
  const collator = (a, b) => (a.className || '').localeCompare(b.className || '') || (a.name || '').localeCompare(b.name || '');
  items.sort(collator);
  noData.sort(collator);

  return {
    ok: true,
    weekLabel, from: cur.from, to: cur.to,
    prevFrom: prev.from, prevTo: prev.to,
    count: items.length, noDataCount: noData.length,
    items, noData,
  };
}

// ═══════════ 📅 토요일 알림 ═══════════
// 발송이 아니라 **관우T 폰에 "초안 준비됨"만** 알린다. 학부모에게 가는 건 관우T가 화면에서 눌러야 나간다.
// 게이트: KST 토요일 · 09~22시 · 주 1회(그 주 월요일 날짜로 멱등).
// 절대 throw 안 함 — 실패해도 5분 크론(공지 발송)을 막지 않는다.
export async function runWeeklyDigestReminder(env) {
  const now = kstNow();
  if (now.dow !== 6) return { ok: true, fired: false, reason: 'not saturday' };
  if (now.hour < 9 || now.hour >= 22) return { ok: true, fired: false, reason: 'not daytime window', h: now.hour };

  const cur = weekRangeKST(0);
  const weekKey = cur.from;            // 그 주 월요일 — 주 단위 멱등 키

  let state = { lastWeek: '', tries: 0 };
  try {
    const obj = await env.BUCKET.get(STATE_KEY);
    if (obj) {
      const j = JSON.parse(await obj.text());
      if (j && typeof j === 'object') state = Object.assign({ lastWeek: '', tries: 0 }, j);
    }
  } catch (_) {}
  if (state.lastWeek === weekKey) return { ok: true, fired: false, reason: 'already sent this week', weekKey };

  let digest = null;
  try { digest = await buildWeeklyDigest(env); } catch (_) { return { ok: false, reason: 'digest build failed' }; }
  if (!digest || !digest.ok) return { ok: false, reason: (digest && digest.error) || 'digest build failed' };
  if (!digest.count) {
    // 이번 주 테스트가 한 건도 없으면 알리지 않는다(방학·휴원 주에 헛알림이 가면 다음부터 안 보게 된다).
    // "보냈다"로도 찍지 않는다 — 주말 늦게 점수가 들어오면 그때 알려야 하므로.
    return { ok: true, fired: false, reason: 'no tests this week', weekKey };
  }

  const body = '이번 주 테스트를 본 학생 ' + digest.count + '명의 문자 초안이 준비됐어요.'
    + (digest.noDataCount ? ('\n(기록 없는 학생 ' + digest.noDataCount + '명은 빠져 있어요.)') : '')
    + '\n관리자 → 「📅 주간 요약」에서 확인하고 보내주세요.';

  let sent = 0, 발송오류 = '';
  try {
    const res = await sendPushToUsers(env, ADMIN_PUSH_USERS, {
      title: '📅 주간 요약 초안 준비됨 (' + digest.weekLabel + ')',
      body, url: '/admin', tag: 'kwmath-weekly-digest',
    });
    sent = (res && res.sent) || 0;
  } catch (e) { 발송오류 = String((e && e.message) || e); }

  // 🔁 도달했을 때만 "이번 주 보냄"으로 닫는다. 0대면 tries만 올려 다음 틱(5분 뒤)에 재시도.
  let 재시도예정 = false;
  const nextState = { lastWeek: state.lastWeek, tries: Number(state.tries) || 0, at: new Date().toISOString() };
  if (sent > 0) { nextState.lastWeek = weekKey; nextState.tries = 0; }
  else {
    const t = (Number(state.tries) || 0) + 1;
    if (t >= MAX_PUSH_TRIES) { nextState.lastWeek = weekKey; nextState.tries = 0; nextState.undelivered = weekKey; }
    else { nextState.tries = t; 재시도예정 = true; }
  }

  await logAudit(env, null, {
    action: 발송오류 ? 'reminder.weekly.fail' : 'reminder.weekly.push',
    actor: 'system', actorRole: 'system', actorName: '자동 리마인드(주간 요약 초안)',
    target: weekKey,
    path: 'cron runWeeklyDigestReminder() ← /api/notices-flush',
    summary: '주간 요약 초안 알림 ' + (발송오류 ? '발송 실패' : '발송') + ' — ' + digest.weekLabel
      + ' · 대상 학생 ' + digest.count + '명 · 기기 ' + sent + '대',
    detail: {
      주간: digest.weekLabel + ' (' + digest.from + '~' + digest.to + ')',
      대상학생수: digest.count,
      기록없는학생수: digest.noDataCount,
      받는사람: ADMIN_PUSH_USERS,
      보낸기기수: sent,
      발송오류: 발송오류 || '없음',
      알림본문: body,
      효과: sent
        ? '원장 폰에 "초안 준비됨" 알림만 갔다. **학부모에게는 아무것도 가지 않았다** — 관리자 화면에서 눌러야 나간다.'
        : (재시도예정
          ? '한 대도 도착하지 않았다. "이번 주 보냄"으로 찍지 않았으므로 5분 뒤 다음 틱에 다시 시도한다.'
          : '한 대도 도착하지 않았고 재시도 한도(' + MAX_PUSH_TRIES + '회)를 다 썼다. 폰의 알림 구독이 살아 있는지 확인이 필요하다.'),
      재시도: sent ? '불필요(도달함)' : (재시도예정 ? '예정 — 다음 5분 틱' : '없음 — 한도 소진'),
      비고: '이 알림은 초안 존재만 알린다. 발송 기록은 실제로 보낼 때 notify.* 로그로 따로 남는다.',
    },
  });

  try {
    await env.BUCKET.put(STATE_KEY, JSON.stringify(nextState), { httpMetadata: { contentType: 'application/json' } });
  } catch (_) {}

  return { ok: true, fired: true, weekKey, count: digest.count, sent, retry: 재시도예정 };
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return Response.json({ ok: false, error: 'GET only' }, { status: 405 });
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const auth = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = !!env.ADMIN_PASSWORD && auth === env.ADMIN_PASSWORD;
  const isCron = !!env.CRON_KEY && !!key && key === env.CRON_KEY;
  if (!isAdmin && !isCron) return Response.json({ ok: false, error: '인증이 필요합니다.' }, { status: 401 });

  // 🔒 원장 전용. 이 초안은 학원·반을 가리지 않고 전 학생을 훑고,
  //    여기서 나온 문구는 그대로 학부모 알림(type:'manual' — 원장만 가능)으로 나간다.
  //    조교에게 전체 명단·점수를 펼쳐 보일 이유가 없다.
  if (isAdmin) {
    const scope = await staffScopeAcademy(env, request);
    if (scope !== null) return Response.json({ ok: false, error: '원장만 볼 수 있어요.' }, { status: 403 });
  }

  // ?run=1 : 토요일 알림 게이트를 수동으로 돌려 본다(점검용). 조건이 안 맞으면 fired:false와 이유가 나온다.
  if (url.searchParams.get('run') === '1') {
    const r = await runWeeklyDigestReminder(env);
    return Response.json({ ok: true, reminder: r });
  }

  try {
    const digest = await buildWeeklyDigest(env);
    if (!digest.ok) return Response.json(digest, { status: 500 });
    return Response.json(digest);
  } catch (e) {
    return Response.json({ ok: false, error: '주간 요약을 만들지 못했습니다.' }, { status: 500 });
  }
}
