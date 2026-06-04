// R2 파일 삭제 (native R2 binding)
export async function onRequest({ request, env }) {
  if (request.method !== 'DELETE' && request.method !== 'POST')
    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  const { key } = await request.json();
  if (!key) return Response.json({ error: 'key 필요' }, { status: 400 });

  // 경로 보호: auth/·video-codes/·push-subs/ 등 운영 경로 및 상위경로(..) 삭제 차단
  const keyRoot = String(key).replace(/^\/+/, '').split('/')[0];
  if (String(key).includes('..') || ['auth', 'video-codes', 'push-subs', 'tokens'].includes(keyRoot))
    return Response.json({ error: '허용되지 않은 경로입니다.' }, { status: 403 });

  await env.BUCKET.delete(key);

  // 공개 자료(materials/)는 Notion 자료 DB 항목도 함께 제거 (homepage가 Notion을 읽으므로)
  if (key.startsWith('materials/') && env.NOTION_TOKEN) {
    try {
      const MATERIALS_DB = '34f134c4b2324685a62357c27c0aa919';
      const q = await fetch(`https://api.notion.com/v1/databases/${MATERIALS_DB}/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter: { property: 'R2키', rich_text: { equals: key } } }),
      });
      const qd = await q.json();
      for (const p of (qd.results || [])) {
        await fetch(`https://api.notion.com/v1/pages/${p.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: true }),
        });
      }
    } catch (_) { /* R2 삭제는 이미 성공 — Notion 정리는 best-effort */ }
  }

  return Response.json({ ok: true });
}
