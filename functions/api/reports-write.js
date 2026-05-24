const DB = '82ef896dcf844c5b9c36f7e0ff0a97f2';
const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';

// 학생 이름으로 학부모 휴대폰 가져오기 (푸쉬 발송용)
async function findParentPhone(env, studentName) {
  if (!studentName) return null;
  try {
    const res = await fetch('https://api.notion.com/v1/databases/' + STUDENTS_DB + '/query', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.NOTION_TOKEN, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: { property: '이름', title: { equals: studentName } },
        page_size: 1
      }),
    });
    const data = await res.json();
    if (!data.results || !data.results.length) return null;
    const props = data.results[0].properties || {};
    const phone = ((props['학부모 휴대폰']?.rich_text || [])[0]?.plain_text || '').trim();
    return phone || null;
  } catch (e) {
    return null;
  }
}

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

    // 푸쉬 알림 발송 (비치명적 — 실패해도 리포트 생성은 성공으로 처리)
    try {
      const parentPhone = await findParentPhone(env, studentName);
      if (parentPhone) {
        await fetch(new URL('/api/push-send', request.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: env.ADMIN_PASSWORD,
            userId: parentPhone,
            title: '📋 새 수업 리포트가 올라왔어요',
            body: studentName + ' 학생 — ' + date + ' 수업 내용을 확인해보세요',
            url: '/portal?tab=report',
            tag: 'report-' + studentName + '-' + date
          }),
        });
      }
    } catch (e) { /* 무시 */ }

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
      const msg = (err.message || '').toLowerCase();
      if (msg.includes('archived') || msg.includes('in_trash') || msg.includes('trash')) {
        return Response.json({ error: '이 리포트는 이미 휴지통에 있어 수정할 수 없습니다. 새로고침 후 다시 확인해주세요.' }, { status: 400 });
      }
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
      const msg = (err.message || '').toLowerCase();
      // 이미 archived/in_trash 상태면 효과 동일 → 성공으로 처리
      if (msg.includes('archived') || msg.includes('in_trash') || msg.includes('trash')) {
        return Response.json({ ok: true, alreadyArchived: true });
      }
      return Response.json({ error: err.message || 'Notion 삭제 실패' }, { status: res.status });
    }
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
