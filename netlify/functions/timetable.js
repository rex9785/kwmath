exports.handler = async function (event, context) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = 'e06ead6fdd61424688f15bbb35003c97';

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
      }),
    });

    const data = await response.json();

    const classes = (data.results || []).map((page) => ({
      id: page.id,
      name: page.properties['반 이름']?.title?.[0]?.plain_text || '',
      school: page.properties['학원']?.select?.name || '',
      days: (page.properties['요일']?.multi_select || []).map((d) => d.name),
      time: page.properties['시간']?.rich_text?.[0]?.plain_text || '',
      target: page.properties['대상']?.rich_text?.[0]?.plain_text || '',
      memo: page.properties['메모']?.rich_text?.[0]?.plain_text || '',
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(classes),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
