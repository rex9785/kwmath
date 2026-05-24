// GET /api/class-videos
//   Authorization: Bearer <userToken>   (학부모/학생 로그인 토큰)
//   ?name=홍길동  ← 자녀 여러 명일 때만 필요. 한 명이면 생략 OK
// 학생의 학원/반 영상 목록 반환 + 접근 로그 저장

import { requireStudentAccess } from './_auth.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET')
    return Response.json({ error: 'GET만 허용' }, { status: 405 });

  const access = await requireStudentAccess(env, request);
  if (!access.ok) return access.response;

  const { name, school, className } = {
    name: access.student.name,
    school: access.student.school,
    className: access.student.className,
  };

  if (!school)
    return Response.json({ error: '수강 정보가 등록되어 있지 않습니다. 선생님께 문의해주세요.' }, { status: 404 });

  try {
    // R2에서 해당 반의 영상 코드 목록 조회
    const listed = await env.BUCKET.list({ prefix: 'video-codes/' });
    const videos = [];

    for (const obj of listed.objects) {
      try {
        const item = await env.BUCKET.get(obj.key);
        if (!item) continue;
        const data = await item.json();
        const schoolMatch = data.school === school;
        const classMatch  = !className || data.class_name === className;
        if (schoolMatch && classMatch && data.active) {
          const locked = data.require_code === true;
          videos.push({
            code:        data.code,
            youtube_url: locked ? null : data.youtube_url,
            locked:      locked,
            title:       data.title,
            date:        data.date,
            school:      data.school,
            class_name:  data.class_name,
          });
        }
      } catch { /* 개별 파일 오류 무시 */ }
    }

    videos.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    if (!videos.length)
      return Response.json({ error: '등록된 수업 영상이 없습니다. 선생님께 문의해주세요.' }, { status: 404 });

    // 접근 로그 (최신 영상에만)
    const latestCode = videos[0].code;
    if (latestCode) {
      try {
        const logObj = await env.BUCKET.get(`video-codes/${latestCode}.json`);
        if (logObj) {
          const logData = await logObj.json();
          const log = logData.access_log || [];
          const now = Date.now();
          const recent = log.find(l => l.name === name && now - new Date(l.time).getTime() < 5 * 60 * 1000);
          if (!recent) {
            log.push({ name, time: new Date().toISOString() });
            logData.access_log   = log;
            logData.access_count = log.length;
            await env.BUCKET.put(`video-codes/${latestCode}.json`, JSON.stringify(logData), {
              httpMetadata: { contentType: 'application/json' },
            });
          }
        }
      } catch { /* 로그 실패해도 영상은 제공 */ }
    }

    return Response.json({
      ok:         true,
      student:    name,
      school,
      class_name: className,
      videos:     videos.slice(0, 10),
    });

  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
