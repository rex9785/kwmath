// /api/payroll-reminder  (GET, 공개)
// ───────────────────────────────────────────────────────────
// "월급날(매월 5일) 리마인더" 를 관우T(__admin__) 폰으로 푸시.
//
// ⚠️ Cloudflare Pages는 cron(예약 실행)을 지원하지 않음 → 진짜 스케줄러가 없다.
//   그래서 '게으른 크론(lazy cron)' 방식: 평소 들어오는 접속 트래픽에 얹어
//   "오늘이 KST 4일 또는 5일이고, 아직 안 보냈으면 1번만" 관리자 푸시를 쏜다.
//   - 트리거: portal/index/admin 페이지가 하루 1회 이 endpoint를 fire-and-forget 핑.
//   - 멱등: R2 payroll-reminder/state.json { lastSent:'YYYY-MM-DD' } 로 하루 1발만 보장.
//   - 발송 대상: push-subs/__admin__.json (admin-qna '관리자 푸시 구독'으로 등록된 폰).
//     구독이 없으면 sent=0 (관우T가 구독을 켜야 실제 알림이 옴).
//
// 4일 = 내일(5일) 예고 / 5일 = 오늘 지급. 지급 대상은 항상 '전월(1~말일) 근무분'.
// ───────────────────────────────────────────────────────────
import { sendPushToUsers } from './_push.js';

const ADMIN_PUSH_USERS = ['__admin__'];
const STATE_KEY = 'payroll-reminder/state.json';

// 한국 시간(UTC+9) 기준 연·월·일. (한국은 서머타임 없음 → 고정 +9 안전)
function kstParts() {
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  return { y: k.getUTCFullYear(), m: k.getUTCMonth() + 1, d: k.getUTCDate() };
}
function ymd({ y, m, d }) {
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') {
    return Response.json({ ok: false, error: 'GET only' }, { status: 405 });
  }

  const p = kstParts();
  const today = ymd(p);

  // 4·5일이 아니면 스토리지도 안 건드리고 즉시 종료(평소 비용 0).
  if (p.d !== 4 && p.d !== 5) {
    return Response.json({ ok: true, today, fired: false, reason: 'not payday window' });
  }

  // 멱등: 오늘 이미 보냈으면 skip.
  let state = { lastSent: '' };
  try {
    const obj = await env.BUCKET.get(STATE_KEY);
    if (obj) { const j = JSON.parse(await obj.text()); if (j && typeof j === 'object') state = j; }
  } catch (_) {}
  if (state.lastSent === today) {
    return Response.json({ ok: true, today, fired: false, reason: 'already sent today' });
  }

  // 지급 대상 = 전월 (4·5일엔 항상 전월 근무분 정산)
  const tgtM = p.m === 1 ? 12 : p.m - 1;
  const msg = (p.d === 4)
    ? { title: '💰 내일(5일)은 조교 월급날', body: tgtM + '월 근무분 정산 — 미리 확인해 두세요' }
    : { title: '💰 오늘은 조교 월급날 (5일)', body: tgtM + '월 근무분 — 지금 정산·지급해 주세요' };

  let res = { sent: 0 };
  try {
    res = await sendPushToUsers(env, ADMIN_PUSH_USERS, {
      title: msg.title,
      body: msg.body,
      url: '/admin-staff',
      tag: 'kwmath-payroll',
    });
  } catch (_) {}

  // 오늘 처리됨으로 멱등 마킹(구독 0개여도 같은날 재핑 폭주 방지).
  try {
    await env.BUCKET.put(
      STATE_KEY,
      JSON.stringify({ lastSent: today, at: new Date().toISOString(), sent: (res && res.sent) || 0 }),
      { httpMetadata: { contentType: 'application/json' } }
    );
  } catch (_) {}

  return Response.json({ ok: true, today, fired: true, day: p.d, sent: (res && res.sent) || 0 });
}
