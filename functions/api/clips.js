const DB = '9784fd34c91543c7b2c4cca4db1911aa';

export async function onRequest({ env }) {
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { property: '공개', checkbox: { equals: true } }, sorts: [{ property: '순서', direction: 'ascending' }] }),
    });
    const data = await res.json();
    const clips = (data.results || []).map(p => ({
      id: p.id,
      title: p.properties['제목']?.title?.[0]?.plain_text || '',
      reelId: p.properties['인스타 릴스 ID']?.rich_text?.[0]?.plain_text || '',
      desc: p.properties['썸네일 설명']?.rich_text?.[0]?.plain_text || '',
      tags: (p.properties['주제 태그']?.multi_select || []).map(t => t.name),
      order: p.properties['순서']?.number || 0,
    }));
    return Response.json(clips);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
