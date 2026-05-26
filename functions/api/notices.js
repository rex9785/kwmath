// GET /api/notices
// - 인증 없이 호출: 전체 대상 공지만 반환 (메인 홈피용)
// - Authorization: Bearer <userToken>: 그 학생/학부모에게 해당하는 공지만 (전체 + 학원 + 반 + 개인)
// - admin: 모든 공지 반환

import { bearerFromRequest, verifyToken, fetchStudentsByPhone } from './_auth.js';

const DB = '6cf7a459bd3d4444bd4c9341f3ffe907';

export async function onRequest({ request, env }) {
  // 인증 모드 판단
  const token = bearerFromRequest(request);
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  let userStudents = null;  // 학생 토큰이면 그 phone의 학생들
  if (token && !isAdmin) {
    const payload = await verifyToken(env, token);
    if (payload && payload.phone) {
      userStudents = await fetchStudentsByPhone(env, payload.phone);
    }
  }

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: { property: '공개', checkbox: { equals: true } },
        sorts: [{ property: '날짜', direction: 'descending' }],
        page_size: 50,
      }),
    });
    const data = await res.json();
    const joinText = (rt) => (rt || []).map(t => t.plain_text).join('');

    const allNotices = (data.results || []).filter(p => !p.archived && !p.in_trash).map(p => ({
      id: p.id,
      title: (p.properties['제목']?.title || []).map(t => t.plain_text).join(''),
      date: p.properties['날짜']?.date?.start || '',
      badge: p.properties['뱃지']?.select?.name || '공지',
      content: joinText(p.properties['내용']?.rich_text),
      targetType: p.properties['대상 유형']?.select?.name || '전체',
      targetValue: joinText(p.properties['대상 값']?.rich_text),
    }));

    // admin: 전체 반환
    if (isAdmin) {
      return Response.json(allNotices);
    }

    // 학생 토큰: 해당하는 공지만 필터
    if (userStudents) {
      const myAcademies = new Set(userStudents.map(s => s.academy).filter(Boolean));
      const myClasses   = new Set(userStudents.map(s => (s.academy||'') + '/' + (s.className||'')).filter(v => v !== '/'));
      const myNames     = new Set(userStudents.map(s => s.name).filter(Boolean));

      const filtered = allNotices.filter(n => {
        if (n.targetType === '전체' || !n.targetType) return true;
        if (n.targetType === '학원') return myAcademies.has(n.targetValue);
        if (n.targetType === '반') {
          // targetValue 형식: "학원/반" (관우T가 admin에서 작성 시)
          return myClasses.has(n.targetValue);
        }
        if (n.targetType === '개인') return myNames.has(n.targetValue);
        return false;
      });
      return Response.json(filtered);
    }

    // 비로그인 (메인 홈피 등): 전체 대상만
    return Response.json(allNotices.filter(n => n.targetType === '전체' || !n.targetType));
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
