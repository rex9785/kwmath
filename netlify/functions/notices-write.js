exports.handler = async function (event, context) {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = '6cf7a459bd3d4444bd4c9341f3ffe907';

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

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
      },
      body: '',
    };
  }

  // 공지사항 생성 (POST)
  if (event.httpMethod === 'POST') {
    const { title, badge, content } = JSON.parse(event.body || '{}');
    if (!title) {
      return { statusCode: 400, body: JSON.stringify({ error: '제목을 입력해주세요.' }) };
    }

    const today = new Date().toISOString().split('T')[0];
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
          '제목': { title: [{ text: { content: title } }] },
          '뱃지': { select: { name: badge || '공지' } },
          '날짜': { date: { start: today } },
          '내용': { rich_text: [{ text: { content: content || '' } }] },
          '공개': { checkbox: true },
        },
      }),
    });

    const data = await response.json();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true, id: data.id }),
    };
  }

  // 공지사항 삭제 (DELETE) → Notion에서는 archive 처리
  if (event.httpMethod === 'DELETE') {
    const { pageId } = JSON.parse(event.body || '{}');
    if (!pageId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'pageId가 필요합니다.' }) };
    }

    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ archived: true }),
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true }),
    };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
