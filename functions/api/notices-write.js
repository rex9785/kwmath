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
    return Response.json({ ok: true, id: data.id });
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
