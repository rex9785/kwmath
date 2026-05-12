const DB = '82ef896dcf844c5b9c36f7e0ff0a97f2';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const phone4 = url.searchParams.get('phone4') || '';
  if (!phone4 || phone4.length !== 4 || !/^\d{4}$/.test(phone4))
    return Response.json({ error: '전화번호 끝 4자리를 올바르게 입력해주세요.' }, { status: 400 });

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { and: [
        { property: '공개', checkbox: { equals: true } },
        { property: '전화번호 끝 4자리', rich_text: { equals: phone4 } },
      ]}, sorts: [{ property: '수업 날짜', direction: 'descending' }] }),
    });
    const data = await res.json();
    const reports = (data.results || []).map(p => ({
      id: p.id,
      title: p.properties['리포트 제목']?.title?.[0]?.plain_text || '',
      studentName: p.properties['학생 이름']?.rich_text?.[0]?.plain_text || '',
      date: p.properties['수업 날짜']?.date?.start || '',
      school: p.properties['학원']?.select?.name || '',
      content: p.properties['수업 내용']?.rich_text?.[0]?.plain_text || '',
      homework: p.properties['숙제']?.rich_text?.[0]?.plain_text || '',
      notes: p.properties['특이사항']?.rich_text?.[0]?.plain_text || '',
    }));
    return Response.json(reports);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
