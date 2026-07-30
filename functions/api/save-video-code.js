import { safeError } from './_errors.js';
// POST /api/save-video-code
// MathOS에서 수업 영상 코드를 R2에 저장
export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  let body = {};
  try { body = await request.json(); } catch {}

  const password = body.password || '';
  if (password !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  const code        = (body.code        || '').trim().toUpperCase();
  const youtubeUrl  = (body.youtube_url || '').trim();
  const title       = (body.title       || '').trim();
  const date        = (body.date        || '').trim();
  const school      = (body.school      || '').trim();
  const className   = (body.class_name  || '').trim();
  const requireCode = body.require_code === true;

  if (!code)       return Response.json({ error: 'code 필요' }, { status: 400 });
  if (!youtubeUrl) return Response.json({ error: 'youtube_url 필요' }, { status: 400 });

  const data = {
    code,
    youtube_url: youtubeUrl,
    title,
    date,
    school,
    class_name: className,
    active: true,
    require_code: requireCode,
    created_at: new Date().toISOString(),
    access_log: [],
    access_count: 0,
  };

  try {
    await env.BUCKET.put(`video-codes/${code}.json`, JSON.stringify(data), {
      httpMetadata: { contentType: 'application/json' },
    });

    // ── 재업로드 대체 규칙 (2026-07-30 관우T 확정: "무조건 새로 올린 거 기준으로 — 영상도"): ──
    //   같은 학원+반+수업날짜의 옛 코드를 전부 삭제해 항상 최신 업로드 1건만 남긴다.
    //   (전엔 재업로드마다 새 랜덤 코드가 쌓여 학생 영상 목록·MathOS 타임라인에 같은 날짜가 2줄씩 떴음.
    //    리포트는 reports-write.js:34 가드로 이미 최신 1건 유지 — 이제 영상도 같은 규칙.)
    //   순서 의도: 새 코드 저장 "성공 후"에만 옛 것을 지운다 — 저장 실패 시 옛 영상이 그대로 남아 안전.
    //   삭제 실패는 비치명(중복이 잠깐 남을 뿐, 다음 재업로드 때 다시 정리됨).
    //   비교 규칙은 class-videos.js의 norm과 동일(공백·괄호 차이 흡수) — 두 파일이 어긋나면 안 됨.
    //   ⚠️ 한계(의도): 같은 반이 같은 날짜에 서로 다른 영상 2편을 일부러 올리는 경우도 앞 편이 대체된다.
    //   ⚠️ 옛 코드의 access_log(열람 기록)도 파일과 함께 삭제된다.
    let replaced = 0;
    if (date && school && className) {
      const norm = (s) => (s || '').toString().replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();
      try {
        const listed = await env.BUCKET.list({ prefix: 'video-codes/' });
        for (const obj of listed.objects) {
          if (obj.key === `video-codes/${code}.json`) continue;   // 방금 저장한 새 코드는 보존
          try {
            const item = await env.BUCKET.get(obj.key);
            if (!item) continue;
            const old = await item.json();
            if ((old.date || '').trim() === date &&
                norm(old.school) === norm(school) &&
                norm(old.class_name) === norm(className)) {
              await env.BUCKET.delete(obj.key);
              replaced++;
            }
          } catch { /* 개별 파일 오류 무시 */ }
        }
      } catch { /* 목록 조회 실패 시 대체 생략 — 다음 업로드 때 정리 */ }
    }

    return Response.json({ ok: true, code, replaced });
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
