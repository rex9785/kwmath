// /api/notices-flush
// 예약 발송 시각이 도래한 미발송 공지를 찾아 푸쉬 발송
// 인증:
//   - Authorization: Bearer <ADMIN_PASSWORD>   (관리자 수동 트리거)
//   - 또는 ?key=<CRON_KEY>                      (cron-job.org / Cloudflare Worker cron 등에서 호출)
// GET, POST 모두 동작

import { dispatchNoticePush } from './notices-write.js';

const DB = '6cf7a459bd3d4444bd4c9341f3ffe907';

function isAuthed(request, env) {
  const url = new URL(request.url);
  const queryKey = url.searchParams.get('key');
  if (env.CRON_KEY && queryKey && queryKey === env.CRON_KEY) return true;
  const auth = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (env.ADMIN_PASSWORD && auth === env.ADMIN_PASSWORD) return true;
  return false;
}

export async function onRequest({ request, env }) {
  if (!isAuthed(request, env)) {
    return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });
  }

  // 예약 시각이 지났고, 아직 발송 안 된 공지만 조회
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
      page_size: 50,
    }),
  });
  const data = await queryRes.json();
  if (data.object === 'error') {
    return Response.json({ error: data.message }, { status: 500 });
  }

  const rt   = (p, k) => ((p[k]?.rich_text || [])[0]?.plain_text || '').trim();
  const ttl  = (p, k) => ((p[k]?.title || [])[0]?.plain_text || '').trim();
  const sel  = (p, k) => p[k]?.select?.name || '';

  const results = [];
  for (const page of (data.results || [])) {
    if (page.archived || page.in_trash) continue;
    const pp = page.properties || {};
    const item = {
      pageId: page.id,
      title: ttl(pp, '제목'),
      badge: sel(pp, '뱃지'),
      content: rt(pp, '내용'),
      targetType: sel(pp, '대상 유형') || '전체',
      targetValue: rt(pp, '대상 값'),
    };
    const push = await dispatchNoticePush(env, request.url, item);
    results.push({ pageId: item.pageId, title: item.title, push });
  }

  return Response.json({
    ok: true,
    checkedAt: nowIso,
    dispatched: results.length,
    results,
  });
}
