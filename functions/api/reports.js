const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';
const REPORTS_DB  = '82ef896dcf844c5b9c36f7e0ff0a97f2';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const name   = (url.searchParams.get('name')   || '').trim();
  const phone4 = (url.searchParams.get('phone4') || '').trim();

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;

  if (!isAdmin) {
    if (!name || !phone4 || phone4.length !== 4)
      return Response.json({ error: '이름과 전화번호 끝 4자리를 입력해주세요.' }, { status: 400 });
  }

  const headers = { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
  const richText  = (rt) => (rt || []).map(t => t.plain_text || '').join('');
  const titleText = (rt) => (rt || []).map(t => t.plain_text || '').join('');

  try {
    let studentInfo = null;

    // 학부모 모드: 학생 인증 + 학원/반 정보 추출
    if (!isAdmin) {
      const sRes = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({ filter: { and: [
          { property: '이름',                  title:     { equals: name   } },
          { property: '학부모 연락처 끝4자리', rich_text: { equals: phone4 } },
        ]}}),
      });
      const sData = await sRes.json();
      if (!sData.results?.length)
        return Response.json({ error: '이름 또는 전화번호가 일치하지 않습니다.' }, { status: 401 });
      const sp = sData.results[0].properties || {};
      studentInfo = {
        name,
        school:     sp['학원']?.select?.name || '',
        class_name: sp['반']?.select?.name || '',
      };
    }

    // 리포트 DB 조회 — admin이면 전체, 학부모면 본인 학생만
    const reportsFilter = isAdmin && !name
      ? { property: '공개', checkbox: { equals: true } }
      : { and: [
          { property: '공개',     checkbox:  { equals: true } },
          { property: '학생 이름', rich_text: { equals: name } },
        ]};

    const res = await fetch(`https://api.notion.com/v1/databases/${REPORTS_DB}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({ filter: reportsFilter, sorts: [{ property: '수업 날짜', direction: 'descending' }], page_size: 100 }),
    });
    const data = await res.json();
    if (data.object === 'error') return Response.json({ error: data.message || 'Notion 조회 실패' }, { status: 500 });

    let reports = (data.results || []).map(page => {
      const p = page.properties || {};
      return {
        id:          page.id,
        title:       titleText(p['리포트 제목']?.title),
        studentName: richText(p['학생 이름']?.rich_text),
        phone4:      richText(p['전화번호 끝 4자리']?.rich_text),
        date:        p['수업 날짜']?.date?.start || '',
        school:      p['학원']?.select?.name || '',
        content:     richText(p['수업 내용']?.rich_text),
        homework:    richText(p['숙제']?.rich_text),
        notes:       richText(p['특이사항']?.rich_text),
        class_name:  '',  // admin 모드에서 학생 DB join 후 채움
      };
    });

    // admin 전체 조회 모드 — 각 리포트에 학생의 반 정보 join
    if (isAdmin && !name && reports.length) {
      const uniqueNames = [...new Set(reports.map(r => r.studentName).filter(Boolean))];
      const nameToClass = {};
      // Notion 학생 DB는 데이터양이 적으니 한 번에 다 가져옴
      const sRes = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({ page_size: 100 }),
      });
      const sData = await sRes.json();
      (sData.results || []).forEach(s => {
        const sp = s.properties || {};
        const sn = titleText(sp['이름']?.title);
        if (sn) nameToClass[sn] = {
          school:     sp['학원']?.select?.name || '',
          class_name: sp['반']?.select?.name || '',
        };
      });
      reports = reports.map(r => {
        const info = nameToClass[r.studentName] || {};
        return {
          ...r,
          class_name: info.class_name || '',
          school:     r.school || info.school || '',
        };
      });
    }

    return Response.json({ student: studentInfo, reports });

  } catch (err) {
    return Response.json({ error: '서버 오류: ' + err.message }, { status: 500 });
  }
}
