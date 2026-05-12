exports.handler = async function (event, context) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DATABASE_ID = '9784fd34c91543c7b2c4cca4db1911aa';

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
        sorts: [{ property: '순서', direction: 'ascending' }],
      }),
    });

    const data = await response.json();

    const clips = (data.results || []).map((page) => ({
      id: page.id,
      title: page.properties['제목']?.title?.[0]?.plain_text || '',
      reelId: page.properties['인스타 릴스 ID']?.rich_text?.[0]?.plain_text || '',
      desc: page.properties['썸네일 설명']?.rich_text?.[0]?.plain_text || '',
      tags: (page.properties['주제 태그']?.multi_select || []).map((t) => t.name),
      order: page.properties['순서']?.number || 0,
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(clips),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
