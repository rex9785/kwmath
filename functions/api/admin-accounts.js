// GET /api/admin-accounts?phone=010-1234-5678  (admin only)
// 또는 GET /api/admin-accounts (admin only) — 전체 계정 리스트 (phone + 평문 비번 + 메타)
//
// 응답: { ok, accounts: [ { phone, plaintext, mustChangePassword, lastLogin, note } ] }
// 또는 단일: { ok, account: { phone, plaintext, mustChangePassword, lastLogin, note } }

const ACCOUNTS_DB = '893a626479514059ae309a269b3661b5';

async function queryAccounts(env, phone) {
  const url = `https://api.notion.com/v1/databases/${ACCOUNTS_DB}/query`;
  const body = phone
    ? { filter: { property: '휴대폰', title: { equals: phone } }, page_size: 5 }
    : { page_size: 100 };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

function pageToAccount(page) {
  const p = page.properties || {};
  const titleArr = p['휴대폰']?.title || [];
  const plainArr = p['비밀번호 평문']?.rich_text || [];
  const noteArr  = p['비고']?.rich_text || [];
  return {
    phone:              titleArr.map(t => t.plain_text || '').join(''),
    plaintext:          plainArr.map(t => t.plain_text || '').join(''),
    mustChangePassword: p['변경 필요']?.checkbox === true,
    lastLogin:          p['마지막 로그인']?.date?.start || '',
    note:               noteArr.map(t => t.plain_text || '').join(''),
  };
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET')
    return Response.json({ error: 'GET만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  const url = new URL(request.url);
  const phone = (url.searchParams.get('phone') || '').trim();

  try {
    const data = await queryAccounts(env, phone);
    if (data.object === 'error') {
      return Response.json({ error: data.message || 'Notion 조회 실패' }, { status: 500 });
    }
    const results = (data.results || []).filter(p => !p.archived && !p.in_trash).map(pageToAccount);

    if (phone) {
      // 단일 조회 — 첫 매칭만 반환
      if (!results.length) return Response.json({ error: '계정을 찾을 수 없습니다.' }, { status: 404 });
      return Response.json({ ok: true, account: results[0] });
    }
    // 전체 리스트
    return Response.json({ ok: true, accounts: results });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
