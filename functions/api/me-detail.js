// GET /api/me-detail?id=<studentId> 또는 ?name=<학생이름>  (Bearer 토큰)
// 본인/학부모만 — 토큰 phone에 연결된 학생만 반환. (Cloudflare D1, 이전엔 Notion)
import { requireAuth, fetchStudentsByPhone, jsonError } from './_auth.js';
import { getStudentById } from './_db.js';
import { safeError } from './_errors.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return jsonError('GET만 허용', 405);

  const auth = await requireAuth(env, request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const queryId = (url.searchParams.get('id') || '').trim();
  const queryName = (url.searchParams.get('name') || '').trim();
  if (!queryId && !queryName) return jsonError('id 또는 name 파라미터 필요', 400);

  // 이 휴대폰에 연결된 학생들 중 매칭 (권한 방어). id는 문자열로 비교(D1 정수 id 대응)
  const students = await fetchStudentsByPhone(env, auth.phone);
  let target = null;
  if (queryId) target = students.find(s => String(s.id) === queryId);
  else target = students.find(s => s.name === queryName);
  if (!target) return jsonError('해당 학생을 찾을 수 없거나 접근 권한이 없습니다.', 403);

  let st;
  try {
    st = await getStudentById(env, target.id);
  } catch (e) {
    return safeError(e, env, { message: '학생 정보를 불러오지 못했습니다.' });
  }
  if (!st) return jsonError('학생 정보를 불러오지 못했습니다.', 500);

  const detail = {
    id: String(st.id),
    name: st.name,
    school: st.school,
    grade: st.grade,
    academy: st.academy,
    className: st.className,
    goals: st.goals,
    level: st.level,
    mathMockGrade:   st.mathMockGrade,
    mathMockScore:   st.mathMockScore,
    korMockGrade:    st.korMockGrade,
    engMockGrade:    st.engMockGrade,
    schoolMathGrade: st.schoolMathGrade,
    advanceProgress: st.advanceProgress,
    weakness:        st.weakness,
    dreamUniv:       st.dreamUniv,
    availableDays:   st.availableDays,
    notes:           st.notes,
    parentRelation:  st.parentRelation,
    parentPhone:     st.parentPhone,
    studentPhone:    st.studentPhone,
    approvalStatus:  st.approvalStatus,
    createdAt:       st.createdAt,
  };

  return Response.json({ ok: true, student: detail });
}
