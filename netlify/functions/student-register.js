exports.handler = async function (event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = '559465b73e2f4b76b7df441fd0058bfb';

  const { name, school, grade, parentPhone4, studentPhone, goals, level, academy, notes } = JSON.parse(event.body || '{}');

  if (!name || !grade || !parentPhone4) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: '이름, 학년, 학부모 연락처는 필수입니다.' }),
    };
  }

  const goalsArray = Array.isArray(goals) ? goals : (goals ? [goals] : []);

  const response = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: DATABASE_ID },
      properties: {
        '이름': { title: [{ text: { content: name } }] },
        '학교': { rich_text: [{ text: { content: school || '' } }] },
        '학년': { select: { name: grade } },
        '학부모 연락처 끝4자리': { rich_text: [{ text: { content: parentPhone4 } }] },
        '학생 연락처': { rich_text: [{ text: { content: studentPhone || '' } }] },
        '수강 목적': { multi_select: goalsArray.map(g => ({ name: g })) },
        '현재 수학 등급': { select: { name: level || '잘 모름' } },
        '학원': { select: { name: academy || '대치동 정규반' } },
        '특이사항': { rich_text: [{ text: { content: notes || '' } }] },
      },
    }),
  });

  const data = await response.json();

  if (data.object === 'error') {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: data.message }),
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ ok: true }),
  };
};
