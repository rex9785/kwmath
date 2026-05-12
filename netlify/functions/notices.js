exports.handler = async function (event, context) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = '6cf7a459bd3d4444bd4c9341f3ffe907';

  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: { property: '공개', checkbox: { equals: true } },
        sorts: [{ property: '날짜', direction: 'descending' }],
        page_size: 10,
      }),
    });

    const data = await response.json();

    const notices = (data.results || []).map((page) => ({
      id: page.id,
      title: page.properties['제목']?.title?.[0]?.plain_text || '',
      date: page.properties['날짜']?.date?.start || '',
      badge: page.properties['뱃지']?.select?.name || '공지',
      content: page.properties['내용']?.rich_text?.[0]?.plain_text || '',
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(notices),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
