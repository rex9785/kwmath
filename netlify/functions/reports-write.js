exports.handler = async function (event, context) {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = '82ef896dcf844c5b9c36f7e0ff0a97f2';

  // 인증 확인
  const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = auth.replace('Bearer ', '');
  if (!token || token !== ADMIN_PASSWORD) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: '인증이 필요합니다.' }),
    };
  }

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { studentName, phone4, date, school, content, homework, notes } = JSON.parse(event.body || '{}');

  if (!studentName || !phone4 || !date) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: '학생 이름, 전화번호 끝 4자리, 수업 날짜는 필수입니다.' }),
    };
  }

  const title = `${studentName} - ${date} 수업 리포트`;

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
        '리포트 제목': { title: [{ text: { content: title } }] },
        '학생 이름': { rich_text: [{ text: { content: studentName } }] },
        '전화번호 끝 4자리': { rich_text: [{ text: { content: phone4 } }] },
        '수업 날짜': { date: { start: date } },
        '학원': { select: { name: school || '대치동 정규반' } },
        '수업 내용': { rich_text: [{ text: { content: content || '' } }] },
        '숙제': { rich_text: [{ text: { content: homework || '' } }] },
        '특이사항': { rich_text: [{ text: { content: notes || '' } }] },
        '공개': { checkbox: true },
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
    body: JSON.stringify({ ok: true, id: data.id }),
  };
};
