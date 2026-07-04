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

// 카테고리 켜기/끄기 저장. 갱신된 prefs 반환.
export async function setPushPref(env, userId, category, on) {
  const key = prefKey(userId);
  let record = { userId: String(userId), prefs: {}, updatedAt: '' };
  try {
    const existing = await env.BUCKET.get(key);
    if (existing) {
      const j = JSON.parse(await existing.text());
      if (j && typeof j === 'object' && j.prefs && typeof j.prefs === 'object') record.prefs = j.prefs;
    }
  } catch (_) {}
  record.prefs[category] = !!on;
  record.userId = String(userId);
  record.updatedAt = new Date().toISOString();
  await env.BUCKET.put(key, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
  return record.prefs;
}
