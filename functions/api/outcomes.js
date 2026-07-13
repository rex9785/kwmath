// /api/outcomes  (admin only) — 퇴원생 기록 조회·숨김·삭제
// ───────────────────────────────────────────────────────────
// GET  : student_archive(실명·전화·성적·출결·학습 전체)를 최근 퇴원 순으로 돌려준다.
//        (hidden=1 행도 포함해서 돌려줌 — 화면에서 '숨김 보기'로 분리 표시)
//   via='admin' : 관리자 퇴원 처리분 / via='app' : 앱 자가탈퇴분(앱에선 삭제됨, 기록만 보존)
// POST : { action:'hide'|'unhide', id }  → hidden 플래그만 토글(기록은 보존, 복구 가능)
//        { action:'delete', id }         → 그 행을 DB에서 영구 삭제(복구 불가)
// 인증: Authorization: Bearer <ADMIN_PASSWORD>  (admin-scores.html과 동일 방식)
// ───────────────────────────────────────────────────────────
// 배포 push 테스트 — 2026-06-11 (확인용 한 줄, 지워도 됨)
import { ensureArchiveTable } from './_outcomes.js';

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  try {
    await ensureArchiveTable(env);

    if (request.method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM student_archive ORDER BY left_at DESC, id DESC'
      ).all();
      return Response.json({ ok: true, count: (results || []).length, outcomes: results || [] });
    }

    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const id = Number(body.id);
      const action = String(body.action || '');
      if (!Number.isFinite(id)) return Response.json({ error: 'id가 필요합니다.' }, { status: 400 });

      if (action === 'hide' || action === 'unhide') {
        await env.DB.prepare('UPDATE student_archive SET hidden = ? WHERE id = ?')
          .bind(action === 'hide' ? 1 : 0, id).run();
        return Response.json({ ok: true, id, hidden: action === 'hide' ? 1 : 0 });
      }
      if (action === 'delete') {
        const d = await env.DB.prepare('DELETE FROM student_archive WHERE id = ?').bind(id).run();
        return Response.json({ ok: true, id, deleted: (d.meta && d.meta.changes) || 0 });
      }
      return Response.json({ error: '알 수 없는 action' }, { status: 400 });
    }

    return Response.json({ error: 'GET/POST만 허용됩니다.' }, { status: 405 });
  } catch (e) {
    return Response.json({ error: '퇴원생 기록 처리 중 오류가 발생했습니다.' }, { status: 500 });
  }
}
