// _prefs.js — 사용자별 '푸시 카테고리 선호' (R2: push-prefs/{userId}.json)
// ───────────────────────────────────────────────────────────
// 목적: 푸시를 통째로 끄지 않고 '종류별'로 조절. 지금은 'study'(KW-Study 추월 알림)만.
//   전체 알림(리포트·공지 등)은 push-subscribe 구독이 담당하고, 이 파일은 그 위에서
//   "이 종류는 빼고 보내자"를 판단하는 카테고리 필터만 맡는다.
// 저장: R2 key = push-prefs/{userId}.json
//   { userId, prefs: { study: true|false, ... }, updatedAt }
// 기본값: 파일/키가 없으면 '켜짐'(true)으로 간주 — 아무것도 안 만진 사용자는 기존처럼 다 받는다.
//   즉 사용자가 명시적으로 false 로 저장했을 때만 그 카테고리를 끈다.
// userId = 휴대폰번호(학생/학부모) 또는 '__admin__'. push-subs 와 동일 키 규칙.
// 절대 throw 하지 않음(푸시 경로에서 호출되므로) — 문제가 있으면 '켜짐'으로 폴백.
// ───────────────────────────────────────────────────────────

const prefKey = (userId) => `push-prefs/${encodeURIComponent(String(userId))}.json`;

// 원본 prefs 객체 반환({}면 기본값=모두 ON). 절대 throw 안 함.
export async function getPushPrefs(env, userId) {
  try {
    if (!userId || !env || !env.BUCKET) return {};
    const obj = await env.BUCKET.get(prefKey(userId));
    if (!obj) return {};
    const j = JSON.parse(await obj.text());
    if (j && typeof j === 'object' && j.prefs && typeof j.prefs === 'object') return j.prefs;
  } catch (_) {}
  return {};
}

// 특정 카테고리가 켜져 있는지. 기본 ON — 명시적 false 일 때만 OFF. 절대 throw 안 함.
export async function isPushCategoryOn(env, userId, category) {
  try {
    const prefs = await getPushPrefs(env, userId);
    return prefs[category] !== false;
  } catch (_) { return true; }
}

// 카테고리 켜기/끄기 저장.
// 반환: { prefs, before, key, 새파일 }
//   ⚠️ 이 파일은 request 를 받지 않는 헬퍼다 → 여기서 logAudit 을 부르면 누가·어느 기기로 껐는지가 전부 NULL 이 된다.
//      그래서 **before 를 돌려주기만** 하고, 로그는 request 를 쥔 호출측(push-prefs.js)이 남긴다.
//   ⚠️ before 는 반드시 깊은 복사로 떠 둔다. 아래 record.prefs[category] 가 읽어온 객체를 그 자리에서 고치기 때문에,
//      그냥 참조를 들고 있으면 로그에 전/후가 똑같이 찍힌다(이 프로젝트에서 실제로 겪은 함정).
export async function setPushPref(env, userId, category, on) {
  const key = prefKey(userId);
  let record = { userId: String(userId), prefs: {}, updatedAt: '' };
  let 새파일 = true;
  try {
    const existing = await env.BUCKET.get(key);
    if (existing) {
      새파일 = false;
      const j = JSON.parse(await existing.text());
      if (j && typeof j === 'object' && j.prefs && typeof j.prefs === 'object') record.prefs = j.prefs;
    }
  } catch (_) {}
  let before;
  try { before = JSON.parse(JSON.stringify(record.prefs)); } catch (_) { before = {}; }
  record.prefs[category] = !!on;
  record.userId = String(userId);
  record.updatedAt = new Date().toISOString();
  await env.BUCKET.put(key, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
  return { prefs: record.prefs, before, key, 새파일 };
}
