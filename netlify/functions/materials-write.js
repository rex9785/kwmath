// 파일 업로드 완료 후 노션 자료실 DB에 메타데이터 저장
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = '34f134c4b2324685a62357c27c0aa919';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { password, title, fileName, r2Key, category, fileSize, phone4 } = body;

    if (password !== ADMIN_PASSWORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 실패' }) };
    }

    const isPublic = !phone4; // 전화번호 없으면 공개
    const today = new Date().toISOString().split('T')[0];

    const properties = {
      '제목': { title: [{ text: { content: title || fileName || '파일' } }] },
      '파일명': { rich_text: [{ text: { content: fileName || '' } }] },
      'R2키': { rich_text: [{ text: { content: r2Key || '' } }] },
      '카테고리': category ? { select: { name: category } } : {},
      '파일크기': { rich_text: [{ text: { content: fileSize || '' } }] },
      '업로드일': { date: { start: today } },
      '공개': { checkbox: isPublic },
    };

    if (phone4) {
      properties['전화번호끝4자리'] = { rich_text: [{ text: { content: phone4 } }] };
    }

    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ parent: { database_id: DATABASE_ID }, properties }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '노션 저장 실패');

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, pageId: data.id }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
