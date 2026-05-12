// 노션 자료실 DB에서 파일 목록 가져오기
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = '34f134c4b2324685a62357c27c0aa919';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const { phone4, category } = event.queryStringParameters || {};

    // 필터 구성
    let filter;
    if (phone4) {
      // 특정 학생의 파일 (학생 전용 + 공개 모두)
      filter = {
        or: [
          { property: '전화번호끝4자리', rich_text: { equals: phone4 } },
          {
            and: [
              { property: '공개', checkbox: { equals: true } },
              { property: '전화번호끝4자리', rich_text: { is_empty: true } },
            ],
          },
        ],
      };
    } else {
      // 공개 자료실
      filter = {
        and: [
          { property: '공개', checkbox: { equals: true } },
          { property: '전화번호끝4자리', rich_text: { is_empty: true } },
        ],
      };
    }

    if (category) {
      const catFilter = { property: '카테고리', select: { equals: category } };
      filter = filter.and
        ? { and: [...filter.and, catFilter] }
        : { and: [filter, catFilter] };
    }

    const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter,
        sorts: [{ property: '업로드일', direction: 'descending' }],
      }),
    });

    const data = await res.json();
    const files = (data.results || []).map((page) => ({
      id: page.id,
      title: page.properties['제목']?.title?.[0]?.plain_text || '',
      fileName: page.properties['파일명']?.rich_text?.[0]?.plain_text || '',
      r2Key: page.properties['R2키']?.rich_text?.[0]?.plain_text || '',
      category: page.properties['카테고리']?.select?.name || '',
      fileSize: page.properties['파일크기']?.rich_text?.[0]?.plain_text || '',
      uploadDate: page.properties['업로드일']?.date?.start || '',
      isPublic: page.properties['공개']?.checkbox || false,
    }));

    return { statusCode: 200, headers, body: JSON.stringify(files) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
