import { safeError } from './_errors.js';
// GET /api/video-list  (admin only)
// R2의 모든 video-codes JSON 목록 반환 — admin.html 영상 관리 탭용
export async function onRequest({ request, env }) {
  if (request.method !== 'GET')
    return Response.json({ error: 'GET만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  try {
    const listed = await env.BUCKET.list({ prefix: 'video-codes/', limit: 500 });
    const videos = [];
    for (const obj of listed.objects || []) {
      try {
        const item = await env.BUCKET.get(obj.key);
        if (!item) continue;
        const data = await item.json();
        videos.push({
          code:         data.code,
          youtube_url:  data.youtube_url,
          title:        data.title || '',
          date:         data.date || '',
          school:       data.school || '',
          class_name:   data.class_name || '',
          active:       data.active !== false,
          require_code: data.require_code === true,
          access_count: data.access_count || 0,
          access_log:   (data.access_log || []).slice(-30),  // 누가 봤는지(학부모/학생) 표시용, 최근 30개
          created_at:   data.created_at || '',
        });
      } catch {}
    }
    videos.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return Response.json({ ok: true, videos });
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
