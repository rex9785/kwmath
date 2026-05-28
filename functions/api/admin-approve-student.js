// POST /api/admin-approve-student  (admin only)
// body: { studentId, action: 'approve' | 'reject' }
//
// approve:
//   1. 학생 page의 "승인 상태" → "승인"
//   2. 학부모/학생 휴대폰으로 계정 생성 (초기 비번 0000, mustChangePassword=true)
//      이미 있는 계정은 스킵
//
// reject:
//   1. 학생 page archive (Notion에서 사라짐)
//   2. 계정은 안 만듦 (애초에 등록 시점에 안 만들었음)

import { normalizePhone, findAccountByPhone, createAccount } from './_auth.js';

const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';
const INITIAL_PASSWORD = '0000';

function isAdmin(request, env) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  return !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });
  if (!isAdmin(request, env))
    return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const studentId = (body.studentId || '').toString().trim();
  const action = (body.action || '').toString();

  if (!studentId) return Response.json({ error: 'studentId 필수' }, { status: 400 });
  if (!['approve', 'reject'].includes(action))
    return Response.json({ error: 'action은 approve 또는 reject' }, { status: 400 });

  const headers = {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  // 학생 페이지 조회
  const pageRes = await fetch(`https://api.notion.com/v1/pages/${studentId}`, { headers });
  const page = await pageRes.json();
  if (page.object === 'error' || !page.properties) {
    return Response.json({ error: '학생을 찾을 수 없습니다: ' + (page.message || '') }, { status: 404 });
  }

  const pp = page.properties;
  const rt = (k) => ((pp[k]?.rich_text || [])[0]?.plain_text || '');
  const ttl = (k) => ((pp[k]?.title || [])[0]?.plain_text || '');
  const name = ttl('이름');
  const parentPhone = rt('학부모 휴대폰');
  const studentPhone = rt('학생 연락처');

  // === REJECT — archive ===
  if (action === 'reject') {
    const ar = await fetch(`https://api.notion.com/v1/pages/${studentId}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ archived: true }),
    });
    if (!ar.ok) {
      const err = await ar.json().catch(() => ({}));
      return Response.json({ error: '거부 처리 실패: ' + (err.message || ar.status) }, { status: 500 });
    }
    return Response.json({
      ok: true, action: 'reject', name, studentId,
      message: `[${name}] 등록 신청이 거부되었습니다 (학생 record archived).`,
    });
  }

  // === APPROVE ===
  // 1) 학생 페이지 "승인 상태" → "승인"
  const ar = await fetch(`https://api.notion.com/v1/pages/${studentId}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({
      properties: {
        '승인 상태': { select: { name: '승인' } },
      },
    }),
  });
  if (!ar.ok) {
    const err = await ar.json().catch(() => ({}));
    return Response.json({ error: '승인 상태 업데이트 실패: ' + (err.message || ar.status) }, { status: 500 });
  }

  // 1-b) 동명이인 alias 자동 부여 — 같은 이름 학생들 중 alias 비어있으면 김수림1/2/3 자동
  let assignedAlias = '';
  let duplicateCount = 0;
  try {
    const sameNameRes = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({
        filter: { property: '이름', title: { equals: name } },
        page_size: 50,
      }),
    });
    const sameNameData = await sameNameRes.json();
    const sameNameStudents = (sameNameData.results || [])
      .filter(p => !p.archived && !p.in_trash);

    duplicateCount = sameNameStudents.length;

    if (sameNameStudents.length >= 2) {
      // 동명이인 발생 — alias 비어있는 학생들에게 자동 부여
      // 등록 순(created_time)으로 정렬해서 1, 2, 3... 부여
      const items = sameNameStudents.map(p => ({
        id: p.id,
        alias: ((p.properties['매쓰플랫 이름']?.rich_text || [])[0]?.plain_text || '').trim(),
        createdAt: p.created_time || '',
      })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      // 이미 사용 중인 번호 추출 (수동 입력 alias 보존)
      const aliasPattern = new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)$');
      const usedNumbers = new Set();
      for (const it of items) {
        const m = it.alias.match(aliasPattern);
        if (m) usedNumbers.add(parseInt(m[1], 10));
      }

      // alias 비어있는 학생에게 다음 사용 가능 번호 부여 (옛 학생 retro 포함)
      let nextNum = 1;
      for (const it of items) {
        if (it.alias) continue;
        while (usedNumbers.has(nextNum)) nextNum++;
        const newAlias = name + nextNum;
        usedNumbers.add(nextNum);
        try {
          await fetch(`https://api.notion.com/v1/pages/${it.id}`, {
            method: 'PATCH', headers,
            body: JSON.stringify({
              properties: { '매쓰플랫 이름': { rich_text: [{ text: { content: newAlias } }] } },
            }),
          });
          it.alias = newAlias;
          if (it.id === studentId) assignedAlias = newAlias;
        } catch (_) {}
        // 다음 iteration에서 while이 다시 used를 스킵하므로 별도 ++ 불필요
      }

      // 본인 alias가 위에서 결정 안 됐다면 (이미 수동으로 채워져 있던 경우) 그 값 사용
      if (!assignedAlias) {
        const me = items.find(it => it.id === studentId);
        if (me) assignedAlias = me.alias;
      }
    }
  } catch (e) {
    // alias 부여 실패는 비치명적 — 승인 자체는 계속 진행
  }

  // 2) 계정 자동 생성 (학부모/학생 phones)
  const accountResult = { created: [], skipped: [], failed: [] };
  const phonesToCreate = [];
  const normP = normalizePhone(parentPhone);
  const normS = normalizePhone(studentPhone);
  if (normP) phonesToCreate.push({ phone: normP, note: 'parent:' + name });
  if (normS && normS !== normP) phonesToCreate.push({ phone: normS, note: 'student:' + name });

  for (const item of phonesToCreate) {
    try {
      const existing = await findAccountByPhone(env, item.phone);
      if (existing) { accountResult.skipped.push(item.phone); continue; }
      const ret = await createAccount(env, item.phone, INITIAL_PASSWORD, true, item.note);
      if (ret.ok) accountResult.created.push(item.phone);
      else accountResult.failed.push(item.phone + ': ' + (ret.error || 'unknown'));
    } catch (e) {
      accountResult.failed.push(item.phone + ': ' + e.message);
    }
  }

  return Response.json({
    ok: true,
    action: 'approve',
    name, studentId,
    account: accountResult,
    initialPassword: INITIAL_PASSWORD,
    assignedAlias,       // 동명이인이면 부여된 매쓰플랫 alias (예: '김수림2')
    duplicateCount,      // 같은 이름 학생 수 (본인 포함)
    message: `[${name}] 등록 승인 완료. 학부모/학생 휴대폰으로 로그인 가능 (초기 비번 ${INITIAL_PASSWORD}).`
      + (assignedAlias ? `\n동명이인 — 매쓰플랫 alias [${assignedAlias}] 자동 부여됨. 매쓰플랫 명단도 같은 이름으로 등록해주세요.` : ''),
  });
}
