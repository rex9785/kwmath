const DB = '82ef896dcf844c5b9c36f7e0ff0a97f2';

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  const headers = { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

  // ── 신규 생성 ──
  if (request.method === 'POST') {
    const { studentName, phone4, date, school, content, homework, notes } = await request.json();
    if (!studentName || !phone4 || !date)
      return Response.json({ error: '학생 이름, 전화번호 끝 4자리, 수업 날짜는 필수입니다.' }, { status: 400 });

    const title = `${studentName} - ${date} 수업 리포트`;
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST', headers,
      body: JSON.stringify({ parent: { database_id: DB }, properties: {
        '리포트 제목':        { title:     [{ text: { content: title } }] },
        '학생 이름':          { rich_text: [{ text: { content: studentName } }] },
        '전화번호 끝 4자리':  { rich_text: [{ text: { content: phone4 } }] },
        '수업 날짜':          { date:      { start: date } },
        '학원':               { select:    { name: school || '대치동 정규반' } },
        '수업 내용':          { rich_text: [{ text: { content: content || '' } }] },
        '숙제':               { rich_text: [{ text: { content: homework || '' } }] },
        '특이사항':           { rich_text: [{ text: { content: notes || '' } }] },
        '공개':               { checkbox:  true },
      }}),
    });
    const data = await res.json();
    if (data.object === 'error') return Response.json({ error: data.message }, { status: 500 });
    return Response.json({ ok: true, id: data.id });
  }

  // ── 수정 ──
  if (request.method === 'PATCH') {
    const { pageId, date, school, content, homework, notes } = await request.json();
    if (!pageId) return Response.json({ error: 'pageId 필요' }, { status: 400 });
    const properties = {};
    if (typeof date     === 'string' && date)     properties['수업 날짜'] = { date: { start: date } };
    if (typeof school   === 'string' && school)   properties['학원']      = { select: { name: school } };
    if (typeof content  === 'string')             properties['수업 내용'] = { rich_text: [{ text: { content } }] };
    if (typeof homework === 'string')             properties['숙제']      = { rich_text: [{ text: { content: homework } }] };
    if (typeof notes    === 'string')             properties['특이사항']  = { rich_text: [{ text: { content: notes } }] };

    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ properties }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return Response.json({ error: err.message || 'Notion 수정 실패' }, { status: res.status });
    }
    return Response.json({ ok: true });
  }

  // ── 삭제(archive) ──
  if (request.method === 'DELETE') {
    const { pageId } = await request.json();
    if (!pageId) return Response.json({ error: 'pageId 필요' }, { status: 400 });
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ archived: true }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return Response.json({ error: err.message || 'Notion 삭제 실패' }, { status: res.status });
    }
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
