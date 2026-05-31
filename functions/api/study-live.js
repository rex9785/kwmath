import { safeError } from './_errors.js';
// /api/study-live
// 같이 공부하는 친구 — 익명 라이브
// 
// 데이터: R2 study-live/{phone}.json  
//   { phone, name, academy, className, lastBeatAt: ISO }
//   TTL 5분 (5분 지나면 자동 무시)
//
// POST { } (학생 토큰)  
//   - heartbeat — 본인 살아있음 마킹. 학생만 가능 (학부모 X)
//
// GET (학생/학부모 토큰)
//   - 같은 반 (academy + className) 에서 5분 이내 활동한 사람 수 (익명)
//   - 응답: { ok, liveCount }
//   - 본인 제외 카운트

import { requireStudentAccess } from './_auth.js';

const LIVE_TTL_MS = 5 * 60 * 1000;  // 5분

function liveKey(phone) {
  return 'study-live/' + encodeURIComponent(phone) + '.json';
}

export async function onRequest({ request, env }) {
  const access = await requireStudentAccess(env, request);
  if (!access.ok) return access.response;
  const me = access.student;
  const phone = access.phone;

  if (request.method === 'POST') {
    // heartbeat — 학생 본인만
    if (me.role !== 'student') {
      return Response.json({ error: '학생 본인만 heartbeat 가능' }, { status: 403 });
    }
    const payload = {
      phone,
      name:      me.name || '',
      academy:   me.academy || '',
      className: me.className || '',
      lastBeatAt: new Date().toISOString(),
    };
    try {
      await env.BUCKET.put(liveKey(phone), JSON.stringify(payload), {
        httpMetadata: { contentType: 'application/json' },
      });
      return Response.json({ ok: true });
    } catch (e) {
      return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  }

  if (request.method === 'GET') {
    // 같은 반 라이브 카운트 (익명)
    const targetAcademy = me.academy || '';
    const targetClass   = me.className || '';
    if (!targetAcademy || !targetClass) {
      return Response.json({ ok: true, liveCount: 0, note: '학원/반 정보 없음' });
    }

    try {
      const listed = await env.BUCKET.list({ prefix: 'study-live/', limit: 500 });
      const now = Date.now();
      let liveCount = 0;
      for (const obj of (listed.objects || [])) {
        try {
          const o = await env.BUCKET.get(obj.key);
          if (!o) continue;
          const rec = JSON.parse(await o.text());
          if (!rec || !rec.lastBeatAt) continue;
          const beatTs = Date.parse(rec.lastBeatAt);
          if (now - beatTs > LIVE_TTL_MS) continue;  // 5분 지남
          if (rec.academy !== targetAcademy) continue;
          if (rec.className !== targetClass) continue;
          if (rec.phone === phone) continue;  // 본인 제외
          liveCount++;
        } catch {}
      }
      return Response.json({ ok: true, liveCount, academy: targetAcademy, className: targetClass });
    } catch (e) {
      return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
