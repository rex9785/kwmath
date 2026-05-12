const DB = '34f134c4b2324685a62357c27c0aa919';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  const body = await request.json();
  const { password, title, fileName, r2Key, category, fileSize, phone4 } = body;
  if (password !== env.ADMIN_PASSWORD) return Response.json({ error: '인증 실패' }, { status: 401 });

  const isPublic = !phone4;
  const today = new Date().toISOString().split('T')[0];
  const properties = {
    '제목': { title: [{ text: { content: title || fileName || '파일' } }] },
    '파일명': { rich_text: [{ text: { content: fileName || '' } }] },
    'R2키': { rich_text: [{ text: { content: r2Key || '' } }] },
    '카테고리': category ? { select: { name: category } } : {},
    '파일크기': { rich_text: [{ text: { content: fileSize || '' } }] },
    '업로드일': { date: { start: today } },
    '공개': { checkbox: isPublic },
  };
  if (phone4) properties['전화번호끝4자리'] = { rich_text: [{ text: { content: phone4 } }] };

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: { database_id: DB }, properties }),
  });
  const data = await res.json();
  if (!res.ok) return Response.json({ error: data.message || '노션 저장 실패' }, { status: 500 });
  return Response.json({ success: true, pageId: data.id });
}
