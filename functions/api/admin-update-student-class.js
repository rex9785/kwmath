// POST /api/admin-update-student-class (admin only)
// body: { studentId, academy, className }
// 효과: Notion 학생 페이지의 "학원" + "반" select 필드 PATCH
// 변경 로그를 "특이사항" 칸 뒤에 자동 append

const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const studentId = (body.studentId || '').toString().trim();
  const academy   = (body.academy   || '').toString().trim();
  const className = (body.className || '').toString().trim();

  if (!studentId) return Response.json({ error: 'studentId 필수' }, { status: 400 });
  if (!academy && !className) return Response.json({ error: 'academy 또는 className 중 하나 이상 필요' }, { status: 400 });

  const headers = {
    Authorization:    `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  };

  try {
    // 현재 학생 페이지 조회 (변경 전 값 확보 — 로그용)
    const getRes = await fetch(`https://api.notion.com/v1/pages/${studentId}`, {
      method: 'GET', headers,
    });
    if (!getRes.ok) {
      const eb = await getRes.json().catch(() => ({}));
      return Response.json({ error: '학생 페이지 조회 실패: ' + (eb.message || getRes.status) }, { status: 404 });
    }
    const page = await getRes.json();
    const oldAcademy   = page.properties?.['학원']?.select?.name || '';
    const oldClassName = page.properties?.['반']?.select?.name || '';
    const oldName      = (page.properties?.['이름']?.title || [])[0]?.plain_text || '';
    const oldNotes     = (page.properties?.['특이사항']?.rich_text || [])[0]?.plain_text || '';

    // 변경 사항 없으면 그냥 OK 반환
    if (oldAcademy === academy && oldClassName === className) {
      return Response.json({ ok: true, noChange: true, academy, className });
    }

    // 변경 로그 메시지
    const now = new Date().toISOString().slice(0, 10);
    const logLine = `[${now}] 학원/반 변경: ${oldAcademy || '?'}/${oldClassName || '?'} → ${academy || oldAcademy}/${className || oldClassName}`;
    const newNotes = oldNotes ? oldNotes + '\n' + logLine : logLine;

    // PATCH properties
    const newProps = {
      '특이사항': { rich_text: [{ text: { content: newNotes } }] },
    };
    if (academy)   newProps['학원'] = { select: { name: academy } };
    if (className) newProps['반']   = { select: { name: className } };

    const ar = await fetch(`https://api.notion.com/v1/pages/${studentId}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ properties: newProps }),
    });
    if (!ar.ok) {
      const eb = await ar.json().catch(() => ({}));
      return Response.json({ error: '학원/반 변경 실패: ' + (eb.message || ar.status) }, { status: 500 });
    }

    return Response.json({
      ok: true,
      name: oldName,
      from: { academy: oldAcademy, className: oldClassName },
      to:   { academy: academy || oldAcademy, className: className || oldClassName },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
