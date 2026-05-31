// POST /api/admin-approve-student (admin only) — Cloudflare D1 (이전엔 Notion)
// body: { studentId (D1 id), action: 'approve'|'reject' }
//   approve: 승인 상태→'승인' + 동명이인 alias 자동 부여 + 학부모/학생 계정 생성(초기 0000)
//   reject : 학생 레코드 삭제
import { normalizePhone, findAccountByPhone, createAccount } from './_auth.js';
import { getStudentById, setApprovalStatus, deleteStudent } from './_db.js';
import { safeError } from './_errors.js';

const INITIAL_PASSWORD = '0000';

function isAdmin(request, env) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  return !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용' }, { status: 405 });
  if (!isAdmin(request, env)) return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const studentId = Number((body.studentId || '').toString().trim());
  const action = (body.action || '').toString();

  if (!body.studentId || !Number.isFinite(studentId)) return Response.json({ error: 'studentId 필수' }, { status: 400 });
  if (!['approve', 'reject'].includes(action)) return Response.json({ error: 'action은 approve 또는 reject' }, { status: 400 });

  try {
    const st = await getStudentById(env, studentId);
    if (!st) return Response.json({ error: '학생을 찾을 수 없습니다' }, { status: 404 });
    const name = st.name || '';
    const parentPhone = st.parentPhone || '';
    const studentPhone = st.studentPhone || '';

    // === REJECT ===
    if (action === 'reject') {
      const d = await deleteStudent(env, studentId);
      if (!d.ok) return safeError(d.error || 'deleteStudent failed', env, { message: '거부 처리에 실패했습니다.' });
      return Response.json({ ok: true, action: 'reject', name, studentId: String(studentId),
        message: '[' + name + '] 등록 신청이 거부되었습니다.' });
    }

    // === APPROVE ===
    const ap = await setApprovalStatus(env, studentId, '승인');
    if (!ap.ok) return safeError(ap.error || 'setApprovalStatus failed', env, { message: '승인 상태 업데이트에 실패했습니다.' });

    // 동명이인 alias 자동 부여 (매쓰플랫 이름: 김수림1/2/3…)
    let assignedAlias = '';
    let duplicateCount = 0;
    try {
      const { results: sameName } = await env.DB.prepare(
        'SELECT id, mathflat_name FROM students WHERE name = ? ORDER BY created_at, id'
      ).bind(name).all();
      duplicateCount = (sameName || []).length;
      if (duplicateCount >= 2) {
        const aliasPattern = new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)$');
        const usedNumbers = new Set();
        for (const it of sameName) {
          const m = (it.mathflat_name || '').trim().match(aliasPattern);
          if (m) usedNumbers.add(parseInt(m[1], 10));
        }
        let nextNum = 1;
        for (const it of sameName) {
          if ((it.mathflat_name || '').trim()) continue;
          while (usedNumbers.has(nextNum)) nextNum++;
          const newAlias = name + nextNum;
          usedNumbers.add(nextNum);
          try {
            await env.DB.prepare('UPDATE students SET mathflat_name = ? WHERE id = ?').bind(newAlias, it.id).run();
            if (it.id === studentId) assignedAlias = newAlias;
          } catch (_) {}
        }
        if (!assignedAlias) {
          const me = (sameName || []).find(it => it.id === studentId);
          if (me) assignedAlias = (me.mathflat_name || '').trim();
        }
      }
    } catch (e) { /* alias 부여 실패는 비치명적 */ }

    // 계정 자동 생성 (학부모/학생 휴대폰)
    const accountResult = { created: [], skipped: [], failed: [] };
    const phonesToCreate = [];
    const normP = normalizePhone(parentPhone);
    const normS = normalizePhone(studentPhone);
    if (normP) phonesToCreate.push({ phone: normP, note: 'parent:' + name });
    if (normS && normS !== normP) phonesToCreate.push({ phone: normS, note: 'student:' + name });

    for (const item of phonesToCreate) {
      try {
        const existing = await findAccountByPhone(env, item.phone);
        if (existing) { accountResult.skipped.push(item.phone); continue; }
        const ret = await createAccount(env, item.phone, INITIAL_PASSWORD, true, item.note);
        if (ret.ok) accountResult.created.push(item.phone);
        else accountResult.failed.push(item.phone + ': ' + (ret.error || 'unknown'));
      } catch (e) {
        accountResult.failed.push(item.phone + ': ' + (e.message || 'error'));
      }
    }

    return Response.json({
      ok: true, action: 'approve', name, studentId: String(studentId),
      account: accountResult, initialPassword: INITIAL_PASSWORD,
      assignedAlias, duplicateCount,
      message: '[' + name + '] 등록 승인 완료. 학부모/학생 휴대폰으로 로그인 가능 (초기 비번 ' + INITIAL_PASSWORD + ').'
        + (assignedAlias ? '\n동명이인 — 매쓰플랫 alias [' + assignedAlias + '] 자동 부여됨. 매쓰플랫 명단도 같은 이름으로 등록해주세요.' : ''),
    });
  } catch (e) {
    return safeError(e, env, { message: '승인 처리 중 오류가 발생했습니다.' });
  }
}
