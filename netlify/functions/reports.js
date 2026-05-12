exports.handler = async function (event, context) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = '82ef896dcf844c5b9c36f7e0ff0a97f2';

  const phone4 = event.queryStringParameters?.phone4 || '';
  if (!phone4 || phone4.length !== 4 || !/^\d{4}$/.test(phone4)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: '전화번호 끝 4자리를 올바르게 입력해주세요.' }),
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
        filter: {
          and: [
            { property: '공개', checkbox: { equals: true } },
            { property: '전화번호 끝 4자리', rich_text: { equals: phone4 } },
          ],
        },
        sorts: [{ property: '수업 날짜', direction: 'descending' }],
      }),
    });

    const data = await response.json();

    const reports = (data.results || []).map((page) => ({
      id: page.id,
      title: page.properties['리포트 제목']?.title?.[0]?.plain_text || '',
      studentName: page.properties['학생 이름']?.rich_text?.[0]?.plain_text || '',
      date: page.properties['수업 날짜']?.date?.start || '',
      school: page.properties['학원']?.select?.name || '',
      content: page.properties['수업 내용']?.rich_text?.[0]?.plain_text || '',
      homework: page.properties['숙제']?.rich_text?.[0]?.plain_text || '',
      notes: page.properties['특이사항']?.rich_text?.[0]?.plain_text || '',
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(reports),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
