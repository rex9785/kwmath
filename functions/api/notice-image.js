// GET /api/notice-image?key=notices/...
// 공지사항에 첨부된 이미지를 인라인으로 제공 (공개 — 메인 홈피 공지에서 <img>로 표시).
// download-file.js는 attachment(다운로드)라 <img> 표시에 부적합 → 이미지 전용 인라인 엔드포인트.
// 안전: notices/ 프리픽스만 허용(다른 R2 경로 노출 차단).

const ALLOWED_PREFIX = 'notices/';
const TYPE_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp',
};

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';

  if (!key || !key.startsWith(ALLOWED_PREFIX) || key.includes('..')) {
    return Response.json({ error: '잘못된 경로입니다.' }, { status: 400 });
  }

  const object = await env.BUCKET.get(key);
  if (!object) return Response.json({ error: '이미지를 찾을 수 없습니다.' }, { status: 404 });

  const ext = (key.split('.').pop() || '').toLowerCase();
  const contentType = object.httpMetadata?.contentType || TYPE_BY_EXT[ext] || 'image/jpeg';

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
