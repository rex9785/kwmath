const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';
const REPORTS_DB = '82ef896dcf844c5b9c36f7e0ff0a97f2';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const name   = (url.searchParams.get('name')   || '').trim();
  const phone4 = (url.searchParams.get('phone4') || '').trim();

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;

  if (!isAdmin) {
    // 일반 학부모 인증: 이름 + phone4 필수
    if (!name || !phone4 || phone4.length !== 4)
      return Response.json({ error: '이름과 전화번호 끝 4자리를 입력해주세요.' }, { status: 400 });
  } else {
    // admin: name이 없으면 phone4만으로 조회할 이름이 없으므로 name 필요
    if (!name)
      return Response.json({ error: '학생 이름을 입력해주세요.' }, { status: 400 });
  }

  try {
    if (!isAdmin) {
      // 1. 이름 + phone4로 학생 확인 (학부모 전용)
      const sRes = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter: { and: [
          { property: '이름',                  title:     { equals: name   } },
          { property: '학부모 연락처 끝4자리', rich_text: { equals: phone4 } },
        ]}}),
      });
      const sData = await sRes.json();
      if (!sData.results?.length)
        return Response.json({ error: '이름 또는 전화번호가 일치하지 않습니다.' }, { status: 401 });
    }

    // 2. 학생 이름으로 공개 리포트 조회
    const res = await fetch(`https://api.notion.com/v1/databases/${REPORTS_DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { and: [
        { property: '공개',     checkbox:  { equals: true } },
        { property: '학생 이름', rich_text: { equals: name } },
      ]}, sorts: [{ property: '수업 날짜', direction: 'descending' }] }),
 