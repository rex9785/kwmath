// POST /api/admin-add-enrollment (admin only) — Cloudflare D1 (이전엔 Notion)
// body: { sourceStudentId (D1 id), academy, className }
// 기존 학생 정보 복사 + 학원/반만 새로 지정 + 새 개인키. 새 enrollment는 '승인' 상태.
import { getStudentById, createStudent } from './_db.js';
import { safeError } from './_errors.js';

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = 'KW';
  for (let i = 0; i < 6; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용' }, { status: 405 });
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const sourceId  = Number((body.sourceStudentId || '').toString().trim());
  const academy   = (body.academy   || '').toString().trim();
  const className = (body.className || '').toString().trim();

  if (!body.sourceStudentId || !Number.isFinite(sourceId)) return Response.json({ error: 'sourceStudentId 필수' }, { status: 400 });
  if (!academy || !className) return Response.json({ error: 'academy, className 둘 다 필요' }, { status: 400 });

  try {
    const src = await getStudentById(env, sourceId);
    if (!src) return Response.json({ error: '원본 학생을 찾을 수 없습니다' }, { status: 404 });
    const name = src.name;
    if (!name) return Response.json({ error: '원본 학생 이름 없음' }, { status: 400 });

    const dup = await env.DB.prepare(
      'SELECT id FROM students WHERE name = ? AND academy = ? AND class_name = ? LIMIT 1'
    ).bind(name, academy, className).first();
    if (dup) return Response.json({ error: '이미 [' + academy + ' · ' + className + ']에 등록돼있습니다.' }, { status: 409 });

    const newKey = generateKey();
    const r = await createStudent(env, {
      name, school: src.school, grade: src.grade,
      parentPhone4: src.parentPhone4, studentPhone: src.studentPhone,
      parentPhone: src.parentPhone, parentRelation: src.parentRelation,
      goals: src.goals, level: src.level, academy, className,
      mathMockGrade: src.mathMockGrade, mathMockScore: src.mathMockScore,
      korMockGrade: src.korMockGrade, engMockGrade: src.engMockGrade,
      schoolMathGrade: src.schoolMathGrade, advanceProgress: src.advanceProgress,
      availableDays: src.availableDays, weakness: src.weakness, dreamUniv: src.dreamUniv, notes: src.notes,
      personalKey: newKey, approvalStatus: '승인',
    });
    if (!r.ok) return safeError(r.error || 'createStudent failed', env, { message: 'enrollment 추가에 실패했습니다.' });

    return Response.json({
      ok: true, newStudentId: String(r.id), personalKey: newKey,
      copiedFrom: String(sourceId), name, academy, className,
    });
  } catch (e) {
    return safeError(e, env, { message: 'enrollment 추가에 실패했습니다.' });
  }
}
