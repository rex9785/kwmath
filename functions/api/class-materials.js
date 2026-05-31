// GET /api/class-materials?key=... — 개인 키 인증 후 그 반 자료 목록
// 학생/반 조회: Cloudflare D1 (이전엔 Notion). 자료 목록: Notion 자료 DB(유지).
import { safeError } from './_errors.js';

const MATERIALS_DB = '34f134c4b2324685a62357c27c0aa919';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const key = (url.searchParams.get('key') || '').trim();
  if (!key) return Response.json({ error: '키가 필요합니다' }, { status: 400 });

  try {
    const st = await env.DB.prepare('SELECT name, class_name FROM students WHERE personal_key = ? LIMIT 1').bind(key).first();
    if (!st) return Response.json({ error: '인증 실패' }, { status: 401 });
    const studentName = st.name || '';
    const className = st.class_name || '';
    if (!className) return Response.json({ error: '배정된 반이 없습니다. 선생님께 문의하세요.' }, { status: 403 });

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
  } catch (e) {
    return safeError(e, env, { message: '자료를 불러오지 못했습니다.' });
  }
}
