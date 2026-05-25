// POST /api/video-delete  (admin only)
// 영상 코드 R2 객체 삭제 — admin.html 영상 관리 탭의 🗑 삭제 버튼용
// body: { code }
export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}

  const code = (body.code || '').trim().toUpperCase();
  if (!code) return Response.json({ error: 'code 필요' }, { status: 400 });

  try {
    const key = `video-codes/${code}.json`;
    const obj = await env.BUCKET.get(key);
    if (!obj) return Response.json({ error: '해당 코드 영상 없음' }, { status: 404 });

    // 삭제 전에 메타데이터 한 번 더 읽어서 응답에 포함 (감사 로그용)
    let meta = null;
    try { meta = await obj.json(); } catch {}

    await env.BUCKET.delete(key);

    return Response.json({
      ok: true,
      code,
      deleted: {
        code,
        date:       meta?.date || '',
        school:     meta?.school || '',
        class_name: meta?.class_name || '',
        title:      meta?.title || '',
      },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
