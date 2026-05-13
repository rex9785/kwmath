// 학생 개인키 변경
const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  const { currentKey, newKey } = await request.json();
  if (!currentKey || !newKey) return Response.json({ error: '키를 입력해주세요' }, { status: 400 });
  if (newKey.trim().length < 4) return Response.json({ error: '새 키는 4자 이상이어야 합니다' }, { status: 400 });

  const headers = { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

  // 현재 키로 학생 찾기
  const res = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({ filter: { property: '개인키', rich_text: { equals: currentKey.trim() } } }),
  });
  const data = await res.json();
  if (!data.results?.length) return Response.json({ error: '현재 키가 올바르지 않습니다' }, { status: 401 });

  // 새 키 중복 확인
  const dupRes = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({ filter: { property: '개인키', rich_text: { equals: newKey.trim() } } }),
  });
  const dupData = await dupRes.json();
  if (dupData.results?.length) return Response.json({ error: '이미 사용 중인 키입니다. 다른 키를 선택해주세요.' }, { status: 409 });

  // 키 업데이트
  const pageId = data.results[0].id;
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ properties: { '개인키': { rich_text: [{ text: { content: newKey.trim() } }] } } }),
  });

  return Response.json({ ok: true });
}
