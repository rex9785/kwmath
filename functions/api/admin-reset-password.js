// POST /api/admin-reset-password (admin only)
// body: { phone: "010-1234-5678" }
// 효과: 해당 계정 비밀번호를 '0000'으로 리셋 + mustChangePassword=true
// 학부모/학생이 다시 0000으로 로그인하면 강제 비번 변경 화면 뜸

import { findAccountByPhone, updateAccountPassword } from './_auth.js';

const INITIAL_PASSWORD = '0000';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const phone = (body.phone || '').toString().trim();
  if (!phone) return Response.json({ error: 'phone 필요 (010-XXXX-XXXX)' }, { status: 400 });

  try {
    const account = await findAccountByPhone(env, phone);
    if (!account) return Response.json({ error: '해당 휴대폰의 계정을 찾을 수 없습니다.' }, { status: 404 });

    const result = await updateAccountPassword(env, account.id, INITIAL_PASSWORD);
    if (!result.ok) {
      return Response.json({ error: result.error || '비번 리셋 실패' }, { status: 500 });
    }

    // mustChangePassword=true 로 재설정 (updateAccountPassword는 false로 변경하니까 명시적으로 true 덮어쓰기)
    try {
      await fetch(`https://api.notion.com/v1/pages/${account.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          properties: { '변경 필요': { checkbox: true } },
        }),
      });
    } catch (e) { /* 비치명적 */ }

    return Response.json({
      ok: true,
      phone,
      message: '비밀번호가 0000으로 초기화되었습니다. 학부모/학생에게 알려주세요.',
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
