// /api/staff-approve — 운영진(조교) 승인·배정 관리 (원장 전용, Bearer ADMIN_PASSWORD)
//   GET                              → { ok, staff:[{phone,name,approved,createdAt,approvedAt,academy,hourlyWage}] }
//   POST { phone, action:'approve'|'reject'|'config' }
//     approve → R2 staff/{phone}.json approved=true (이제 로그인 가능)
//     reject  → R2 staff 레코드 + 계정 삭제 (로그인 차단)
//     config  → { academy?, hourlyWage?, account? } 맡은 학원·시급·급여계좌 설정
import { listStaff, getStaffRecord, putStaffRecord, deleteStaffRecord } from './_staff.js';
import { normalizePhone } from './_auth.js';
import { logAudit, diffFields } from './_auditlog.js';

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
    if (!['approve', 'reject', 'config'].includes(action))
      return Response.json({ error: "action은 approve / reject / config" }, { status: 400 });

    const rec = await getStaffRecord(env, phone);
    if (!rec) return Response.json({ error: '해당 조교 신청을 찾을 수 없습니다.' }, { status: 404 });

    // 🔎 2026-07-31 — rec 을 그 자리에서 뜯어고치므로(in-place), 손대기 **전에** 통째로 복사해 둔다.
    //   이걸 안 하면 아래 로그의 "전" 값이 이미 바뀐 값과 같아져 아무 의미가 없다.
    const before = JSON.parse(JSON.stringify(rec));

    // 학원 배정·시급 설정 (월급 계산·학생 열람 스코프의 핵심)
    if (action === 'config') {
      if (body.academy !== undefined) rec.academy = String(body.academy || '').trim();
      if (body.hourlyWage !== undefined) {
        const w = Math.round(Number(body.hourlyWage));
        rec.hourlyWage = (Number.isFinite(w) && w >= 0) ? w : 0;
      }
      if (body.account !== undefined) rec.account = String(body.account || '').replace(/[<>"'`]/g, '').trim().slice(0, 60);
      await putStaffRecord(env, phone, rec);

      // 📓 돈(시급·계좌)과 권한(담당 학원)이 한 번에 바뀌는 자리다. 칸별 전/후를 통째로 남긴다.
      //   담당 학원이 바뀌면 그 조교가 볼 수 있는 학생 명단 자체가 바뀐다(staffScopeAcademy) → 권한 변경 기록.
      const d = diffFields(before, rec, ['academy', 'hourlyWage', 'account']);
      await logAudit(env, request, {
        action: 'staff.config',
        target: phone, targetName: rec.name || '',
        summary: '[' + (rec.name || phone) + '] 조교 설정 변경 — ' + (d.요약 || '변경 없음'),
        detail: {
          조교: { 전화번호: phone, 이름: rec.name || '', 승인여부: !!rec.approved },
          바뀐칸: d.바뀐칸,
          변경: d.변경,
          담당학원변경: (before.academy || '') !== (rec.academy || ''),   // true면 이 조교가 보는 학생 명단이 바뀜
          시급변경: Number(before.hourlyWage || 0) !== Number(rec.hourlyWage || 0),
          계좌변경: (before.account || '') !== (rec.account || ''),
          요청값: {
            academy: body.academy === undefined ? '(안 보냄)' : String(body.academy || ''),
            hourlyWage: body.hourlyWage === undefined ? '(안 보냄)' : String(body.hourlyWage),
            account: body.account === undefined ? '(안 보냄)' : String(body.account || ''),
          },
        },
      });

      return Response.json({
        ok: true, action: 'config', phone, name: rec.name || '',
        academy: rec.academy || '', hourlyWage: rec.hourlyWage || 0, account: rec.account || '',
        message: '[' + (rec.name || phone) + '] 배정 저장: 학원 "' + (rec.academy || '미배정') + '" · 시급 ' + (rec.hourlyWage || 0).toLocaleString() + '원',
      });
    }

    if (action === 'approve') {
      const 이미승인 = !!rec.approved;
      rec.approved = true;
      rec.approvedAt = new Date().toISOString();
      await putStaffRecord(env, phone, rec);

      // 📓 이 한 번의 클릭으로 학생 개인정보를 볼 수 있는 계정이 하나 생긴다. 반드시 남긴다.
      await logAudit(env, request, {
        action: 'staff.approve',
        target: phone, targetName: rec.name || '',
        summary: '[' + (rec.name || phone) + '] 조교 승인' + (이미승인 ? ' (이미 승인 상태였음 — 재승인)' : ' — 로그인 가능해짐'),
        detail: {
          조교: { 전화번호: phone, 이름: rec.name || '', 신청일: rec.createdAt || '' },
          승인: { 전: 이미승인 ? '승인됨' : '대기중', 후: '승인됨' },
          승인시각: { 전: before.approvedAt || '(없음)', 후: rec.approvedAt },
          담당학원: rec.academy || '(미배정)',
          시급: rec.hourlyWage || 0,
          효과: '이 번호로 조교 로그인 가능 · 담당 학원 학생 열람 가능',
        },
      });

      return Response.json({
        ok: true, action: 'approve', phone, name: rec.name || '',
        message: '[' + (rec.name || phone) + '] 조교 승인 완료. 이제 같은 번호·비밀번호로 로그인 가능합니다.',
      });
    }

    // reject → R2 레코드 + D1 계정 삭제
    await deleteStaffRecord(env, phone);
    // 🔎 삭제 건수를 실제로 세어 남긴다. 0이면 "계정은 원래 없었다"는 뜻 — 나중에 헷갈리지 않게.
    let 계정삭제 = 0;
    try {
      const r = await env.DB.prepare('DELETE FROM accounts WHERE phone = ?').bind(phone).run();
      계정삭제 = (r.meta && r.meta.changes) || 0;
    } catch (_) {}

    // 🔴 되돌릴 수 없다 — R2 staff 레코드가 사라지면 시급·계좌·담당학원이 통째로 증발한다.
    //   지워진 레코드 원본을 통째로 남겨야 나중에 복원하거나 "왜 없어졌나"를 설명할 수 있다.
    await logAudit(env, request, {
      action: 'staff.reject',
      target: phone, targetName: rec.name || '',
      summary: '[' + (rec.name || phone) + '] 조교 ' + (before.approved ? '자격 회수(승인된 조교였음)' : '신청 거부')
        + ' — R2 레코드 삭제 · 계정 ' + 계정삭제 + '건 삭제 (복구 불가)',
      detail: {
        지워진레코드: before,                 // 시급·계좌·담당학원·승인일 전부 여기 남는다
        승인된조교였나: !!before.approved,     // true면 단순 거부가 아니라 "이미 일하던 조교 해고"
        계정삭제건수: 계정삭제,
        비고: 계정삭제 === 0 ? '삭제할 accounts 행이 없었음(비밀번호 미설정 등)' : '이 번호로 더는 로그인 불가',
      },
    });

    return Response.json({
      ok: true, action: 'reject', phone, name: rec.name || '',
      message: '[' + (rec.name || phone) + '] 조교 신청을 거부하고 계정을 삭제했습니다.',
    });
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
