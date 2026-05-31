import { safeError } from './_errors.js';
// GET  /api/video-access?code=XXX          → 영상 URL 반환
// POST /api/video-access { code, name }    → 접근 기록 저장

export async function onRequest({ request, env }) {
  const url = new URL(request.url);

  // ── GET: 코드로 영상 조회 ──────────────────────────────
  if (request.method === 'GET') {
    const code = (url.searchParams.get('code') || '').trim().toUpperCase();
    if (!code)
      return Response.json({ error: '코드를 입력해주세요.' }, { status: 400 });

    try {
      const obj = await env.BUCKET.get(`video-codes/${code}.json`);
      if (!obj)
        return Response.json({ error: '유효하지 않은 코드입니다.' }, { status: 404 });

      const data = await obj.json();
      if (!data.active)
        return Response.json({ error: '비활성화된 코드입니다.' }, { status: 403 });

      return Response.json({
        ok: true,
        youtube_url: data.youtube_url,
        title:       data.title,
        date:        data.date,
        school:      data.school,
        class_name:  data.class_name,
        access_count: data.access_count || 0,
      });
    } catch (e) {
      return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  }

  // ── POST: 접근 기록 저장 ───────────────────────────────
  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}

    const code = (body.code || '').trim().toUpperCase();
    const name = (body.name || '').trim();
    if (!code)
      return Response.json({ error: 'code 필요' }, { status: 400 });

    try {
      const obj = await env.BUCKET.get(`video-codes/${code}.json`);
      if (!obj)
        return Response.json({ error: '코드 없음' }, { status: 404 });

      const data = await obj.json();
      const log  = data.access_log || [];

      // 중복 방지: 같은 이름+코드는 5분 이내 재접근 무시
      const now = Date.now();
      const recent = log.find(l => l.name === name && now - new Date(l.time).getTime() < 5 * 60 * 1000);
      if (!recent) {
        log.push({ name: name || '익명', time: new Date().toISOString() });
      }

      data.access_log   = log;
      data.access_count = log.length;

      await env.BUCKET.put(`video-codes/${code}.json`, JSON.stringify(data), {
        httpMetadata: { contentType: 'application/json' },
      });

      return Response.json({ ok: true });
    } catch (e) {
      return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}
