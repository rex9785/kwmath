// /api/app-version
// 강제업데이트 게이트 — 앱이 부팅 때 호출해 "이 버전 이상이어야 한다"를 받아간다.
//
// GET  (공개·무인증): { ios:{min,url}, android:{min,url} } 반환.
//        앱(Capacitor)에서 현재 설치 버전이 min보다 낮으면 portal.html이 업데이트 화면을 띄움.
//        ⚠️ 공개 GET이라 _middleware의 PUBLIC_API Set에도 '/api/app-version' 추가해야 '*' CORS.
//           (앱은 same-origin이라 없어도 동작하지만, 혹시 모를 외부 호출 대비/일관성 위해 추가.)
// POST (관리자 전용): { ios?, android? } 최소버전 변경. _middleware가 adm_ 세션을
//        Bearer ADMIN_PASSWORD로 번역해 줌 → 여기서 검증. STAFF_WRITE_ALLOW에 없음 = 조교 불가.
//
// 기본 최소버전 = 현재 심사 중인 빌드 버전(iOS 1.0.2 / 안드 2.0.1).
//   → 심사위원은 이 버전을 테스트하므로 "같음"=통과(차단 안 됨). 그보다 낮은 구버전만 차단.
//   원장이 admin에서 조정 가능(단, 심사 중 버전을 초과하면 심사위원이 막혀 반려되니 주의).

import { getAppConfig, setAppConfig } from './_db.js';

const DEFAULT_MIN = { ios: '1.0.2', android: '2.0.1' };
const STORE_URL = {
  ios: 'https://apps.apple.com/app/id6778222395',
  android: 'https://play.google.com/store/apps/details?id=kr.co.kwmath.app',
};
const KEY = { ios: 'min_ver_ios', android: 'min_ver_android' };

// "1.0.2" 형식 검증 — 숫자 1~4마디(점 구분). 공백 허용 후 trim.
function validVer(v) {
  return typeof v === 'string' && /^\d{1,4}(\.\d{1,4}){0,3}$/.test(v.trim());
}

async function readMin(env, plat) {
  try {
    const v = await getAppConfig(env, KEY[plat]);
    if (validVer(v)) return v.trim();
  } catch (_) { /* D1 실패 → 기본값 */ }
  return DEFAULT_MIN[plat];
}

export async function onRequest({ request, env }) {
  const method = request.method.toUpperCase();

  // ── GET: 공개. 현재 최소버전 + 스토어 URL ──
  if (method === 'GET') {
    const [ios, android] = await Promise.all([readMin(env, 'ios'), readMin(env, 'android')]);
    return Response.json({
      ios: { min: ios, url: STORE_URL.ios },
      android: { min: android, url: STORE_URL.android },
    });
  }

  // ── POST: 관리자만. 최소버전 변경 ──
  if (method === 'POST') {
    const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
    const isAdmin = !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
    if (!isAdmin) return Response.json({ error: '관리자만 변경할 수 있어요.' }, { status: 403 });

    let body = {};
    try { body = await request.json(); } catch (_) {}

    const updates = [];
    if (body.ios !== undefined) {
      if (!validVer(body.ios)) return Response.json({ error: 'iOS 버전 형식이 올바르지 않아요 (예: 1.0.2)' }, { status: 400 });
      updates.push(['ios', String(body.ios).trim()]);
    }
    if (body.android !== undefined) {
      if (!validVer(body.android)) return Response.json({ error: '안드로이드 버전 형식이 올바르지 않아요 (예: 2.0.1)' }, { status: 400 });
      updates.push(['android', String(body.android).trim()]);
    }
    if (!updates.length) return Response.json({ error: '변경할 버전(ios/android)을 보내주세요.' }, { status: 400 });

    for (const [plat, ver] of updates) {
      const r = await setAppConfig(env, KEY[plat], ver);
      if (!r.ok) return Response.json({ error: 'DB 저장 실패: ' + r.error }, { status: 500 });
    }

    const [ios, android] = await Promise.all([readMin(env, 'ios'), readMin(env, 'android')]);
    return Response.json({ ok: true, ios: { min: ios, url: STORE_URL.ios }, android: { min: android, url: STORE_URL.android } });
  }

  return Response.json({ error: 'GET 또는 POST만 허용' }, { status: 405 });
}
