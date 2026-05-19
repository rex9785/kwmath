const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';
const REPORTS_DB = '82ef896dcf844c5b9c36f7e0ff0a97f2';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const key = (url.searchParams.get('key') || '').trim().toUpperCase();

  if (!key) return Response.json({ error: '개인 열람 코드를 입력해주세요.' }, { status: 400 });

  try {
    // 1. 개인키로 학생 이름 조회
    const sRes = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { property: '개인키', rich_text: { equals: key } } }),
    });
    const sData = await sRes.json();
    if (!sData.results?.length) return Response.json({ error: '등록되지 않은 코드입니다.' }, { status: 401 });

    const studentName = sData.results[0].properties['이름']?.title?.[0]?.plain_text || '';

    // 2. 학생 이름으로 공개 리포트 조회
    const res = await fetch(`https://api.notion.com/v1/databases/${REPORTS_DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { and: [
        { property: '공개', checkbox: { equals: true } },
        { property: '학생 이름', rich_text: { equals: studentName } },
      ]}, sorts: [{ property: '수업 날짜', direction: 'descending' }] }),
    });
    const data = await res.json();
    const reports = (data.results || []).map(p => ({
      id: p.id,
      title: p.properties['리포트 제목']?.title?.[0]?.plain_text || '',
      studentName,
      date: p.properties['수업 날짜']?.date?.start || '',
      school: p.properties['학원']?.select?.name || '',
      content: p.properties['수업 내용']?.rich_text?.[0]?.plain_text || '',
      homework: p.properties['숙제']?.rich_text?.[0]?.plain_text || '',
      notes: p.properties['특이사항']?.rich_text?.[0]?.plain_text || '',
    }));
    return Response.json(reports);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
