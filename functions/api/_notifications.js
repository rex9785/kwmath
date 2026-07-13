// functions/api/_notifications.js
// ───────────────────────────────────────────────────────────
// 알림함(notifications) — 학부모/학생 앱 인박스에 쌓이는 "시간순 알림 기록".
//   출결 트리거(결석·숙제 25%↓)·클리닉 미참석 연락 등이 여기에 한 줄씩 쌓이고,
//   병행해서 푸시(_push.js)도 나간다. 출석 달력이 '상태 조회'라면 이건 '알림 타임라인'.
//   접근은 student_id 기준(포털 인증이 phone → 자녀 student_id 목록으로 스코프).
//   마이그레이션 러너 없으니 첫 사용 시 CREATE TABLE IF NOT EXISTS(아이솔레이트당 1회).
// ───────────────────────────────────────────────────────────

let _ready = false;
async function ensureNotifications(env) {
  if (_ready) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS notifications (' +
    'id TEXT PRIMARY KEY, student_id TEXT NOT NULL, type TEXT, ' +
    'title TEXT, body TEXT, url TEXT, ' +
    'created_at TEXT, read_at TEXT, dedup_key TEXT)'
  ).run();
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_notif_student ON notifications (student_id, created_at)').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_notif_dedup ON notifications (dedup_key)').run(); } catch (_) {}
  // audience: 수신 대상 — 'parent'(학부모만) · 'student'(학생만) · 'all'/NULL(둘 다). 옛 행은 NULL=전체 노출(무회귀).
  try { await env.DB.prepare('ALTER TABLE notifications ADD COLUMN audience TEXT').run(); } catch (_) {}
  _ready = true;
}

function uuid() {
  try { if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID(); } catch (_) {}
  return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function rowToNotif(r) {
  return {
    id: r.id, studentId: r.student_id, type: r.type || '',
    title: r.title || '', body: r.body || '', url: r.url || '',
    createdAt: r.created_at || '', read: !!r.read_at,
  };
}

// ── 수신 대상(audience) 스코프 → SQL WHERE 조각 + 바인드 ──
//   scope 형태:
//     - 배열 [id,...]  → 하위호환: 전체 조회(관리자/옛 호출부). audience 무시.
//     - { allIds, parentIds, studentIds }
//         allIds     : audience 무시하고 전부 (관우T가 학생별 조회 시)
//         parentIds  : 학부모 로그인 → audience IN (NULL,'all','parent')
//         studentIds : 학생 본인 로그인 → audience IN (NULL,'all','student')
function normalizeScope(scope) {
  if (Array.isArray(scope)) return { allIds: scope.filter(Boolean), parentIds: [], studentIds: [] };
  const s = scope || {};
  return {
    allIds: (s.allIds || []).filter(Boolean),
    parentIds: (s.parentIds || []).filter(Boolean),
    studentIds: (s.studentIds || []).filter(Boolean),
  };
}
function scopeWhere(scope) {
  const s = normalizeScope(scope);
  const parts = []; const binds = [];
  if (s.allIds.length) {
    parts.push('student_id IN (' + s.allIds.map(() => '?').join(',') + ')');
    binds.push(...s.allIds);
  }
  if (s.parentIds.length) {
    parts.push('(student_id IN (' + s.parentIds.map(() => '?').join(',') + ") AND (audience IS NULL OR audience IN ('all','parent')))");
    binds.push(...s.parentIds);
  }
  if (s.studentIds.length) {
    parts.push('(student_id IN (' + s.studentIds.map(() => '?').join(',') + ") AND (audience IS NULL OR audience IN ('all','student')))");
    binds.push(...s.studentIds);
  }
  if (!parts.length) return { where: '1=0', binds: [] };
  return { where: '(' + parts.join(' OR ') + ')', binds };
}

// 알림 1건 생성. dedupKey가 있고 이미 있으면 재삽입 안 함(created:false) — 같은 날 결석 두 번 눌러도 1건.
export async function createNotification(env, { studentId, type, title, body, url, dedupKey, audience }) {
  await ensureNotifications(env);
  if (!studentId) return { ok: false, error: 'studentId 필수' };
  try {
    if (dedupKey) {
      const existing = await env.DB.prepare('SELECT id FROM notifications WHERE dedup_key=?').bind(dedupKey).first();
      if (existing) return { ok: true, created: false, id: existing.id };
    }
    const id = uuid();
    await env.DB.prepare(
      'INSERT INTO notifications (id, student_id, type, title, body, url, created_at, read_at, dedup_key, audience) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).bind(id, studentId, type || '', title || '', body || '', url || '', new Date().toISOString(), null, dedupKey || null, audience || null).run();
    return { ok: true, created: true, id };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 여러 자녀의 알림을 시간 역순으로. scope는 배열(전체) 또는 {allIds,parentIds,studentIds}. limit 기본 100(최대 300).
export async function listNotifications(env, scope, limit) {
  await ensureNotifications(env);
  const { where, binds } = scopeWhere(scope);
  if (where === '1=0') return [];
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const { results } = await env.DB.prepare(
    'SELECT * FROM notifications WHERE ' + where + ' ORDER BY created_at DESC LIMIT ' + lim
  ).bind(...binds).all();
  return (results || []).map(rowToNotif);
}

export async function countUnread(env, scope) {
  await ensureNotifications(env);
  const { where, binds } = scopeWhere(scope);
  if (where === '1=0') return 0;
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND ' + where
  ).bind(...binds).first();
  return (row && row.n) || 0;
}

// 특정 알림 읽음 처리(자녀 소유 + 수신대상 확인). 반환 changed 수.
export async function markRead(env, id, scope) {
  await ensureNotifications(env);
  const { where, binds } = scopeWhere(scope);
  if (!id || where === '1=0') return { ok: true, changed: 0 };
  try {
    const res = await env.DB.prepare(
      'UPDATE notifications SET read_at=? WHERE id=? AND read_at IS NULL AND ' + where
    ).bind(new Date().toISOString(), id, ...binds).run();
    return { ok: true, changed: (res.meta && res.meta.changes) || 0 };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function markAllRead(env, scope) {
  await ensureNotifications(env);
  const { where, binds } = scopeWhere(scope);
  if (where === '1=0') return { ok: true, changed: 0 };
  try {
    const res = await env.DB.prepare(
      'UPDATE notifications SET read_at=? WHERE read_at IS NULL AND ' + where
    ).bind(new Date().toISOString(), ...binds).run();
    return { ok: true, changed: (res.meta && res.meta.changes) || 0 };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 관리자 화면용: 특정 학생 알림(최근). 관우T가 "무슨 알림 나갔나" 확인.
export async function listNotificationsByStudentId(env, studentId, limit) {
  return listNotifications(env, [studentId], limit);
}
