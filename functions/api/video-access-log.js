// GET /api/video-access-log?password=XXX
// 모든 수업코드와 접근 로그를 관리자에게 반환

export async function onRequest({ request, env }) {
  if (request.method !== 'GET')
    return Response.json({ error: 'GET만 허용' }, { status: 405 });

  const url      = new URL(request.url);
  const password = url.searchParams.get('password') || '';

  if (password !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  try {
    // R2에서 video-codes/ 하위 파일 목록 조회
    const listed = await env.BUCKET.list({ prefix: 'video-codes/' });
    const results = [];

    for (const obj of listed.objects) {
      try {
        const item = await env.BUCKET.get(obj.key);
        if (item) {
          const data = await item.json();
          results.push({
            code:         data.code,
            title:        data.title,
            date:         data.date,
            school:       data.school,
            class_name:   data.class_name,
            youtube_url:  data.youtube_url,
            access_count: data.access_count || 0,
            access_log:   (data.access_log || []).slice(-20), // 최근 20개만
            created_at:   data.created_at,
            active:       data.active,
          });
        }
      } catch { /* 개별 파일 오류 무시 */ }
    }

    // 날짜 최신순 정렬
    results.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    return Response.json({ ok: true, codes: results });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
