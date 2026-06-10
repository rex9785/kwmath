// GET /api/outcomes  (admin only) — 퇴원생 기록 조회
// ───────────────────────────────────────────────────────────
// student_archive(실명·전화·성적·출결·학습 전체)를 최근 퇴원 순으로 돌려준다.
//   via='admin' : 관리자 퇴원 처리분 / via='app' : 앱 자가탈퇴분(앱에선 삭제됨, 기록만 보존)
// 인증: Authorization: Bearer <ADMIN_PASSWORD>  (admin-scores.html과 동일 방식)
// ───────────────────────────────────────────────────────────
// 배포 push 테스트 — 2026-06-11 (확인용 한 줄, 지워도 됨)
import { ensureArchiveTable } from './_outcomes.js';

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });
  if (request.method !== 'GET')
    return Response.json({ error: 'GET만 허용됩니다.' }, { status: 405 });

  try {
    await ensureArchiveTable(env);
    const { results } = await env.DB.prepare(
      'SELECT * FROM student_archive ORDER BY left_at DESC, id DESC'
    ).all();
    return Response.json({ ok: true, count: (results || []).length, outcomes: results || [] });
  } catch (e) {
    return Response.json({ error: '퇴원생 기록을 불러오지 못했습니다.' }, { status: 500 });
  }
}
