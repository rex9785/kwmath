// /api/staff-approve — 운영진(조교) 승인 관리 (원장 전용, Bearer ADMIN_PASSWORD)
//   GET                              → { ok, staff:[{phone,name,approved,createdAt,approvedAt}] }
//   POST { phone, action:'approve'|'reject' }
//     approve → R2 staff/{phone}.json approved=true (이제 로그인 가능)
//     reject  → R2 staff 레코드 + 계정 삭제 (로그인 차단)
import { listStaff, getStaffRecord, putStaffRecord, deleteStaffRecord } from './_staff.js';
import { normalizePhone } from './_auth.js';

function isAdmin(request, env) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  return !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
}

export async function onRequest({ request, env }) {
  // 미들웨어가 조교(ast_) 토큰은 이 경로를 막으므로, 여기 도달하는 건 원장뿐이지만 이중 방어.
  if (!isAdmin(request, env)) return Response.json({ error: '인증 실패' }, { status: 401 });

  if (request.method === 'GET') {
    const staff = await listStaff(env);
    return Response.json({ ok: true, staff });
  }

  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (_) {}
    const phone = normalizePhone(body.phone || '') || String(body.phone || '').trim();
    const action = String(body.action || '');
    if (!phone) return Response.json({ error: 'phone 필수' }, { status: 400 });
    if (!['approve', 'reject'].includes(action))
      return Response.json({ error: "action은 approve 또는 reject" }, { status: 400 });

    const rec = await getStaffRecord(env, phone);
    if (!rec) return Response.json({ error: '해당 조교 신청을 찾을 수 없습니다.' }, { status: 404 });

    if (action === 'approve') {
      rec.approved = true;
      rec.approvedAt = new Date().toISOString();
      await putStaffRecord(env, phone, rec);
      return Response.json({
        ok: true, action: 'approve', phone, name: rec.name || '',
        message: '[' + (rec.name || phone) + '] 조교 승인 완료. 이제 같은 번호·비밀번호로 로그인 가능합니다.',
      });
    }

    // reject → R2 레코드 + D1 계정 삭제
    await deleteStaffRecord(env, phone);
    try { await env.DB.prepare('DELETE FROM accounts WHERE phone = ?').bind(phone).run(); } catch (_) {}
    return Response.json({
      ok: true, action: 'reject', phone, name: rec.name || '',
      message: '[' + (rec.name || phone) + '] 조교 신청을 거부하고 계정을 삭제했습니다.',
    });
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
