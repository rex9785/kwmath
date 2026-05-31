// POST /api/update-student-key — 학생 개인키 변경 (Cloudflare D1 students, 이전엔 Notion)
// body: { currentKey, newKey } — 현재 키 아는 사람만(학생 본인). admin 토큰 불필요(기존 동작 유지).
import { safeError } from './_errors.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });

  let body = {};
  try { body = await request.json(); } catch {}
  const currentKey = (body.currentKey || '').trim();
  const newKey = (body.newKey || '').trim();
  if (!currentKey || !newKey) return Response.json({ error: '키를 입력해주세요' }, { status: 400 });
  if (newKey.length < 4) return Response.json({ error: '새 키는 4자 이상이어야 합니다' }, { status: 400 });

  try {
    const me = await env.DB.prepare('SELECT id FROM students WHERE personal_key = ? LIMIT 1').bind(currentKey).first();
    if (!me) return Response.json({ error: '현재 키가 올바르지 않습니다' }, { status: 401 });

    const dup = await env.DB.prepare('SELECT id FROM students WHERE personal_key = ? LIMIT 1').bind(newKey).first();
    if (dup) return Response.json({ error: '이미 사용 중인 키입니다. 다른 키를 선택해주세요.' }, { status: 409 });

    await env.DB.prepare('UPDATE students SET personal_key = ? WHERE id = ?').bind(newKey, me.id).run();
    return Response.json({ ok: true });
  } catch (e) {
    return safeError(e, env, { message: '키 변경에 실패했습니다.' });
  }
}
