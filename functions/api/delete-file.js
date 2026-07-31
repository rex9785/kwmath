// R2 파일 삭제 (native R2 binding)
import { logAudit } from './_auditlog.js';

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

  // 🔎 2026-07-31 — 지우기 전에 파일 정보를 읽는다(head = 본문 안 받고 크기·업로드시각만).
  //    예전엔 아무 기록 없이 지워서, 자료가 사라졌을 때 "누가 언제 뭘 지웠나"를 알 길이 없었다.
  //    R2 객체는 휴지통이 없다 — 지우면 끝이다.
  let head = null;
  try { head = await env.BUCKET.head(key); } catch (_) {}

  await env.BUCKET.delete(key);

  const 정리된노션 = [];

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
        정리된노션.push(p.id);
      }
    } catch (_) { /* R2 삭제는 이미 성공 — Notion 정리는 best-effort */ }
  }

  await logAudit(env, request, {
    action: 'file.delete',
    target: String(key).slice(0, 200),
    targetName: String(key).split('/').pop() || '',
    summary: '파일 삭제 [' + key + ']' + (head ? ' · ' + Math.round((head.size || 0) / 1024) + 'KB' : ' · (삭제 전 정보 못 읽음)')
      + (정리된노션.length ? ' · 노션 자료 ' + 정리된노션.length + '건 정리' : '') + ' — 복구 불가',
    detail: {
      R2키: key,
      분류: keyRoot,
      파일: head ? {
        크기바이트: head.size || 0,
        업로드시각: (head.uploaded && head.uploaded.toISOString) ? head.uploaded.toISOString() : String(head.uploaded || ''),
        타입: (head.httpMetadata && head.httpMetadata.contentType) || '',
        etag: head.etag || '',
      } : '(head 실패 — 이미 없었거나 R2 오류)',
      노션정리: 정리된노션,
      비고: 'R2는 휴지통이 없다 — 이 로그가 무엇이 사라졌는지의 유일한 기록',
    },
  });

  return Response.json({ ok: true });
}
