const DB = '559465b73e2f4b76b7df441fd0058bfb';

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sorts: [{ timestamp: 'created_time', direction: 'descending' }], page_size: 100 }),
    });
    const data = await res.json();
    const rich = (p, k) => p[k]?.rich_text?.[0]?.plain_text || '';
    const sel  = (p, k) => p[k]?.select?.name || '';
    const multi= (p, k) => (p[k]?.multi_select || []).map(o => o.name);
    const num  = (p, k) => (typeof p[k]?.number === 'number') ? p[k].number : null;

    const students = (data.results || []).filter(p => !p.archived && !p.in_trash).map(p => {
      const props = p.properties || {};
      return {
        id: p.id,
        name: props['이름']?.title?.[0]?.plain_text || '',
        school: rich(props, '학교'),
        grade: sel(props, '학년'),
        parentPhone4:   rich(props, '학부모 연락처 끝4자리'),
        studentPhone:   rich(props, '학생 연락처'),
        parentPhone:    rich(props, '학부모 휴대폰'),
        parentRelation: sel(props, '학부모 관계'),
        goals: multi(props, '수강 목적'),
        level: sel(props, '현재 수학 등급'),
        academy: sel(props, '학원'),
        className: sel(props, '반'),
        // 학업 정보 (추가)
        mathMockGrade:    sel(props, '모의고사 수학 등급'),
        mathMockScore:    num(props, '모의고사 수학 원점수'),
        korMockGrade:     sel(props, '모의고사 국어 등급'),
        engMockGrade:     sel(props, '모의고사 영어 등급'),
        schoolMathGrade:  sel(props, '내신 수학 등급'),
        advanceProgress:  sel(props, '선행 진도'),
        weakness:    rich(props, '취약 단원'),
        dreamUniv:   rich(props, '희망 대학/계열'),
        availableDays: multi(props, '등원 가능 요일'),
        notes: rich(props, '특이사항'),
        approvalStatus: sel(props, '승인 상태'),
        createdAt: p.created_time || '',
      };
    });
    return Response.json(students);
  } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
  }
}
