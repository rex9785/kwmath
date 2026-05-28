// POST /api/admin-add-enrollment  (admin only)
// 기존 학생 페이지를 복사해서 새 학원/반의 enrollment record 생성
// body: { sourceStudentId, academy, className }
// 효과: Notion 학생 DB에 새 페이지 생성. 이름/학교/학년/학부모전화 등은 기존 학생에서 복사,
//       학원/반만 새로 지정. 개인키는 새로 발급. 계정은 이미 있으면 건드리지 않음.

const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = 'KW';
  for (let i = 0; i < 6; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const sourceId  = (body.sourceStudentId || '').toString().trim();
  const academy   = (body.academy   || '').toString().trim();
  const className = (body.className || '').toString().trim();

  if (!sourceId) return Response.json({ error: 'sourceStudentId 필수' }, { status: 400 });
  if (!academy || !className) return Response.json({ error: 'academy, className 둘 다 필요' }, { status: 400 });

  const headers = {
    Authorization:    `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  };

  // 1. 원본 학생 페이지 조회
  const srcRes = await fetch(`https://api.notion.com/v1/pages/${sourceId}`, { headers });
  const src = await srcRes.json();
  if (src.object === 'error' || !src.properties) {
    return Response.json({ error: '원본 학생을 찾을 수 없습니다: ' + (src.message || '')  }, { status: 404 });
  }

  const sp = src.properties;
  const rt   = (k) => ((sp[k]?.rich_text || [])[0]?.plain_text || '');
  const ttl  = (k) => ((sp[k]?.title || [])[0]?.plain_text || '');
  const sel  = (k) => sp[k]?.select?.name || '';
  const ms   = (k) => (sp[k]?.multi_select || []).map(o => o.name);
  const num  = (k) => (typeof sp[k]?.number === 'number') ? sp[k].number : null;

  const name = ttl('이름');
  if (!name) return Response.json({ error: '원본 학생 이름 없음' }, { status: 400 });

  // 2. 이미 같은 이름+학원+반 enrollment가 있는지 검증 (중복 방지)
  const dupRes = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({
      filter: { and: [
        { property: '이름', title: { equals: name } },
        { property: '학원', select: { equals: academy } },
        { property: '반',   select: { equals: className } },
      ]},
      page_size: 5,
    }),
  });
  const dupData = await dupRes.json();
  const existingActive = (dupData.results || []).find(p => !p.archived && !p.in_trash);
  if (existingActive) {
    return Response.json({ error: `이미 [${academy} · ${className}]에 등록돼있습니다.` }, { status: 409 });
  }

  // 3. 새 학생 페이지 생성 — 원본의 모든 정보 복사 + 학원/반 override + 새 개인키
  const newKey = generateKey();
  const properties = {
    '이름':              { title: [{ text: { content: name } }] },
    '학교':              { rich_text: [{ text: { content: rt('학교') } }] },
    '학년':              sel('학년') ? { select: { name: sel('학년') } } : undefined,
    '학부모 연락처 끝4자리': { rich_text: [{ text: { content: rt('학부모 연락처 끝4자리') } }] },
    '학생 연락처':       { rich_text: [{ text: { content: rt('학생 연락처') } }] },
    '학부모 휴대폰':     { rich_text: [{ text: { content: rt('학부모 휴대폰') } }] },
    '수강 목적':         { multi_select: ms('수강 목적').map(n => ({ name: n })) },
    '현재 수학 등급':    sel('현재 수학 등급') ? { select: { name: sel('현재 수학 등급') } } : undefined,
    '학원':              { select: { name: academy } },
    '반':                { select: { name: className } },
    '특이사항':          { rich_text: [{ text: { content: (rt('특이사항') || '') } }] },
    '개인키':            { rich_text: [{ text: { content: newKey } }] },
    '취약 단원':         { rich_text: [{ text: { content: rt('취약 단원') } }] },
    '희망 대학/계열':    { rich_text: [{ text: { content: rt('희망 대학/계열') } }] },
    '등원 가능 요일':    { multi_select: ms('등원 가능 요일').map(n => ({ name: n })) },
  };

  // 선택적 필드들
  if (sel('학부모 관계'))      properties['학부모 관계']        = { select: { name: sel('학부모 관계') } };
  if (sel('모의고사 수학 등급')) properties['모의고사 수학 등급'] = { select: { name: sel('모의고사 수학 등급') } };
  if (sel('모의고사 국어 등급')) properties['모의고사 국어 등급'] = { select: { name: sel('모의고사 국어 등급') } };
  if (sel('모의고사 영어 등급')) properties['모의고사 영어 등급'] = { select: { name: sel('모의고사 영어 등급') } };
  if (sel('내신 수학 등급'))    properties['내신 수학 등급']     = { select: { name: sel('내신 수학 등급') } };
  if (sel('선행 진도'))         properties['선행 진도']          = { select: { name: sel('선행 진도') } };
  if (num('모의고사 수학 원점수') !== null) properties['모의고사 수학 원점수'] = { number: num('모의고사 수학 원점수') };

  // undefined 제거
  for (const k of Object.keys(properties)) {
    if (properties[k] === undefined) delete properties[k];
  }

  const createRes = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST', headers,
    body: JSON.stringify({ parent: { database_id: STUDENTS_DB }, properties }),
  });
  const created = await createRes.json();
  if (created.object === 'error') {
    return Response.json({ error: created.message || '생성 실패' }, { status: 500 });
  }

  return Response.json({
    ok: true,
    newStudentId: created.id,
    personalKey: newKey,
    copiedFrom: sourceId,
    name, academy, className,
  });
}
