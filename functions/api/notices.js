const DB = '6cf7a459bd3d4444bd4c9341f3ffe907';

export async function onRequest({ env }) {
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { property: '공개', checkbox: { equals: true } }, sorts: [{ property: '날짜', direction: 'descending' }], page_size: 10 }),
    });
    const data = await res.json();
    const joinText = (rt) => (rt || []).map(t => t.plain_text).join('');
    const notices = (data.results || []).map(p => ({
      id: p.id,
      title: (p.properties['제목']?.title || []).map(t => t.plain_text).join(''),
      date: p.properties['날짜']?.date?.start || '',
      badge: p.properties['뱃지']?.select?.name || '공지',
      content: joinText(p.properties['내용']?.rich_text),
    }));
    return Response.json(notices);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
