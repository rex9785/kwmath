// POST /api/auth/logout
// 지금 쓰고 있는 학생/학부모 토큰 하나만 서버(R2)에서 폐기한다.
//
// 📓 2026-08-03 (§11-12) 신설. 그전까지 로그아웃은 **브라우저 저장소만 비웠고**, R2의 토큰은 그대로 살아 있었다.
//    verifyToken은 만료만 보고, 접속할 때마다 만료가 30일 뒤로 밀리기 때문에(슬라이딩 갱신)
//    "로그아웃했다"는 사실이 서버에는 전혀 전달되지 않았다. 공용 PC·빌린 폰에서 특히 위험했다.
//
// - 다른 사람 토큰은 못 지운다(폐기 대상 = Authorization 헤더로 제시한 그 토큰 자신).
// - 이미 만료·폐기된 토큰이면 401이 나가는데, 그래도 프론트는 그냥 로그아웃을 진행하면 된다.
// - 원장(adm_)·조교(ast_) 세션은 여기 대상이 아니다. 그쪽은 R2 토큰을 안 쓴다.
import { requireAuth, revokeToken } from '../_auth.js';
import { logAudit } from '../_auditlog.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const auth = await requireAuth(env, request);
  if (!auth.ok) return auth.response;

  await revokeToken(env, auth.token);

  // 📓 "그 폰에서 언제 로그아웃했나"는 분실·공용PC 문의에서 유일한 근거가 된다.
  //    토큰 값 자체는 남기지 않는다(앞 8자만 — 같은 사람의 여러 기기를 구분하는 용도).
  try {
    await logAudit(env, request, {
      action: 'auth.logout',
      actor: auth.phone || null,
      target: auth.phone || '',
      summary: '로그아웃 — 서버 토큰 1개 폐기',
      detail: {
        토큰앞8자: String(auth.token || '').slice(0, 8),
        효과: '이 토큰으로는 더 이상 아무 API도 통과하지 못한다. 같은 계정의 다른 기기는 그대로 로그인 유지.',
      },
    });
  } catch (_) { /* 로그 실패가 로그아웃을 막으면 안 된다 */ }

  return Response.json({ ok: true });
}
