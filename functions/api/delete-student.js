// POST /api/delete-student  (admin only)
// 학생 한 명에 대해 Notion 학생/리포트 archive + R2 reports/{이름}/ 폴더 삭제
// body: { name }
const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';
const REPORTS_DB  = '82ef896dcf844c5b9c36f7e0ff0a97f2';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const name = (body.name || '').trim();
  if (!name) return Response.json({ error: '학생 이름이 필요합니다' }, { status: 400 });

  const headers = {
    Authorization:    `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  };

  const result = { name, students_archived: 0, reports_archived: 0, files_deleted: 0, errors: [] };

  try {
    // 1. Notion 학생 DB에서 학생 검색 → archive
    const sRes = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({ filter: { property: '이름', title: { equals: name } } }),
    });
    const sData = await sRes.json();
    for (const page of (sData.results || [])) {
      const ar = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ archived: true }),
      });
      if (ar.ok) result.students_archived++;
      else result.errors.push(`student page ${page.id}: ${ar.status}`);
    }

    // 2. Notion 리포트 DB에서 해당 학생 이름 리포트 검색 → archive
    const rRes = await fetch(`https://api.notion.com/v1/databases/${REPORTS_DB}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({ filter: { property: '학생 이름', rich_text: { equals: name } } }),
    });
    const rData = await rRes.json();
    for (const page of (rData.results || [])) {
      const ar = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ archived: true }),
      });
      if (ar.ok) result.reports_archived++;
      else result.errors.push(`report page ${page.id}: ${ar.status}`);
    }

    // 3. R2 reports/{이름}/ 폴더의 모든 파일 삭제
    const listed = await env.BUCKET.list({ prefix: `reports/${name}/`, limit: 500 });
    for (const obj of (listed.objects || [])) {
      try {
        await env.BUCKET.delete(obj.key);
        result.files_deleted++;
      } catch (e) {
        result.errors.push(`file ${obj.key}: ${e.message}`);
      }
    }

    return Response.json({ ok: true, ...result });
  } catch (e) {
    return Response.json({ ok: false, error: e.message, ...result }, { status: 500 });
  }
}
