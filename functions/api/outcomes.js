// GET /api/outcomes  (admin only) — 익명 성과 기록 조회
// ───────────────────────────────────────────────────────────
// 탈퇴/퇴원한 학생의 '익명화된 성과 한 줄'(_outcomes.js가 삭제 직전 저장)을 모아 본다.
// 개인 식별자(전화·이름 원문 등)는 애초에 저장하지 않으므로 여기엔 마스킹 이름만 나온다.
// 인증: Authorization: Bearer <ADMIN_PASSWORD>
// 응답: { ok, count, outcomes:[ {name_masked, school, grade_level, enrolled_at, left_at,
//         naesin_first/last(+label), mock_first/last(+label), score_count, note} ] }
// ───────────────────────────────────────────────────────────
import { ensureOutcomesTable } from './_outcomes.js';

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });
  if (request.method !== 'GET')
    return Response.json({ error: 'GET만 허용됩니다.' }, { status: 405 });

  try {
    await ensureOutcomesTable(env);
    const { results } = await env.DB.prepare(
      'SELECT * FROM student_outcomes ORDER BY left_at DESC, id DESC'
    ).all();
    return Response.json({ ok: true, count: (results || []).length, outcomes: results || [] });
  } catch (e) {
    return Response.json({ error: '성과 기록을 불러오지 못했습니다.' }, { status: 500 });
  }
}
