const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';
const REPORTS_DB = '82ef896dcf844c5b9c36f7e0ff0a97f2';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const name   = (url.searchParams.get('name')   || '').trim();
  const phone4 = (url.searchParams.get('phone4') || '').trim();

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;

  if (!isAdmin) {
    if (!name || !phone4 || phone4.length !== 4)
      return Response.json({ error: '이름과 전화번호 끝 4자리를 입력해주세요.' }, { status: 400 });
  } else {
    if (!name)
      return Response.json({ error: '학생 이름을 입력해주세요.' }, { status: 400 });
  }

  let studentInfo = null;
  try {
    if (!isAdmin) {
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
      // 학생 학원/반 정보 추출 — 학부모 페이지에서 반 공통 자료 조회용
      const sp = sData.results[0].properties || {};
      studentInfo = {
        name,
        school:     sp['학원']?.select?.name || '',
        class_name: sp['반']?.select?.name || '',
      };
    }

    const res = await fetch(`https://api.notion.com/v1/databases/${REPORTS_DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { and: [
        { property: '공개',     checkbox:  { equals: true } },
        { property: '학생 이름', rich_text: { equals: name } },
      ]}, sorts: [{ property: '수업 날짜', direction: 'descending' }] }),
    });
    const data = await res.json();

    if (data.object === 'error') {
      return Response.json({ error: data.message || 'Notion 조회 실패' }, { status: 500 });
    }

    const reports = (data.results || []).map(page => {
      const p = page.properties || {};
      const richText = (field) =>
        (p[field]?.rich_text || []).map(t => t.plain_text || '').join('');
      const titleText = (field) =>
        (p[field]?.title || []).map(t => t.plain_text || '').join('');
      const selectName = (field) => p[field]?.select?.name || '';

      return {
        id:          page.id,
        title:       titleText('리포트 제목'),
        studentName: richText('학생 이름'),
        date:        p['수업 날짜']?.date?.start || '',
        school:      selectName('학원'),
        content:     richText('수업 내용'),
        homework:    richText('숙제'),
        notes:       richText('특이사항'),
      };
    });

    return Response.json({ student: studentInfo, reports });

  } catch (err) {
    return Response.json({ error: '서버 오류: ' + err.message }, { status: 500 });
  }
}
