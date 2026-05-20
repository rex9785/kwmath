const DB = '559465b73e2f4b76b7df441fd0058bfb';

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 문자 제외 (I, O, 0, 1)
  let key = 'KW';
  for (let i = 0; i < 6; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key; // ex) KWA3B7X2
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  const { name, school, grade, parentPhone4, studentPhone, goals, level, academy, className, notes } = await request.json();
  if (!name || !grade || !parentPhone4)
    return Response.json({ error: '이름, 학년, 학부모 연락처는 필수입니다.' }, { status: 400 });

  const goalsArray = Array.isArray(goals) ? goals : (goals ? [goals] : []);
  const personalKey = generateKey();

  const properties = {
    '이름': { title: [{ text: { content: name } }] },
    '학교': { rich_text: [{ text: { content: school || '' } }] },
    '학년': { select: { name: grade } },
    '학부모 연락처 끝4자리': { rich_text: [{ text: { content: parentPhone4 } }] },
    '학생 연락처': { rich_text: [{ text: { content: studentPhone || '' } }] },
    '수강 목적': { multi_select: goalsArray.map(g => ({ name: g })) },
    '현재 수학 등급': { select: { name: level || '잘 모름' } },
    '학원': { select: { name: academy || '대치동 정규반' } },
    '특이사항': { rich_text: [{ text: { content: notes || '' } }] },
    '개인키': { rich_text: [{ text: { content: personalKey } }] },
  };
  if (className) properties['반'] = { select: { name: className } };

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: { database_id: DB }, properties }),
  });
  const data = await res.json();
  if (data.object === 'error') return Response.json({ error: data.message || '학생 등록 실패' }, { status: 500 });
  return Response.json({ ok: true, personalKey, id: data.id });
}
