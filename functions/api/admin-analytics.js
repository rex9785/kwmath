// 관리자 전용 — Cloudflare Web Analytics(RUM) 방문 통계 조회
// 필요한 env: ADMIN_PASSWORD, CF_ANALYTICS_TOKEN
// 인증: Authorization: Bearer <ADMIN_PASSWORD>
//   (_middleware.js 가 관리자 세션토큰(adm_)/쿠키를 이 형태로 번역해 줌)

const ACCOUNT_TAG = '8a4345aa80570af6f8c1d2b3e04eb638';
const GQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

function ymd(d) {
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  // 관리자 인증 (미들웨어가 admin 세션토큰/쿠키를 Bearer ADMIN_PASSWORD 로 번역)
  const auth = request.headers.get('Authorization') || '';
  if (!env.ADMIN_PASSWORD || auth !== 'Bearer ' + env.ADMIN_PASSWORD) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!env.CF_ANALYTICS_TOKEN) {
    return json({ configured: false, error: 'CF_ANALYTICS_TOKEN 환경변수가 없습니다.' });
  }

  const now = new Date();
  const end = ymd(now);
  const today = end;
  const d7 = new Date(now); d7.setUTCDate(d7.getUTCDate() - 6);
  const d30 = new Date(now); d30.setUTCDate(d30.getUTCDate() - 29);
  const week = ymd(d7), month = ymd(d30);

  const grp = (geq, leq, daily) =>
    'rumPageloadEventsAdaptiveGroups(limit:' + (daily ? 90 : 1) +
    ', filter:{date_geq:"' + geq + '", date_leq:"' + leq + '"}){ count sum{ visits }' +
    (daily ? ' dimensions{ date }' : '') + ' }';

  const query = '{ viewer { accounts(filter:{accountTag:"' + ACCOUNT_TAG + '"}) {' +
    ' today: ' + grp(today, end, false) +
    ' week: ' + grp(week, end, false) +
    ' month: ' + grp(month, end, false) +
    ' daily: ' + grp(month, end, true) +
    ' } } }';

  let resp;
  try {
    resp = await fetch(GQL_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.CF_ANALYTICS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });
  } catch (e) {
    return json({ configured: true, error: 'Cloudflare 호출 실패' }, 502);
  }

  const data = await resp.json().catch(() => null);
  if (!data) return json({ configured: true, error: '응답 파싱 실패' }, 502);
  if (data.errors && data.errors.length) {
    return json({ configured: true, error: 'GraphQL 오류', detail: data.errors.map(e => e.message).slice(0, 3) }, 502);
  }

  const acc = data.data && data.data.viewer && data.data.viewer.accounts && data.data.viewer.accounts[0];
  const pick = (g) => {
    const x = (g && g[0]) || {};
    return { views: x.count || 0, visits: (x.sum && x.sum.visits) || 0 };
  };
  const daily = (acc && acc.daily ? acc.daily : []).map(x => ({
    date: x.dimensions && x.dimensions.date,
    views: x.count || 0,
    visits: (x.sum && x.sum.visits) || 0
  })).sort((a, b) => (a.date < b.date ? -1 : 1));

  return json({
    configured: true,
    updatedAt: new Date().toISOString(),
    today: pick(acc && acc.today),
    week: pick(acc && acc.week),
    month: pick(acc && acc.month),
    daily
  });
}
