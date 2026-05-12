const DB = '34f134c4b2324685a62357c27c0aa919';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const phone4 = url.searchParams.get('phone4');
  const category = url.searchParams.get('category');

  let filter;
  if (phone4) {
    filter = { or: [
      { property: '전화번호끝4자리', rich_text: { equals: phone4 } },
      { and: [{ property: '공개', checkbox: { equals: true } }, { property: '전화번호끝4자리', rich_text: { is_empty: true } }] },
    ]};
  } else {
    filter = { and: [{ property: '공개', checkbox: { equals: true } }, { property: '전화번호끝4자리', rich_text: { is_empty: true } }] };
  }

  if (category) {
    const catFilter = { property: '카테고리', select: { equals: category } };
    filter = filter.and ? { and: [...filter.and, catFilter] } : { and: [filter, catFilter] };
  }

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter, sorts: [{ property: '업로드일', direction: 'descending' }] }),
    });
    const data = await res.json();
    const files = (data.results || []).map(p => ({
      id: p.id,
      title: p.properties['제목']?.title?.[0]?.plain_text || '',
      fileName: p.properties['파일명']?.rich_text?.[0]?.plain_text || '',
      r2Key: p.properties['R2키']?.rich_text?.[0]?.plain_text || '',
      category: p.properties['카테고리']?.select?.name || '',
      fileSize: p.properties['파일크기']?.rich_text?.[0]?.plain_text || '',
      uploadDate: p.properties['업로드일']?.date?.start || '',
      isPublic: p.properties['공개']?.checkbox || false,
    }));
    return Response.json(files);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
