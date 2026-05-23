const DB = '559465b73e2f4b76b7df441fd0058bfb';

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 문자 제외 (I, O, 0, 1)
  let key = 'KW';
  for (let i = 0; i < 6; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key; // ex) KWA3B7X2
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405 });

  const body = await request.json();
  const {
    name, school, grade,
    parentPhone4, parentPhone, parentRelation, parentName,
    studentPhone,
    goals, level, academy, className,
    mathMockGrade, mathMockScore, korMockGrade, engMockGrade,
    schoolMathGrade, advanceProgress, weakness, dreamUniv, availableDays,
    notes
  } = body;

  // 필수 검증 — 학생/학부모 휴대폰은 폼에서 검사하지만 서버에서도 한 번 더
  if (!name || !grade) return Response.json({ error: '이름과 학년은 필수입니다.' }, { status: 400 });

  // parentPhone4를 클라이언트에서 받지만, 안 보내면 parentPhone에서 자동 추출
  let phone4 = (parentPhone4 || '').replace(/[^0-9]/g, '').slice(-4);
  if (phone4.length !== 4 && parentPhone) {
    const digits = parentPhone.replace(/[^0-9]/g, '');
    if (digits.length >= 4) phone4 = digits.slice(-4);
  }
  if (phone4.length !== 4) return Response.json({ error: '학부모 휴대폰 번호가 정확하지 않습니다.' }, { status: 400 });

  const goalsArray = Array.isArray(goals) ? goals : (goals ? [goals] : []);
  const daysArray  = Array.isArray(availableDays) ? availableDays : [];
  const personalKey = generateKey();

  // 빈 select 값은 Notion이 에러 내므로 값이 있을 때만 추가
  const properties = {
    '이름': { title: [{ text: { content: name } }] },
    '학교': { rich_text: [{ text: { content: school || '' } }] },
    '학년': { select: { name: grade } },
    '학부모 연락처 끝4자리': { rich_text: [{ text: { content: phone4 } }] },
    '학생 연락처': { rich_text: [{ text: { content: studentPhone || '' } }] },
    '학부모 휴대폰': { rich_text: [{ text: { content: parentPhone || '' } }] },
    '학부모 성함':   { rich_text: [{ text: { content: parentName  || '' } }] },
    '수강 목적': { multi_select: goalsArray.map(g => ({ name: g })) },
    '현재 수학 등급': { select: { name: level || '잘 모름' } },
    '학원': { select: { name: academy || '대치동 정규반' } },
    '특이사항': { rich_text: [{ text: { content: notes || '' } }] },
    '개인키': { rich_text: [{ text: { content: personalKey } }] },
    '취약 단원':       { rich_text: [{ text: { content: weakness  || '' } }] },
    '희망 대학/계열':  { rich_text: [{ text: { content: dreamUniv || '' } }] },
    '등원 가능 요일':  { multi_select: daysArray.map(d => ({ name: d })) },
  };

  if (className)        properties['반'] = { select: { name: className } };
  if (parentRelation)   properties['학부모 관계']       = { select: { name: parentRelation } };
  if (mathMockGrade)    properties['모의고사 수학 등급'] = { select: { name: mathMockGrade } };
  if (korMockGrade)     properties['모의고사 국어 등급'] = { select: { name: korMockGrade  } };
  if (engMockGrade)     properties['모의고사 영어 등급'] = { select: { name: engMockGrade  } };
  if (schoolMathGrade)  properties['내신 수학 등급']    = { select: { name: schoolMathGrade } };
  if (advanceProgress)  properties['선행 진도']         = { select: { name: advanceProgress } };
  if (mathMockScore !== null && mathMockScore !== undefined && mathMockScore !== '') {
    const n = Number(mathMockScore);
    if (!Number.isNaN(n)) properties['모의고사 수학 원점수'] = { number: n };
  }

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: { database_id: DB }, properties }),
  });
  const data = await res.json();
  if (data.object === 'error') return Response.json({ error: data.message || '학생 등록 실패' }, { status: 500 });
  return Response.json({ ok: true, personalKey, id: data.id });
}
