// /api/payroll-reminder  (GET, 공개) + runPayrollReminder(env) (내부 재사용)
// ───────────────────────────────────────────────────────────
// "월급날(매월 5일) 리마인더" 를 관우T(__admin__) 폰으로 푸시.
// 푸시 본문 = 승인된 조교별  "이름 / 계좌 / 전월 정산금액"  목록.
//
// ⚠️ Cloudflare Pages는 cron(예약 실행)을 지원하지 않음 → 진짜 스케줄러가 없다.
//   대신 두 경로로 트리거되며, 발송 판단(아침시간·하루1발)은 전부 아래 게이트가 한다:
//   1) 외부 크론(주력): cron-job.org 등이 5분마다 /api/notices-flush?key=CRON_KEY 핑 →
//      notices-flush.js가 매 틱마다 runPayrollReminder(env)를 같이 호출. (기존 공지 예약발송 크론 재사용)
//   2) 접속 트래픽(백업): portal/index/admin 페이지가 하루 1회 이 endpoint를 fire-and-forget 핑.
//
//   게이트(둘 다 동일 적용):
//     - KST 4일 또는 5일에만.
//     - 아침 08:00~22:00 KST에만 발송(새벽·심야 알림 방지 — 사용자 요청).
//     - R2 payroll-reminder/state.json { lastSent:'YYYY-MM-DD' } 로 하루 1발만(멱등).
//   발송 대상: push-subs/__admin__.json (admin-qna '관리자 푸시 구독'으로 등록된 폰). 없으면 sent=0.
//
// 4일 = 내일(5일) 예고 / 5일 = 오늘 지급. 지급 대상은 항상 '전월(1~말일) 근무분'.
// ───────────────────────────────────────────────────────────
import { sendPushToUsers } from './_push.js';
import { listStaff } from './_staff.js';
import { staffMonthSummary } from './staff-worklog.js';

const ADMIN_PUSH_USERS = ['__admin__'];
const STATE_KEY = 'payroll-reminder/state.json';

// 한국 시간(UTC+9) 기준 연·월·일·시. (한국은 서머타임 없음 → 고정 +9 안전)
function kstParts() {
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  return { y: k.getUTCFullYear(), m: k.getUTCMonth() + 1, d: k.getUTCDate(), h: k.getUTCHours() };
}
function ymd({ y, m, d }) {
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
// 천단위 콤마 (Workers의 toLocaleString 로캘 불확실 → 직접 포맷)
function won(n) {
  return (Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 실제 발송 로직 — notices-flush(크론)와 onRequest(트래픽)가 공유.
// 절대 throw 안 함(베스트에포트). 항상 상태 객체 반환.
export async function runPayrollReminder(env) {
  const p = kstParts();
  const today = ymd(p);

  // 4·5일이 아니면 스토리지도 안 건드리고 즉시 종료(평소 비용 0).
  if (p.d !== 4 && p.d !== 5) return { ok: true, today, fired: false, reason: 'not payday window' };
  // 아침(08:00~22:00 KST)에만 — 새벽/심야 알림 방지.
  if (p.h < 8 || p.h >= 22) return { ok: true, today, fired: false, reason: 'not morning window', h: p.h };

  // 멱등: 오늘 이미 보냈으면 skip.
  let state = { lastSent: '' };
  try {
    const obj = await env.BUCKET.get(STATE_KEY);
    if (obj) { const j = JSON.parse(await obj.text()); if (j && typeof j === 'object') state = j; }
  } catch (_) {}
  if (state.lastSent === today) return { ok: true, today, fired: false, reason: 'already sent today' };

  // 지급 대상 = 전월 (4·5일엔 항상 전월 근무분 정산)
  const tgtY = p.m === 1 ? p.y - 1 : p.y;
  const tgtM = p.m === 1 ? 12 : p.m - 1;
  const tgtMonth = tgtY + '-' + String(tgtM).padStart(2, '0');

  // 승인된 조교별 전월 정산액 → "이름 / 계좌 / 금액" 줄 목록
  let lines = [];
  try {
    const staff = await listStaff(env);
    const rows = [];
    for (const s of staff) {
      if (!s || !s.approved) continue;
      const digits = String(s.phone || '').replace(/\D/g, '');
      if (!digits) continue;
      let sum = { totalHours: 0, totalPay: 0 };
      try { sum = await staffMonthSummary(env, digits, tgtMonth, s.hourlyWage); } catch (_) {}
      if ((sum.totalHours || 0) <= 0) continue;   // 그 달 근무 없으면 제외
      rows.push({
        name: s.name || '(이름없음)', account: s.account || '',
        pay: sum.totalPay || 0, hours: sum.totalHours || 0, wage: s.hourlyWage || 0,
      });
    }
    rows.sort((a, b) => b.pay - a.pay);   // 금액 큰 순
    lines = rows.map((r) => {
      const amt = r.wage > 0 ? (won(r.pay) + '원') : (r.hours + '시간(시급미설정)');
      return r.name + ' / ' + (r.account || '계좌미등록') + ' / ' + amt;
    });
  } catch (_) {}

  const title = (p.d === 4) ? '💰 내일(5일) 조교 월급날' : '💰 오늘 조교 월급날 (5일)';
  const body = lines.length
    ? (tgtM + '월 정산\n' + lines.join('\n'))
    : (tgtM + '월 근무기록이 있는 조교가 없어요');

  let res = { sent: 0 };
  try {
    res = await sendPushToUsers(env, ADMIN_PUSH_USERS, { title, body, url: '/admin-staff', tag: 'kwmath-payroll' });
  } catch (_) {}

  // 오늘 처리됨으로 멱등 마킹(구독 0개여도 같은날 재핑 폭주 방지).
  try {
    await env.BUCKET.put(
      STATE_KEY,
      JSON.stringify({ lastSent: today, at: new Date().toISOString(), sent: (res && res.sent) || 0, staffCount: lines.length }),
      { httpMetadata: { contentType: 'application/json' } }
    );
  } catch (_) {}

  return { ok: true, today, fired: true, day: p.d, sent: (res && res.sent) || 0, staffCount: lines.length };
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') {
    return Response.json({ ok: false, error: 'GET only' }, { status: 405 });
  }
  const r = await runPayrollReminder(env);
  return Response.json(r);
}
