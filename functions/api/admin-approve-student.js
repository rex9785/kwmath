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
    message: `[${name}] 등록 승인 완료. 학부모/학생 휴대폰으로 로그인 가능 (초기 비번 ${INITIAL_PASSWORD}).`,
  });
}
