// /api/cron-health — 크론(자동 스케줄러) 생존 점검. 원장 전용.
//   notices-flush가 매 틱 남기는 하트비트를 읽어, 마지막 실행 이후 경과분과 stale 여부를 반환.
//   admin.html이 로그인 때 호출해, 20분+ 신호가 없으면 상단 배너로 경보.
//   ※ 원장 전용 강제는 _middleware.js의 STAFF_GET_BLOCK('/api/cron-health')이 담당(조교 토큰 차단).
import { readHeartbeat } from './_heartbeat.js';
import { safeError } from './_errors.js';

// 5분 크론 기준. 20분(=4틱) 넘게 신호가 없으면 이상으로 본다.
const STALE_MIN = 20;

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) {
    return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });
  }
  try {
    const hb = await readHeartbeat(env);
    if (!hb || !hb.lastTick) {
      return Response.json({
        ok: true, lastTick: null, ageMinutes: null,
        stale: true, staleThresholdMin: STALE_MIN,
        reason: '하트비트 기록이 없습니다(아직 한 번도 안 돌았거나 크론이 멈춤).',
      });
    }
    const ageMs = Date.now() - new Date(hb.lastTick).getTime();
    const ageMinutes = Math.max(0, Math.round(ageMs / 60000));
    return Response.json({
      ok: true,
      lastTick: hb.lastTick,
      ageMinutes,
      stale: ageMinutes >= STALE_MIN,
      staleThresholdMin: STALE_MIN,
    });
  } catch (e) {
    return safeError(e, env, { message: '크론 상태 확인에 실패했습니다.' });
  }
}
