// _heartbeat.js — 크론(자동 스케줄러) 생존 신호.
//   외부 크론(cron-job.org)이 5분마다 /api/notices-flush를 때리면, 매 틱 R2에 마지막 실행 시각을 남긴다.
//   /api/cron-health가 이 값을 읽어 "크론이 조용히 멈췄는지"를 판단 → admin.html이 로그인 때 배너로 경보.
//
//   왜 필요한가: 공지 예약발송·월급 리마인더·출결 미입력 알림·야간 푸시 큐·D1 자동백업이
//     전부 이 단 하나의 외부 크론에 매달려 있다. 크론이 죽으면 이 모든 게 소리 없이 멈추는데,
//     지금은 그걸 알아챌 방법이 없다. 하트비트 = 최소한의 조기 경보(진짜 이중화는 UptimeRobot 등 외부 감시).
//   비용: 5분마다 R2 put 1회(하루 288회) — 무시 가능.

const HB_KEY = 'cron/_heartbeat.json';

export async function writeHeartbeat(env, extra) {
  try {
    if (!env || !env.BUCKET) return;
    const body = { lastTick: new Date().toISOString() };
    if (extra && typeof extra === 'object') Object.assign(body, extra);
    await env.BUCKET.put(HB_KEY, JSON.stringify(body), {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (_) { /* 하트비트 실패는 크론 본작업을 막지 않음 */ }
}

export async function readHeartbeat(env) {
  try {
    if (!env || !env.BUCKET) return null;
    const o = await env.BUCKET.get(HB_KEY);
    if (!o) return null;
    return JSON.parse(await o.text());
  } catch (_) { return null; }
}
