const DB = '559465b73e2f4b76b7df441fd0058bfb';

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sorts: [{ timestamp: 'created_time', direction: 'descending' }], page_size: 100 }),
    });
    const data = await res.json();
    const students = (data.results || []).map(p => ({
      id: p.id,
      name: p.properties['이름']?.title?.[0]?.plain_text || '',
      school: p.properties['학교']?.rich_text?.[0]?.plain_text || '',
      grade: p.properties['학년']?.select?.name || '',
      parentPhone4: p.properties['학부모 연락처 끝4자리']?.rich_text?.[0]?.plain_text || '',
      studentPhone: p.properties['학생 연락처']?.rich_text?.[0]?.plain_text || '',
      goals: (p.properties['수강 목적']?.multi_select || []).map(g => g.name),
      level: p.properties['현재 수학 등급']?.select?.name || '',
      academy: p.properties['학원']?.select?.name || '',
      notes: p.properties['특이사항']?.rich_text?.[0]?.plain_text || '',
      createdAt: p.created_time || '',
    }));
    return Response.json(students);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
