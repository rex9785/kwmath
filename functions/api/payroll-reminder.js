// /api/payroll-reminder  (GET, 공개) + runPayrollReminder(env) (내부 재사용)
// ───────────────────────────────────────────────────────────
// "월급날(매월 5일) 리마인더" 를 관우T(__admin__) 폰으로 푸시.
// 푸시 본문 = 승인된 조교별  "이름 / 계좌(뒤 4자리만) / 이번 구간 정산금액"  목록.
//   📌 2026-08-05 — 정산 구간이 "전월 1일~말일"에서 "전월 6일 ~ 당월 5일(5일 포함)"로 바뀌었다.
//      금액은 staff-worklog.js의 staffPeriodSummary(구간 합계)로 뽑는다. 여기서 따로 계산하지 않는다.
//   ⚠️ 계좌번호 전체는 푸시에 넣지 않는다(잠금화면 노출). 전체 번호는 앱 /admin-staff 에서 본다.
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
// 4일 = 내일(5일) 예고 / 5일 = 오늘 지급.
// 💰 2026-08-05 변경 — 지급 대상 구간이 '전월 1~말일'에서 **'전월 6일 ~ 이번 달 5일'** 로 바뀌었다.
//   관우T 확정: 5일에 주는 돈은 "그 5일까지 일한 것"이다.
//   ⚠️ 그래서 **4일에 가는 예고 금액은 최종액이 아니다** — 4일·5일 이틀치 근무가 아직 안 들어와 있다.
//      푸시 본문에도 그렇게 적는다. 최종 금액은 5일 알림(또는 /admin-staff)에서 본다.
// ───────────────────────────────────────────────────────────
import { sendPushToUsers } from './_push.js';
import { listStaff } from './_staff.js';
import { staffPeriodSummary, periodOf } from './staff-worklog.js';
// 📓 감사로그(2026-07-31) — "월급 알림이 안 왔다"에 답할 근거.
//   대부분의 호출은 4·5일이 아니라 즉시 끝난다(하루 288틱 + 페이지 핑) → **실제로 쏜 때만** 1건 남긴다.
//   크론/트래픽 어느 쪽이든 사람의 행위가 아니므로 actor='system'.
import { logAudit } from './_auditlog.js';

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

// 🔒 계좌번호 마스킹 (2026-07-31) — 푸시 본문은 잠금화면에 그대로 뜬다.
//   폰을 잠깐 책상에 두거나 남에게 화면을 보여줄 때 조교 계좌 전체가 노출되던 문제.
//   은행명(숫자 아닌 앞부분)은 남기고 계좌 숫자는 뒤 4자리만 남긴다. 예) '신한 110-123-456789' → '신한 ****6789'
//   전체 번호는 앱(/admin-staff 월급 표·수정폼·CSV)에서 그대로 볼 수 있으므로 잃는 정보 없음.
function maskAccount(raw) {
  const s = String(raw || '').trim();
  if (!s) return '계좌미등록';
  const digits = s.replace(/\D/g, '');
  const bank = s.replace(/[\d\-\s]+/g, ' ').trim();   // 숫자·하이픈 제거 → 은행명만 남음
  const head = bank ? bank + ' ' : '';
  if (digits.length < 4) return head + '****';        // 숫자가 4자리 미만이면 뒷자리 없이 가림
  return head + '****' + digits.slice(-4);
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

  // 지급 대상 = 이번 달 5일에 나가는 급여구간 = 전월 6일 ~ 이번 달 5일.
  //   4일·5일 어느 쪽에 떠도 지급월은 '이번 달'이다(5일이 아직 안 지났으므로).
  const payMonth = p.y + '-' + String(p.m).padStart(2, '0');
  const 구간 = periodOf(payMonth);       // { start:'전월 6일', end:'이번달 5일', payday, months }
  const tgtMonth = payMonth;             // 로그·상태 키 호환용 이름 유지
  // 푸시 본문용 짧은 라벨 — '7/6~8/5' 처럼. 앞의 0은 떼서 잠금화면에서 읽기 좋게.
  const 구간라벨 = Number(구간.start.slice(5, 7)) + '/' + Number(구간.start.slice(8, 10))
    + '~' + Number(구간.end.slice(5, 7)) + '/' + Number(구간.end.slice(8, 10));

  // 승인된 조교별 이번 구간 정산액 → "이름 / 계좌(마스킹) / 금액" 줄 목록
  let lines = [];
  // 로그용 — 계좌번호는 뒤 4자리만 남긴다(금액·시간은 그대로. 누가 얼마 받았는지가 이 로그의 핵심이다).
  const 로그용조교 = [];
  try {
    const staff = await listStaff(env);
    const rows = [];
    for (const s of staff) {
      if (!s || !s.approved) continue;
      const digits = String(s.phone || '').replace(/\D/g, '');
      if (!digits) continue;
      let sum = { totalHours: 0, totalPay: 0 };
      try { sum = await staffPeriodSummary(env, digits, payMonth, s.hourlyWage); } catch (_) {}
      if ((sum.totalHours || 0) <= 0) continue;   // 그 구간 근무 없으면 제외
      rows.push({
        name: s.name || '(이름없음)', account: s.account || '',
        pay: sum.totalPay || 0, hours: sum.totalHours || 0, wage: s.hourlyWage || 0,
      });
      로그용조교.push({
        이름: s.name || '(이름없음)',
        계좌뒤4: s.account ? String(s.account).replace(/\D/g, '').slice(-4) : '(미등록)',
        근무시간: sum.totalHours || 0,
        시급: s.hourlyWage || 0,
        정산액: sum.totalPay || 0,
      });
    }
    rows.sort((a, b) => b.pay - a.pay);   // 금액 큰 순
    로그용조교.sort((a, b) => b.정산액 - a.정산액);   // 로그도 같은 순서로
    lines = rows.map((r) => {
      const amt = r.wage > 0 ? (won(r.pay) + '원') : (r.hours + '시간(시급미설정)');
      return r.name + ' / ' + maskAccount(r.account) + ' / ' + amt;
    });
  } catch (_) {}

  const title = (p.d === 4) ? '💰 내일(5일) 조교 월급날' : '💰 오늘 조교 월급날 (5일)';
  // 4일에는 4일·5일 근무가 아직 안 들어와 있다 → "중간 집계"임을 본문에 못박는다.
  const 꼬리 = (p.d === 4)
    ? '\n\n· 4·5일 근무는 아직 미반영 (중간 집계)\n· 계좌번호 전체는 알림을 눌러 앱에서 확인'
    : '\n\n· 계좌번호 전체는 알림을 눌러 앱에서 확인';
  const body = lines.length
    ? (구간라벨 + ' 정산\n' + lines.join('\n') + 꼬리)
    : (구간라벨 + ' 구간에 근무기록이 있는 조교가 없어요');

  let res = { sent: 0 };
  let 발송오류 = '';
  try {
    res = await sendPushToUsers(env, ADMIN_PUSH_USERS, { title, body, url: '/admin-staff', tag: 'kwmath-payroll' });
  } catch (e) { 발송오류 = String((e && e.message) || e); }

  // 📓 월 2건(4일·5일)만 남는다. "월급 알림이 안 왔다"·"금액이 이상하다"에 답할 유일한 근거.
  await logAudit(env, null, {
    action: 발송오류 ? 'payroll.reminder.fail' : 'payroll.reminder.push',
    actor: 'system', actorRole: 'system', actorName: '자동 리마인드(조교 월급날)',
    target: today, targetName: tgtMonth + ' 정산',
    path: 'cron runPayrollReminder() ← /api/notices-flush 또는 페이지 핑',
    summary: '조교 월급 리마인드 ' + (발송오류 ? '발송 실패' : '발송') + ' — ' + today + ' · '
      + 구간.start + '~' + 구간.end + ' 분 · 조교 ' + 로그용조교.length + '명 · 총 '
      + won(로그용조교.reduce((a, b) => a + (b.정산액 || 0), 0)) + '원 · 기기 ' + ((res && res.sent) || 0) + '대',
    detail: {
      실행일: today + (p.d === 4 ? ' (내일이 월급날 — 예고, 4·5일 근무 미반영)' : ' (오늘이 월급날)'),
      지급월: tgtMonth,
      정산구간: 구간.start + ' ~ ' + 구간.end + ' (지급일 ' + 구간.payday + ')',
      조교별정산: 로그용조교,
      총액: 로그용조교.reduce((a, b) => a + (b.정산액 || 0), 0),
      받는사람: ADMIN_PUSH_USERS,
      보낸기기수: (res && res.sent) || 0,
      발송오류: 발송오류 || '없음',
      효과: ((res && res.sent) || 0)
        ? '원장 폰에 조교별 지급 목록이 갔다. 오늘은 다시 보내지 않는다(하루 1발 멱등).'
        : '보낼 기기가 없거나 발송이 실패해 알림이 도착하지 않았다. 그래도 오늘 보낸 것으로 표시되어 오늘은 재발송되지 않는다.',
      비고: '계좌번호는 푸시 본문·이 로그 둘 다 뒤 4자리만 남긴다(2026-07-31 변경 — 그 전에는 푸시 본문에 전체가 들어갔다). '
        + '전체 번호는 앱 /admin-staff 에서만 본다. 그 구간 근무기록이 0인 조교는 목록에서 빠진다. '
        + '💰 2026-08-05부터 정산 구간이 「전월 6일~지급월 5일」이다(예전엔 전월 1~말일). '
        + '4일 예고분은 4·5일 근무가 빠진 중간 집계이므로 5일 알림과 금액이 다를 수 있다 — 정상이다.',
    },
  });

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
