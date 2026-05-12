exports.handler = async function (event, context) {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = '559465b73e2f4b76b7df441fd0058bfb';

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

  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        page_size: 100,
      }),
    });

    const data = await response.json();

    const students = (data.results || []).map((page) => ({
      id: page.id,
      name: page.properties['이름']?.title?.[0]?.plain_text || '',
      school: page.properties['학교']?.rich_text?.[0]?.plain_text || '',
      grade: page.properties['학년']?.select?.name || '',
      parentPhone4: page.properties['학부모 연락처 끝4자리']?.rich_text?.[0]?.plain_text || '',
      studentPhone: page.properties['학생 연락처']?.rich_text?.[0]?.plain_text || '',
      goals: (page.properties['수강 목적']?.multi_select || []).map((g) => g.name),
      level: page.properties['현재 수학 등급']?.select?.name || '',
      academy: page.properties['학원']?.select?.name || '',
      notes: page.properties['특이사항']?.rich_text?.[0]?.plain_text || '',
      createdAt: page.created_time || '',
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(students),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
