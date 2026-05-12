const DB = '559465b73e2f4b76b7df441fd0058bfb';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  const { name, school, grade, parentPhone4, studentPhone, goals, level, academy, notes } = await request.json();
  if (!name || !grade || !parentPhone4)
    return Response.json({ error: '이름, 학년, 학부모 연락처는 필수입니다.' }, { status: 400 });

  const goalsArray = Array.isArray(goals) ? goals : (goals ? [goals] : []);
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: { database_id: DB }, properties: {
      '이름': { title: [{ text: { content: name } }] },
      '학교': { rich_text: [{ text: { content: school || '' } }] },
      '학년': { select: { name: grade } },
      '학부모 연락처 끝4자리': { rich_text: [{ text: { content: parentPhone4 } }] },
      '학생 연락처': { rich_text: [{ text: { content: studentPhone || '' } }] },
      '수강 목적': { multi_select: goalsArray.map(g => ({ name: g })) },
      '현재 수학 등급': { select: { name: level || '잘 모름' } },
      '학원': { select: { name: academy || '대치동 정규반' } },
      '특이사항': { rich_text: [{ text: { content: notes || '' } }] },
    }}),
  });
  const data = await res.json();
  if (data.object === 'error') return Response.json({ error: data.message }, { status: 500 });
  return Response.json({ ok: true });
}
