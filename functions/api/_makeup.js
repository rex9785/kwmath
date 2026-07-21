// functions/api/_makeup.js
// ───────────────────────────────────────────────────────────
// 인강 신청/해제 (makeup grants)
//   · 출석/지각한 날만 그날 "수업 영상 + 수업자료"가 열린다. 결석·병결·공결이거나 출석기록이 아예 없는 날은 자동 잠금(2026-07-21 정책B — 전입/신규생 무단열람 차단).
//   · 학생/학부모가 "인강 신청"하면 status=requested.
//   · 관우T(원장)·조교가 승인하면 status=approved → 그날 잠금 해제.
//   · 관우T는 신청이 없어도 직접 approved로 grant 가능. approved를 revoke하면 다시 잠김.
//   makeup_grants: (student_id, date) PK, status ∈ {requested, approved}.
//   마이그레이션 러너가 없으므로 첫 사용 시 CREATE TABLE IF NOT EXISTS (아이솔레이트당 1회) — clinic 패턴과 동일.
// ───────────────────────────────────────────────────────────
import { getAttendance } from './_db.js';

// 수업 안 온 상태 = 영상·자료 잠금 대상. 지각·출석은 잠그지 않는다(관우T 확정: "수업안오면 다 막고").
export const BLOCK_STATUS = new Set(['결석', '병결', '공결']);
export function isBlockStatus(s) { return BLOCK_STATUS.has(s); }
// 온 것으로 치는 상태 = 그날 영상·자료 열림. (출결 상태는 이 5개뿐: 출석·지각·결석·병결·공결 — attendance.html 범례 확인)
export const PRESENT_STATUS = new Set(['출석', '지각']);

// ── student_id 정규화 ────────────────────────────────────────
//   D1은 JS 숫자를 REAL로 바인딩 → student_id(TEXT affinity) 칸에 "24.0"으로 저장되는 과거 버그가 있었다.
//   읽을 땐 숫자 24 → TEXT affinity가 "24"로 강제 → "24.0"과 문자열 불일치 → 승인해도 안 열림.
//   normSid: 어떤 형태든 표준 문자열("24")로. sidPair: 조회 시 신·구("24","24.0") 둘 다 매칭.
//   모든 write는 표준형("24")으로 저장하고, UPDATE는 student_id도 표준형으로 덮어 과거 "24.0" 행을 수렴시킨다.
function normSid(id) { return String(id == null ? '' : id).trim().replace(/\.0+$/, ''); }
function sidPair(id) { const s = normSid(id); return [s, s + '.0']; }

// 파일명 등 텍스트에서 6자리 YYMMDD(앞뒤로 다른 숫자가 붙지 않은 독립 6자리)를 찾아 'YYYY-MM-DD'로 변환.
//   관우T 규칙: 자료 이름에 "260714 수업자료"처럼 6자리 숫자로 날짜를 적고, 6자리로만 판단.
//   여러 숫자가 섞여도 유효한 월(01~12)·일(01~31)인 첫 6자리만 날짜로 인정. 없으면 null.
export function sessionDateFromText(text) {
  const s = String(text || '');
  const re = /(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)/g;
  let m;
  while ((m = re.exec(s))) {
    const mm = +m[2], dd = +m[3];
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return '20' + m[1] + '-' + m[2] + '-' + m[3];
    }
  }
  return null;
}

let _ready = false;
async function ensure(env) {
  if (_ready) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS makeup_grants (' +
    'student_id TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL, ' +
    'requested_at TEXT, approved_at TEXT, approved_by TEXT, ' +
    'PRIMARY KEY (student_id, date))'
  ).run();
  _ready = true;
}

// 특정 학생의 신청·해제 목록 (video/자료 잠금 판정용). [{date, status}]
export async function listGrantsForStudent(env, studentId) {
  await ensure(env);
  const [a, b] = sidPair(studentId);   // 신·구("24","24.0") 둘 다 매칭
  const { results } = await env.DB.prepare(
    'SELECT date, status FROM makeup_grants WHERE student_id = ? OR student_id = ?'
  ).bind(a, b).all();
  return results || [];
}

// 학생/학부모 인강 신청 — 이미 approved면 그대로 두고(다운그레이드 금지), 없으면 requested로 생성.
export async function requestMakeup(env, studentId, date) {
  await ensure(env);
  try {
    const now = new Date().toISOString();
    const [a, b] = sidPair(studentId);
    const existing = await env.DB.prepare(
      'SELECT status FROM makeup_grants WHERE (student_id=? OR student_id=?) AND date=?'
    ).bind(a, b, date).first();
    if (existing) return { ok: true, status: existing.status };  // approved/requested 유지
    await env.DB.prepare(
      'INSERT INTO makeup_grants (student_id, date, status, requested_at) VALUES (?,?,?,?)'
    ).bind(a, date, 'requested', now).run();   // 표준형("24")으로 저장
    return { ok: true, status: 'requested', created: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 관리자 승인/직접해제 — requested든 없든 approved로 (upsert).
export async function approveMakeup(env, studentId, date, approvedBy) {
  await ensure(env);
  try {
    const now = new Date().toISOString();
    const [a, b] = sidPair(studentId);
    const existing = await env.DB.prepare(
      'SELECT student_id FROM makeup_grants WHERE (student_id=? OR student_id=?) AND date=?'
    ).bind(a, b, date).first();
    if (existing) {
      // student_id도 표준형("24")으로 덮어 과거 "24.0" 행을 수렴시킨다.
      await env.DB.prepare(
        'UPDATE makeup_grants SET student_id=?, status=?, approved_at=?, approved_by=? WHERE (student_id=? OR student_id=?) AND date=?'
      ).bind(a, 'approved', now, approvedBy || '', a, b, date).run();
    } else {
      await env.DB.prepare(
        'INSERT INTO makeup_grants (student_id, date, status, requested_at, approved_at, approved_by) VALUES (?,?,?,?,?,?)'
      ).bind(a, date, 'approved', now, now, approvedBy || '').run();
    }
    return { ok: true, status: 'approved' };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 해제 취소(다시 잠금) — 행 삭제.
export async function revokeMakeup(env, studentId, date) {
  await ensure(env);
  try {
    const [a, b] = sidPair(studentId);   // 신·구("24","24.0") 둘 다 삭제
    const res = await env.DB.prepare(
      'DELETE FROM makeup_grants WHERE (student_id=? OR student_id=?) AND date=?'
    ).bind(a, b, date).run();
    return { ok: true, removed: (res.meta && res.meta.changes) || 0 };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 관리자 화면용 — 전체 목록(학생 이름 join). status로 필터 옵션. 최신 날짜 먼저.
export async function listAllGrants(env, status) {
  await ensure(env);
  let sql =
    'SELECT g.student_id, s.name, g.date, g.status, g.requested_at, g.approved_at, g.approved_by ' +
    'FROM makeup_grants g LEFT JOIN students s ON s.id = g.student_id';
  const vals = [];
  if (status) { sql += ' WHERE g.status = ?'; vals.push(status); }
  sql += ' ORDER BY (g.status=\'requested\') DESC, g.date DESC';
  const { results } = await env.DB.prepare(sql).bind(...vals).all();
  return results || [];
}

// 특정 학생의 잠금 컨텍스트: present(출석/지각한 날), blocked(결석계열 날짜), approved(승인 날짜), requested(신청만 된 날짜).
//   isLocked(date) = ¬present ∧ ¬approved  (2026-07-21 정책B: 온 날 또는 내가 승인한 날만 열림. 결석계열·기록없는 날은 잠금.)
//   ※ 이전 로직은 blocked ∧ ¬approved 라 "결석 기록이 있어야만" 잠겨서, 출석기록이 0인 전입/신규생은 전 영상이 열렸음.
export async function absenceLockContext(env, studentId) {
  const [{ records }, grants] = await Promise.all([
    getAttendance(env, studentId),
    listGrantsForStudent(env, studentId),
  ]);
  const present = new Set(), blocked = new Set(), approved = new Set(), requested = new Set();
  for (const [date, rec] of Object.entries(records || {})) {
    if (!rec) continue;
    if (BLOCK_STATUS.has(rec.status)) blocked.add(date);
    else if (PRESENT_STATUS.has(rec.status)) present.add(date);
  }
  for (const g of grants) {
    if (g.status === 'approved') approved.add(g.date);
    else if (g.status === 'requested') requested.add(g.date);
  }
  return { present, blocked, approved, requested };
}

// 잠김 = 그날 출석/지각 기록이 없고(=안 왔거나 기록 자체가 없음) 승인도 안 된 날.
//   전입/신규생은 출석기록이 없어 present 공집합 → 승인 전까지 전부 잠김. 앞으로 출석 찍으면 그날부터 열림.
export function isLocked(ctx, date) {
  if (!date) return false;
  if (ctx.approved.has(date)) return false;
  return !ctx.present.has(date);
}
