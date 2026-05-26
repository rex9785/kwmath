// POST /api/delete-student  (admin only)
// 학생 한 명에 대해 Notion 학생/리포트 archive + R2 reports/{이름}/ 폴더 삭제
// body: { name }
const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';
const REPORTS_DB  = '82ef896dcf844c5b9c36f7e0ff0a97f2';
const ACCOUNTS_DB = '893a626479514059ae309a269b3661b5';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const name = (body.name || '').trim();
  const studentId = (body.studentId || '').trim();
  // 모드:
  //   - studentId 만: enrollment-only 모드 (그 학생 페이지만 archive, 리포트/계정 손대지 않음)
  //   - name 만: 전체 퇴원 (기존 동작, 같은 이름의 모든 enrollment + 리포트 + 계정 archive)
  if (!name && !studentId) return Response.json({ error: '학생 이름 또는 studentId 필요' }, { status: 400 });
  const enrollmentOnly = !!studentId && !name;

  const headers = {
    Authorization:    `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  };

  const result = { name: name || '', studentId: studentId || '', enrollmentOnly, students_archived: 0, reports_archived: 0, accounts_archived: 0, files_deleted: 0, errors: [] };
  const phonesToArchive = new Set();

  try {
    // 1. Notion 학생 DB에서 학생 검색 → archive
    let sData;
    if (enrollmentOnly) {
      // studentId 모드: 그 페이지만
      const pRes = await fetch(`https://api.notion.com/v1/pages/${studentId}`, { headers });
      const pData = await pRes.json();
      if (pData.object === 'error') {
        return Response.json({ error: '학생을 찾을 수 없습니다: ' + (pData.message || '') }, { status: 404 });
      }
      // name 추출 (R2 폴더 처리 안 하지만 result 표시용)
      result.name = (pData.properties?.['이름']?.title || [])[0]?.plain_text || '';
      sData = { results: [pData] };
    } else {
      const sRes = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({ filter: { property: '이름', title: { equals: name } } }),
      });
      sData = await sRes.json();
    }
    for (const page of (sData.results || [])) {
      // phone 정보 수집 (계정 archive용)
      try {
        const rt = (k) => (page.properties?.[k]?.rich_text || [])[0]?.plain_text || '';
        const pp = rt('학부모 휴대폰').trim();
        const sp = rt('학생 연락처').trim();
        if (pp) phonesToArchive.add(pp);
        if (sp) phonesToArchive.add(sp);
      } catch {}
      // 이미 archived면 그대로 두고 카운트만 — 노션이 거절해도 효과는 동일
      if (page.archived || page.in_trash) { result.students_archived++; continue; }
      const ar = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ archived: true }),
      });
      if (ar.ok) result.students_archived++;
      else {
        const errBody = await ar.json().catch(() => ({}));
        const msg = (errBody.message || '').toLowerCase();
        if (msg.includes('archived') || msg.includes('trash')) result.students_archived++;
        else result.errors.push(`student page ${page.id}: ${ar.status}`);
      }
    }

    // 2. Notion 리포트 DB에서 해당 학생 이름 리포트 검색 → archive
    const rRes = await fetch(`https://api.notion.com/v1/databases/${REPORTS_DB}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({ filter: { property: '학생 이름', rich_text: { equals: name } } }),
    });
    const rData = await rRes.json();
    for (const page of (rData.results || [])) {
      if (page.archived || page.in_trash) { result.reports_archived++; continue; }
      const ar = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ archived: true }),
      });
      if (ar.ok) result.reports_archived++;
      else {
        const errBody = await ar.json().catch(() => ({}));
        const msg = (errBody.message || '').toLowerCase();
        if (msg.includes('archived') || msg.includes('trash')) result.reports_archived++;
        else result.errors.push(`report page ${page.id}: ${ar.status}`);
      }
    }

    // 3. R2 reports/{이름}/ 폴더의 모든 파일 삭제 — enrollment-only 모드에선 스킵
    if (enrollmentOnly) {
      return Response.json({ ok: true, ...result });
    }
    const listed = await env.BUCKET.list({ prefix: `reports/${name}/`, limit: 500 });
    for (const obj of (listed.objects || [])) {
      try {
        await env.BUCKET.delete(obj.key);
        result.files_deleted++;
      } catch (e) {
        result.errors.push(`file ${obj.key}: ${e.message}`);
      }
    }

    // 4. 계정 DB — 수집된 학부모/학생 phone에 해당하는 계정 archive
    for (const phone of phonesToArchive) {
      try {
        const aRes = await fetch(`https://api.notion.com/v1/databases/${ACCOUNTS_DB}/query`, {
          method: 'POST', headers,
          body: JSON.stringify({ filter: { property: '휴대폰', title: { equals: phone } }, page_size: 5 }),
        });
        const aData = await aRes.json();
        for (const aPage of (aData.results || [])) {
          if (aPage.archived || aPage.in_trash) { result.accounts_archived++; continue; }
          const ar = await fetch(`https://api.notion.com/v1/pages/${aPage.id}`, {
            method: 'PATCH', headers,
            body: JSON.stringify({ archived: true }),
          });
          if (ar.ok) result.accounts_archived++;
          else {
            const errBody = await ar.json().catch(() => ({}));
            const msg = (errBody.message || '').toLowerCase();
            if (msg.includes('archived') || msg.includes('trash')) result.accounts_archived++;
            else result.errors.push(`account ${phone}: ${ar.status}`);
          }
        }
      } catch (e) {
        result.errors.push(`account ${phone}: ${e.message}`);
      }
    }

    return Response.json({ ok: true, ...result });
  } catch (e) {
    return Response.json({ ok: false, error: e.message, ...result }, { status: 500 });
  }
}
