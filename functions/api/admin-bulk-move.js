// POST /api/admin-bulk-move (admin only) — Cloudflare D1 (이전엔 Notion)
// body: { moves: [{ sourceStudentId, targetAcademy, targetClassName }], mode: 'transition'|'add-only' }
//   transition: 새 enrollment 생성 + 옛 enrollment 삭제(그 출결/공부 포함)
//   add-only  : 새 enrollment 생성만
import { getStudentById, createStudent, deleteStudent } from './_db.js';
import { safeError } from './_errors.js';

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = 'KW';
  for (let i = 0; i < 6; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

function isAdmin(request, env) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  return !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
}

async function copyEnrollment(env, sourceId, academy, className) {
  const src = await getStudentById(env, sourceId);
  if (!src) return { ok: false, error: '원본 학생을 찾을 수 없음' };
  const name = src.name;
  if (!name) return { ok: false, error: '원본 학생 이름 없음' };

  const dup = await env.DB.prepare(
    'SELECT id FROM students WHERE name = ? AND academy = ? AND class_name = ? LIMIT 1'
  ).bind(name, academy, className).first();
  if (dup) return { ok: false, error: '이미 [' + academy + ' · ' + className + ']에 등록', existingId: String(dup.id) };

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
  if (!r.ok) return { ok: false, error: r.error || '생성 실패' };
  return { ok: true, newEnrollmentId: String(r.id), name };
}

async function archiveEnrollment(env, studentId) {
  try {
    await env.DB.prepare('DELETE FROM attendance WHERE student_id = ?').bind(studentId).run();
    await env.DB.prepare('DELETE FROM study_sessions WHERE student_id = ?').bind(studentId).run();
    const d = await deleteStudent(env, studentId);
    return d.ok ? { ok: true } : { ok: false, error: d.error || '삭제 실패' };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용' }, { status: 405 });
  if (!isAdmin(request, env)) return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const moves = Array.isArray(body.moves) ? body.moves : [];
  const mode  = (body.mode || 'transition').toString();
  if (!['transition', 'add-only'].includes(mode)) return Response.json({ error: 'mode는 transition 또는 add-only' }, { status: 400 });
  if (!moves.length) return Response.json({ error: 'moves 비어있음' }, { status: 400 });

  const results = [];
  let succeeded = 0, failed = 0;

  try {
    for (const m of moves) {
      const src  = Number((m.sourceStudentId || '').toString().trim());
      const acad = (m.targetAcademy || '').trim();
      const cls  = (m.targetClassName || '').trim();
      if (!Number.isFinite(src) || !acad || !cls) {
        results.push({ sourceStudentId: String(m.sourceStudentId || ''), ok: false, error: '필수 값 누락' });
        failed++; continue;
      }

      const copyResult = await copyEnrollment(env, src, acad, cls);
      if (!copyResult.ok) {
        results.push({ sourceStudentId: String(src), ok: false, error: copyResult.error });
        failed++; continue;
      }

      if (mode === 'transition') {
        const archiveResult = await archiveEnrollment(env, src);
        if (!archiveResult.ok) {
          results.push({ sourceStudentId: String(src), name: copyResult.name, ok: false, partial: true,
            newEnrollmentId: copyResult.newEnrollmentId,
            error: '새 enrollment 생성됐지만 옛 enrollment 삭제 실패: ' + archiveResult.error });
          failed++; continue;
        }
      }

      results.push({ sourceStudentId: String(src), name: copyResult.name, ok: true, newEnrollmentId: copyResult.newEnrollmentId });
      succeeded++;
    }

    return Response.json({ ok: true, mode, total: moves.length, succeeded, failed, results });
  } catch (e) {
    return safeError(e, env, { message: '반 이동 처리 중 오류가 발생했습니다.' });
  }
}
