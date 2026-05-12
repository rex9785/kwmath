exports.handler = async function (event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const { password } = JSON.parse(event.body || '{}');

  if (!password || password !== ADMIN_PASSWORD) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: '비밀번호가 올바르지 않습니다.' }),
    };
  }

  // 비밀번호를 토큰으로 사용 (소규모 사이트용 간단 인증)
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ token: ADMIN_PASSWORD, ok: true }),
  };
};
