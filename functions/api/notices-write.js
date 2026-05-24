const DB = '6cf7a459bd3d4444bd4c9341f3ffe907';

function auth(request, env) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  return token === env.ADMIN_PASSWORD;
}

export async function onRequest({ request, env }) {
  if (!auth(request, env)) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  if (request.method === 'POST') {
    const { title, badge, content } = await request.json();
    if (!title) return Response.json({ error: '제목을 입력해주세요.' }, { status: 400 });
    const today = new Date().toISOString().split('T')[0];
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: { database_id: DB }, properties: {
        '제목': { title: [{ text: { content: title } }] },
        '뱃지': { select: { name: badge || '공지' } },
        '날짜': { date: { start: today } },
        '내용': { rich_text: [{ text: { content: content || '' } }] },
        '공개': { checkbox: true },
      }}),
    });
    const data = await res.json();

    // 푸쉬 broadcast (R2 push-subs/ 전체 사용자에게 발송, 비치명적)
    try {
      const listed = await env.BUCKET.list({ prefix: 'push-subs/', limit: 1000 });
      const userIds = (listed.objects || [])
        .map(obj => decodeURIComponent(obj.key.replace('push-subs/', '').replace('.json', '')))
        .filter(Boolean);
      if (userIds.length) {
        await fetch(new URL('/api/push-send', request.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: env.ADMIN_PASSWORD,
            userIds,
            title: '📢 ' + (badge || '공지') + ' — ' + title,
            body: (content || '').slice(0, 100) || '새 공지사항이 등록됐어요',
            url: '/portal',
            tag: 'notice-' + Date.now()
          }),
        });
      }
    } catch (e) { /* 무시 */ }

    return Response.json({ ok: true, id: data.id });
  }

  if (request.method === 'PATCH') {
    const { pageId, title, badge, content } = await request.json();
    if (!pageId) return Response.json({ error: 'pageId 필요' }, { status: 400 });
    const properties = {};
    if (typeof title   === 'string') properties['제목'] = { title:     [{ text: { content: title } }] };
    if (typeof badge   === 'string') properties['뱃지'] = { select:    { name: badge } };
    if (typeof content === 'string') properties['내용'] = { rich_text: [{ text: { content } }] };
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return Response.json({ error: err.message || 'Notion 수정 실패' }, { status: res.status });
    }
    return Response.json({ ok: true });
  }

  if (request.method === 'DELETE') {
    const { pageId } = await request.json();
    if (!pageId) return Response.json({ error: 'pageId 필요' }, { status: 400 });
    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
