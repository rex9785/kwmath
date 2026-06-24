// GET /api/students — 학생 목록 (Cloudflare D1 students, 이전엔 Notion)
// id는 문자열로 반환 (admin.html이 문자열 id로 승인/수정/삭제 호출 — 노션 시절 계약 유지)
//
// 권한:
//   원장(adm_ 번역) → 전체 학생, 모든 필드.
//   조교(ast_ 번역 + X-Staff-Phone) → "맡은 학원" 학생만 + 연락처·사적메모 가림.
//     ※ 미들웨어가 ast_ 토큰을 ADMIN_PASSWORD로 번역하므로 여기 token 검사는 통과하지만,
//        X-Staff-Phone(위조불가)로 학원 스코프를 강제한다.
import { listStudents } from './_db.js';
import { staffScopeAcademy } from './_staff.js';
import { safeError } from './_errors.js';

// 조교에게 가리는 필드: 학부모/학생 연락처 + 원장 사적 메모
const STAFF_HIDDEN = ['parentPhone', 'parentPhone4', 'studentPhone', 'parentRelation', 'notes'];

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  try {
    let students = await listStudents(env);

    // 조교면 학원 스코프 적용 (원장이면 academy === null → 건너뜀)
    const academy = await staffScopeAcademy(env, request);
    if (academy !== null) {
      students = academy ? students.filter(s => (s.academy || '') === academy) : [];
      students = students.map(s => {
        const c = { ...s };
        for (const k of STAFF_HIDDEN) delete c[k];
        return c;
      });
    }

    return Response.json(students.map(s => ({ ...s, id: s.id == null ? '' : String(s.id) })));
  } catch (e) {
    return safeError(e, env, { message: '학생 목록을 불러오지 못했습니다.' });
  }
}
