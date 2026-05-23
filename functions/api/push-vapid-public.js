// GET /api/push-vapid-public
// 브라우저가 푸쉬 구독 시 사용할 VAPID 공개키를 반환.
// Cloudflare 환경변수 VAPID_PUBLIC_KEY (base64url, raw P-256 공개키 65바이트) 등록 필요.

export async function onRequest({ request, env }) {
  if (request.method !== 'GET')
    return Response.json({ error: 'GET만 허용' }, { status: 405 });

  const key = env.VAPID_PUBLIC_KEY || '';
  if (!key) {
    return Response.json(
      { error: 'VAPID 키 미설정. Cloudflare 환경변수 VAPID_PUBLIC_KEY 등록 필요.' },
      { status: 503 }
    );
  }
  return Response.json({ publicKey: key });
}
