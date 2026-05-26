// GET /api/notices
// - 인증 없이 호출: 전체 대상 공지만 반환 (메인 홈피용)
// - Authorization: Bearer <userToken>: 그 학생/학부모에게 해당하는 공지만 (전체 + 학원 + 반 + 개인)
// - admin: 모든 공지 반환
//
// 부수효과: 5분 쿨다운으로 예약 푸쉬 자동 발송 (opportunistic cron)
//   누군가 포털을 열면 자동으로 예약된 공지가 발송됨. 외부 cron 불필요.

import { bearerFromRequest, verifyToken, fetchStudentsByPhone } from './_auth.js';
import { dispatchNoticePush } from './notices-write.js';

const DB = '6cf7a459bd3d4444bd4c9341f3ffe907';
const FLUSH_COOLDOWN_MS = 5 * 60 * 1000; // 5분
const FLUSH_LOCK_KEY = 'auth/notice-flush-last.json';

// 침묵 시간: 한국시간 23:00 ~ 07:00 — 푸쉬 발송 보류
function isQuietHourKST() {
  const kstHour = (new Date().getUTCHours() + 9) % 24;
  return (kstHour >= 23) || (kstHour < 7);
}

// 예약 푸쉬 opportunistic flush — 5분 쿨다운, 백그라운드로 실행 (응답 지연 없음)
async function maybeFlushScheduled(env, originUrl, ctx) {
  // 침묵 시간이면 아예 스킵
  if (isQuietHourKST()) return;
  try {
    const lockObj = await env.BUCKET.get(FLUSH_LOCK_KEY);
    let lastAt = 0;
    if (lockObj) {
      try { lastAt = (await lockObj.json()).t || 0; } catch (_) {}
    }
    const now = Date.now();
    if (now - lastAt < FLUSH_COOLDOWN_MS) return; // 쿨다운 안 지남

    // 락 갱신 (race 방지를 위해 먼저 업데이트)
    await env.BUCKET.put(FLUSH_LOCK_KEY, JSON.stringify({ t: now }), {
      httpMetadata: { contentType: 'application/json' },
    });

    // 예약된 공지 조회
    const nowIso = new Date().toISOString();
    const queryRes = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: {
          and: [
            { property: '푸쉬 발송됨', checkbox: { equals: false } },
            { property: '예약 발송 시각', date: { is_not_empty: true } },
            { property: '예약 발송 시각', date: { on_or_before: nowIso } },
          ],
        },
        page_size: 20,
      }),
    });
    const data = await queryRes.json();
    if (data.object === 'error') return;

    const rt   = (p, k) => ((p[k]?.rich_text || [])[0]?.plain_text || '').trim();
    const ttl  = (p, k) => ((p[k]?.title || [])[0]?.plain_text || '').trim();
    const sel  = (p, k) => p[k]?.select?.name || '';

    for (const page of (data.results || [])) {
      if (page.archived || page.in_trash) continue;
      const pp = page.properties || {};
      await dispatchNoticePush(env, originUrl, {
        pageId: page.id,
        title: ttl(pp, '제목'),
        badge: sel(pp, '뱃지'),
        content: rt(pp, '내용'),
        targetType: sel(pp, '대상 유형') || '전체',
        targetValue: rt(pp, '대상 값'),
      });
    }
  } catch (_) { /* 비치명적 — 무시 */ }
}

export async function onRequest(context) {
  const { request, env } = context;

  // 백그라운드로 flush 시도 (응답 차단 안 함)
  if (context.waitUntil) {
    context.waitUntil(maybeFlushScheduled(env, request.url, context));
  } else {
    // ctx 없으면 동기로 시작만 하고 await 안 함
    maybeFlushScheduled(env, re