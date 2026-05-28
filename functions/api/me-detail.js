// GET /api/me-detail?id=<studentId>  또는  ?name=<학생이름>
// 헤더: Authorization: Bearer <token>
// 응답: { ok:true, student:{ ... 모든 등록 필드 ... } }
//
// 본인(또는 학부모)만 접근 가능 — 토큰의 phone에 연결된 학생만 반환.

import { requireAuth, fetchStudentsByPhone, jsonError } from './_auth.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return jsonError('GET만 허용', 405);

  const auth = await requireAuth(env, request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const queryId = (url.searchParams.get('id') || '').trim();
  const queryName = (url.searchParams.get('name') || '').trim();

  if (!queryId && !queryName) return jsonError('id 또는 name 파라미터 필요', 400);

  // 이 휴대폰에 연결된 학생들 중 query와 매칭되는 학생 찾기 (권한 방어)
  const students = await fetchStudentsByPhone(env, auth.phone);
  let target = null;
  if (queryId) target = students.find(s => s.id === queryId);
  else target = students.find(s => s.name === queryName);

  if (!target) return jsonError('해당 학생을 찾을 수 없거나 접근 권한이 없습니다.', 403);

  // Notion에서 학생 page 상세 조회
  const pageRes = await fetch(`https://api.notion.com/v1/pages/${target.id}`, {
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
    },
  });
  const page = await pageRes.json();
  if (page.object === 'error' || !page.properties) {
    return jsonError('학생 정보를 불러오지 못했습니다.', 500);
  }

  const pp = page.properties;
  const rt    = (k) => (pp[k]?.rich_text || [])[0]?.plain_text || '';
  const ttl   = (k) => (pp[k]?.title || [])[0]?.plain_text || '';
  const sel   = (k) => pp[k]?.select?.name || '';
  const multi = (k) => (pp[k]?.multi_select || []).map(o => o.name);
  const num   = (k) => (typeof pp[k]?.number === 'number') ? pp[k].number : null;

  const detail = {
    id: target.id,
    name: ttl('이름'),
    school: rt('학교'),
    grade: sel('학년'),
    academy: sel('학원'),
    className: sel('반'),
    goals: multi('수강 목적'),
    level: sel('현재 수학 등급'),
    // 학업
    mathMockGrade:   sel('모의고사 수학 등급'),
    mathMockScore:   num('모의고사 수학 원점수'),
    korMockGrade:    sel('모의고사 국어 등급'),
    engMockGrade:    sel('모의고사 영어 등급'),
    schoolMathGrade: sel('내신 수학 등급'),
    advanceProgress: sel('선행 진도'),
    weakness:        rt('취약 단원'),
    dreamUniv:       rt('희망 대학/계열'),
    availableDays:   multi('등원 가능 요일'),
    notes:           rt('특이사항'),
    // 연락처
    parentRelation: sel('학부모 관계'),
    parentPhone:    rt('학부모 휴대폰'),
    studentPhone:   rt('학생 연락처'),
    // 매쓰플랫 alias는 admin 전용 — me 페이지(학생/학부모)에선 노출 안 함
    // 메타
    approvalStatus: sel('승인 상태'),
    createdAt: page.created_time || '',
  };

  return Response.json({ ok: true, student: detail });
}
