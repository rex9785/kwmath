// 개인 키로 학생 인증 → 반 정보 반환
const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  const { key } = await request.json();
  if (!key?.trim()) return Response.json({ error: '키를 입력해주세요' }, { status: 400 });

  const res = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter: { property: '개인키', rich_text: { equals: key.trim() } } }),
  });
  const data = await res.json();
  if (!data.results?.length) return Response.json({ error: '등록되지 않은 키입니다' }, { status: 401 });

  const student = data.results[0];
  const name = student.properties['이름']?.title?.[0]?.plain_text || '';
  const className = student.properties['반']?.select?.name || '';

  return Response.json({ ok: true, name, className });
}
