// 개인 키로 인증 후 해당 반 자료 목록 반환
const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';
const MATERIALS_DB = '34f134c4b2324685a62357c27c0aa919';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key) return Response.json({ error: '키가 필요합니다' }, { status: 400 });

  // 1. 키로 학생 찾기
  const sRes = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter: { property: '개인키', rich_text: { equals: key.trim() } } }),
  });
  const sData = await sRes.json();
  if (!sData.results?.length) return Response.json({ error: '인증 실패' }, { status: 401 });

  const student = sData.results[0];
  const studentName = student.properties['이름']?.title?.[0]?.plain_text || '';
  const className = student.properties['반']?.select?.name || '';
  if (!className) return Response.json({ error: '배정된 반이 없습니다. 선생님께 문의하세요.' }, { status: 403 });

  // 2. 해당 반 자료 가져오기
  const mRes = await fetch(`https://api.notion.com/v1/databases/${MATERIALS_DB}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: { property: '반', select: { equals: className } },
      sorts: [{ property: '업로드일', direction: 'descending' }],
    }),
  });
  const mData = await mRes.json();
  const files = (mData.results || []).map(p => ({
    id: p.id,
    title: p.properties['제목']?.title?.[0]?.plain_text || '',
    fileName: p.properties['파일명']?.rich_text?.[0]?.plain_text || '',
    r2Key: p.properties['R2키']?.rich_text?.[0]?.plain_text || '',
    category: p.properties['카테고리']?.select?.name || '',
    fileSize: p.properties['파일크기']?.rich_text?.[0]?.plain_text || '',
    uploadDate: p.properties['업로드일']?.date?.start || '',
  }));

  return Response.json({ ok: true, studentName, className, files });
}
