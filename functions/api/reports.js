// GET /api/reports
//   admin 모드: Authorization: Bearer <ADMIN_PASSWORD>
//     - name 없으면 전체 리포트 (학생 DB join 해서 학원/반 채움)
//     - name 있으면 해당 학생의 리포트만
//   사용자 모드: Authorization: Bearer <userToken>
//     - 토큰 검증 → 휴대폰 → 연결된 학생들 조회
//     - name 안 주면 자동으로 첫 자녀
//     - name 주면 그 휴대폰과 연결된 학생인지 검증 후 반환

import { requireStudentAccess, STUDENTS_DB } from './_auth.js';

const REPORTS_DB = '82ef896dcf844c5b9c36f7e0ff0a97f2';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const queryName = (url.searchParams.get('name') || '').trim();

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;

  const headers = {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
  const richText  = (rt) => (rt || []).map(t => t.plain_text || '').join('');
  const titleText = (rt) => (rt || []).map(t => t.plain_text || '').join('');

  let targetName = '';        // 어느 학생의 리포트를 가져올지
  let studentInfo = null;     // 학부모 페이지에 학원/반 알려주기 위한 정보

  if (isAdmin) {
    // admin: query에 name 있으면 그 학생, 없으면 전체
    targetName = queryName;
  } else {
    // 사용자: 토큰 → 학생 매칭
    const access = await requireStudentAccess(env, request);
    if (!access.ok) return access.response;
    targetName = access.student.name;
    studentInfo = {
      name: access.student.name,
      school: access.student.school,
      class_name: access.student.className,
    };
  }

  try {
    const reportsFilter = isAdmin && !targetName
      ? { property: '공개', checkbox: { equals: true } }
      : { and: [
          { property: '공개',     checkbox:  { equals: true } },
          { property: '학생 이름', rich_text: { equals: targetName } },
        ]};

    const res = await fetch(`https://api.notion.com/v1/databases/${REPORTS_DB}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({ filter: reportsFilter, sorts: [{ property: '수업 날짜', direction: 'descending' }], page_size: 100 }),
    });
    const data = await res.json();
    if (data.object === 'error') return Response.json({ error: data.message || 'Notion 조회 실패' }, { status: 500 });

    let reports = (data.results || []).filter(p => !p.archived && !p.in_trash).map(page => {
      const p = page.properties || {};
      return {
        id:          page.id,
        title:       titleText(p['리포트 제목']?.title),
        studentName: richText(p['학생 이름']?.rich_text),
        phone4:      richText(p['전화번호 끝 4자리']?.rich_text),
        date:        p['수업 날짜']?.date?.start || '',
        school:      p['학원']?.select?.name || '',
        content:     richText(p['수업 내용']?.rich_text),
        homework:    richText(p['숙제']?.rich_text),
        notes:       richText(p['특이사항']?.rich_text),
        class_name:  '',
      };
    });

    // admin 전체 조회 모드 — 학생 DB join
    if (isAdmin && !targetName && reports.length) {
      const nameToClass = {};
      const sRes = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({ page_size: 100 }),
      });
      const sData = await sRes.json();
      (sData.results || []).forEach(s => {
        const sp = s.properties || {};
        const sn = (sp['이름']?.title || []).map(t => t.plain_text).join('');
        if (sn) nameToClass[sn] = {
          school:     sp['학원']?.select?.name || '',
          class_name: sp['반']?.select?.name || '',
        };
      });
      reports = reports.map(r => {
        const info = nameToClass[r.studentName] || {};
        return { ...r, class_name: info.class_name || '', school: r.school || info.school || '' };
      });
    }

    return Response.json({ student: studentInfo, reports });

  } catch (err) {
    return Response.json({ error: '서버 오류: ' + err.message }, { status: 500 });
  }
}
