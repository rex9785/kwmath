import { safeError } from './_errors.js';
import { bearerFromRequest, verifyToken, fetchStudentsByPhone } from './_auth.js';
// GET  /api/video-access?code=XXX               → 영상 URL 반환
// POST /api/video-access { code, name, via }     → 접근 기록 저장
//   Authorization: Bearer <userToken> (선택) — 있으면 학부모/학생 계정 식별해 로그에 기록

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
    const via  = (body.via || 'watch').toString();   // 'watch'(공개영상 시청) | 'code'(수업코드 입력)
    if (!code)
      return Response.json({ error: 'code 필요' }, { status: 400 });

    // 로그인 토큰이 있으면 어떤 계정(학부모/학생)이 눌렀는지 식별. 없으면 익명으로 기록(하위호환).
    let role = null, loginPhone = null;
    try {
      const token = bearerFromRequest(request);
      if (token) {
        const payload = await verifyToken(env, token);
        if (payload && payload.phone) {
          loginPhone = payload.phone;
          const students = await fetchStudentsByPhone(env, loginPhone);
          const matched = students.find(s => s.name === name);
          role = matched ? matched.role : null;   // 'student' | 'parent' | 'other' | null
        }
      }
    } catch (_) { /* 식별 실패해도 로그는 남긴다 */ }

    try {
      const obj = await env.BUCKET.get(`video-codes/${code}.json`);
      if (!obj)
        return Response.json({ error: '코드 없음' }, { status: 404 });

      const data = await obj.json();
      const log  = data.access_log || [];

      // 중복 방지: 같은 이름+계정(role)+코드는 5분 이내 재접근 무시.
      //   학부모와 학생은 role이 달라 각각 따로 카운트된다.
      const now = Date.now();
      const recent = log.find(l =>
        l.name === name &&
        (l.role || null) === (role || null) &&
        now - new Date(l.time).getTime() < 5 * 60 * 1000
      );
      if (!recent) {
        log.push({
          name:  name || '익명',
          role:  role,          // 학부모/학생 식별 (null = 비로그인·수업코드)
          phone: loginPhone,    // 로그인 계정 휴대폰 (관우T 식별용)
          via:   via,           // 'watch' | 'code'
          time:  new Date().toISOString(),
        });
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
