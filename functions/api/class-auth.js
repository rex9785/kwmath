// POST /api/class-auth — 개인 키로 학생 인증 → 반 정보 (Cloudflare D1, 이전엔 Notion)
import { safeError } from './_errors.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  let body = {};
  try { body = await request.json(); } catch {}
  const key = (body.key || '').trim();
  if (!key) return Response.json({ error: '키를 입력해주세요' }, { status: 400 });

  try {
    const st = await env.DB.prepare('SELECT name, class_name FROM students WHERE personal_key = ? LIMIT 1').bind(key).first();
    if (!st) return Response.json({ error: '등록되지 않은 키입니다' }, { status: 401 });
    return Response.json({ ok: true, name: st.name || '', className: st.class_name || '' });
  } catch (e) {
    return safeError(e, env, { message: '인증에 실패했습니다.' });
  }
}
