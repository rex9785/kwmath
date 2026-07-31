// functions/api/_db.js
// ───────────────────────────────────────────────────────────
// D1 추상화 레이어 (Phase 2 / 2026-05-31)
// API 파일들은 Notion/R2 직접 호출 대신 이 함수들을 사용한다.
// env.DB = Cloudflare D1 (wrangler.toml [[d1_databases]] binding="DB", database=kwmath)
//
// ⚠️ 배포·실측 테스트 전. Phase 3(데이터 이전) 후 Phase 4에서 API들이 이걸
//    호출하도록 전환한다. 토큰/인증(issueToken/verifyToken)은 _auth.js(R2) 유지.
//    반환 모양은 현재 API 응답과 동일하게 맞춤(전환 시 호출부만 교체).
// ───────────────────────────────────────────────────────────
import { hashPassword } from './_auth.js';

// ── 행 → API 객체 매핑 ──
function rowToStudent(r) {
  if (!r) return null;
  let goals = [], days = [];
  try { goals = r.purposes   ? JSON.parse(r.purposes)   : []; } catch (_) {}
  try { days  = r.avail_days ? JSON.parse(r.avail_days) : []; } catch (_) {}
  return {
    id: r.id,
    name: r.name || '',
    school: r.school || '',
    grade: r.grade || '',
    parentPhone4: r.parent_last4 || '',
    studentPhone: r.student_phone || '',
    parentPhone: r.parent_phone || '',
    parentRelation: r.parent_relation || '',
    goals,
    level: r.cur_math_grade || '',
    academy: r.academy || '',
    className: r.class_name || '',
    mathMockGrade: r.mock_math_grade || '',
    mathMockScore: (r.mock_math_raw === null || r.mock_math_raw === undefined) ? null : r.mock_math_raw,
    korMockGrade: r.mock_kor_grade || '',
    engMockGrade: r.mock_eng_grade || '',
    schoolMathGrade: r.school_math_grade || '',
    advanceProgress: r.prior_progress || '',
    weakness: r.weak_units || '',
    dreamUniv: r.target_univ || '',
    availableDays: days,
    notes: r.notes || '',
    referral: r.referral || '',
    referralDetail: r.referral_detail || '',
    approvalStatus: r.approval_status || '',
    mathPlatName: r.mathflat_name || '',
    createdAt: r.created_at || '',
  };
}

function rowToReport(r) {
  return {
    id: r.id,
    title: r.title || '',
    studentName: r.student_name || '',
    phone4: r.phone_last4 || '',
    date: r.class_date || '',
    school: r.academy || '',
    content: r.content || '',
    homework: r.homework || '',
    notes: r.notes || '',
    class_name: '',
  };
}

function attRecord(r) {
  const rec = { status: r.status };
  if (r.homework !== null && r.homework !== undefined) rec.homework = r.homework;
  if (r.homework_note) rec.homework_note = r.homework_note;
  if (r.note) rec.note = r.note;
  if (r.method) rec.method = r.method;
  return rec;
}

// ════════════ 계정 ════════════
export async function findAccountByPhone(env, phone) {
  if (!phone) return null;
  const r = await env.DB.prepare(
    'SELECT phone, password_hash, salt, must_change_pw FROM accounts WHERE phone = ?'
  ).bind(phone).first();
  if (!r) return null;
  return {
    id: r.phone,                 // 레거시 호환(일부 코드가 account.id 사용)
    phone: r.phone,
    hash: r.password_hash,
    salt: r.salt,
    mustChangePassword: r.must_change_pw === 1,
  };
}

export async function createAccount(env, phone, password, mustChangePassword = true, note = '') {
  const { hash, salt } = await hashPassword(password);
  try {
    await env.DB.prepare(
      'INSERT INTO accounts (phone, password_hash, salt, must_change_pw, note) VALUES (?,?,?,?,?) ' +
      'ON CONFLICT(phone) DO UPDATE SET password_hash=excluded.password_hash, salt=excluded.salt, ' +
      'must_change_pw=excluded.must_change_pw, note=excluded.note'
    ).bind(phone, hash, salt, mustChangePassword ? 1 : 0, note || '').run();
    return { ok: true, id: phone };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function updateAccountPassword(env, phone, newPassword) {
  const { hash, salt } = await hashPassword(newPassword);
  try {
    await env.DB.prepare('UPDATE accounts SET password_hash=?, salt=?, must_change_pw=0 WHERE phone=?')
      .bind(hash, salt, phone).run();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function touchLastLogin(env, phone) {
  try {
    await env.DB.prepare('UPDATE accounts SET last_login=? WHERE phone=?')
      .bind(new Date().toISOString(), phone).run();
  } catch (_) { /* 비치명적 */ }
}

// ════════════ 학생 ════════════
export async function getStudentsByPhone(env, phone) {
  if (!phone) return [];
  const { results } = await env.DB.prepare(
    'SELECT * FROM students WHERE parent_phone = ? OR student_phone = ? ORDER BY id'
  ).bind(phone, phone).all();
  return (results || []).map(r => {
    const s = rowToStudent(r);
    s.role = (phone === r.student_phone) ? 'student'
           : (phone === r.parent_phone ? 'parent' : 'other');
    return s;
  });
}

export async function getStudentById(env, id) {
  const r = await env.DB.prepare('SELECT * FROM students WHERE id = ?').bind(id).first();
  return rowToStudent(r);
}

export async function getStudentByName(env, name) {
  const r = await env.DB.prepare('SELECT * FROM students WHERE name = ? ORDER BY id LIMIT 1').bind(name).first();
  return rowToStudent(r);
}

// 🆔 id(권장) 우선 → 없으면 name(구버전 호환)으로 학생 1명 해석.
//   ⚠️ 동명이인이 있으면 name 경로는 먼저 등록된 1명만 잡힌다(위 ORDER BY id LIMIT 1).
//      그래서 저장·삭제 같은 쓰기 경로는 반드시 id를 보낼 것.
//      (2026-07-29 도입: staff-students.html 출결·클리닉 쓰기가 이름 기반이라 남의 기록에 저장될 위험이 있었음)
export async function resolveStudent(env, rawId, rawName) {
  const id = (rawId === undefined || rawId === null) ? '' : String(rawId).trim();
  if (id) {
    const n = Number(id);
    return await getStudentById(env, (Number.isInteger(n) && String(n) === id) ? n : id);
  }
  const name = (rawName || '').trim();
  if (!name) return null;
  return await getStudentByName(env, name);
}

// ── 운영진(원장) 학생 명단 제외 ──
// 원장(관우T)은 admin 계정으로 로그인하므로 학생 목록·반 편성·리포트 명단에 노출하지 않는다.
// (login.js·staff-register.js·me.js의 ADMIN_PHONES와 동일하게 유지)
// ※ 학생 레코드 자체는 보존 — '표시'에서만 제외. 되돌리려면 이 필터만 제거. 계정·로그인엔 영향 없음.
const OWNER_PHONES = new Set(['01041149785']);
function _isOwnerStudent(s) {
  const d = (p) => String(p || '').replace(/\D/g, '');
  return !!s && (OWNER_PHONES.has(d(s.studentPhone)) || OWNER_PHONES.has(d(s.parentPhone)));
}

export async function listStudents(env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM students ORDER BY created_at DESC, id DESC'
  ).all();
  return (results || []).map(rowToStudent).filter(s => s && !_isOwnerStudent(s));
}

export async function createStudent(env, data) {
  const cols = {
    name: data.name || '',
    school: data.school || '',
    grade: data.grade || '',
    parent_last4: data.parentPhone4 || '',
    student_phone: data.studentPhone || '',
    parent_phone: data.parentPhone || '',
    parent_relation: data.parentRelation || '',
    purposes: JSON.stringify(Array.isArray(data.goals) ? data.goals : (data.goals ? [data.goals] : [])),
    cur_math_grade: data.level || '',
    academy: data.academy || '대치동 정규반',
    class_name: data.className || '',
    mock_math_grade: data.mathMockGrade || '',
    mock_math_raw: (data.mathMockScore === '' || data.mathMockScore === null || data.mathMockScore === undefined) ? null : Number(data.mathMockScore),
    mock_kor_grade: data.korMockGrade || '',
    mock_eng_grade: data.engMockGrade || '',
    school_math_grade: data.schoolMathGrade || '',
    prior_progress: data.advanceProgress || '',
    avail_days: JSON.stringify(Array.isArray(data.availableDays) ? data.availableDays : []),
    weak_units: data.weakness || '',
    target_univ: data.dreamUniv || '',
    notes: data.notes || '',
    personal_key: data.personalKey || '',
    approval_status: data.approvalStatus || '대기중',
    mathflat_name: data.mathPlatName || '',
  };
  // 유입경로(2026-07) — 전달된 경우에만 컬럼 포함(다른 호출자는 마이그레이션 의존 없음)
  if (data.referral !== undefined) {
    cols.referral = data.referral || '';
    cols.referral_detail = data.referralDetail || '';
  }
  const keys = Object.keys(cols);
  const sql = 'INSERT INTO students (' + keys.join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')';
  try {
    const res = await env.DB.prepare(sql).bind(...keys.map(k => cols[k])).run();
    return { ok: true, id: res.meta && res.meta.last_row_id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function updateStudent(env, id, patch) {
  const map = {
    name: 'name', school: 'school', grade: 'grade', parentPhone4: 'parent_last4',
    studentPhone: 'student_phone', parentPhone: 'parent_phone', parentRelation: 'parent_relation',
    level: 'cur_math_grade', academy: 'academy', className: 'class_name',
    mathMockGrade: 'mock_math_grade', korMockGrade: 'mock_kor_grade', engMockGrade: 'mock_eng_grade',
    schoolMathGrade: 'school_math_grade', advanceProgress: 'prior_progress',
    weakness: 'weak_units', dreamUniv: 'target_univ', notes: 'notes',
    approvalStatus: 'approval_status', mathPlatName: 'mathflat_name', personalKey: 'personal_key',
  };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) { sets.push(col + '=?'); vals.push(patch[k]); }
  }
  if (patch.goals !== undefined)        { sets.push('purposes=?');  vals.push(JSON.stringify(patch.goals || [])); }
  if (patch.availableDays !== undefined){ sets.push('avail_days=?'); vals.push(JSON.stringify(patch.availableDays || [])); }
  if (patch.mathMockScore !== undefined){
    sets.push('mock_math_raw=?');
    vals.push((patch.mathMockScore === '' || patch.mathMockScore === null) ? null : Number(patch.mathMockScore));
  }
  if (!sets.length) return { ok: true };
  vals.push(id);
  try {
    await env.DB.prepare('UPDATE students SET ' + sets.join(', ') + ' WHERE id=?').bind(...vals).run();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function deleteStudent(env, id) {
  try {
    await env.DB.prepare('DELETE FROM students WHERE id=?').bind(id).run();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function setApprovalStatus(env, id, status) {
  try {
    await env.DB.prepare('UPDATE students SET approval_status=? WHERE id=?').bind(status, id).run();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ════════════ 리포트 ════════════
export async function getReportsForStudent(env, opts) {
  opts = opts || {};
  const publicOnly = opts.publicOnly !== false;   // 기본 공개만
  let sql = 'SELECT * FROM reports';
  const conds = [], vals = [];
  if (publicOnly) conds.push('is_public = 1');
  if (opts.name) { conds.push('student_name = ?'); vals.push(opts.name); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY class_date DESC';
  const { results } = await env.DB.prepare(sql).bind(...vals).all();
  return (results || []).map(rowToReport);
}

// 같은 학생+같은 수업날짜의 기존 리포트 찾기 (재업로드 중복 방지용). 없으면 null.
//   ⚠️ 리포트는 아직 name-key(MathOS가 이름+날짜로 올림) — 동일 이름 재업로드가 대상이므로 이름 기준이 맞음.
export async function getReportByStudentAndDate(env, studentName, classDate) {
  if (!studentName || !classDate) return null;
  try {
    const r = await env.DB.prepare(
      'SELECT id FROM reports WHERE student_name=? AND class_date=? ORDER BY id LIMIT 1'
    ).bind(studentName, classDate).first();
    return r || null;
  } catch (_) { return null; }
}

export async function createReport(env, data) {
  const title = data.title || ((data.studentName || '') + ' - ' + (data.date || '') + ' 수업 리포트');
  try {
    const res = await env.DB.prepare(
      'INSERT INTO reports (student_name, phone_last4, title, class_date, content, homework, notes, is_public, academy) ' +
      'VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(
      data.studentName || '', data.phone4 || '', title, data.date || '',
      data.content || '', data.homework || '', data.notes || '', 1, data.school || '대치동 정규반'
    ).run();
    return { ok: true, id: res.meta && res.meta.last_row_id };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function updateReport(env, id, patch) {
  const map = { date: 'class_date', school: 'academy', content: 'content', homework: 'homework', notes: 'notes' };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) { sets.push(col + '=?'); vals.push(patch[k]); }
  }
  if (!sets.length) return { ok: true };
  vals.push(id);
  try {
    await env.DB.prepare('UPDATE reports SET ' + sets.join(', ') + ' WHERE id=?').bind(...vals).run();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function deleteReport(env, id) {
  try {
    await env.DB.prepare('DELETE FROM reports WHERE id=?').bind(id).run();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ════════════ 출결 ════════════
export async function getAttendance(env, studentId, month) {
  let sql = 'SELECT date, status, homework, homework_note, note, method FROM attendance WHERE student_id = ?';
  const vals = [studentId];
  if (month) { sql += ' AND date LIKE ?'; vals.push(month + '%'); }
  const { results } = await env.DB.prepare(sql).bind(...vals).all();
  const records = {};
  for (const r of (results || [])) records[r.date] = attRecord(r);
  return { records, updatedAt: null };
}

export async function upsertAttendance(env, studentId, date, fields) {
  const cols = ['status', 'homework', 'homework_note', 'note', 'method'];
  const present = cols.filter(c => fields[c] !== undefined);
  try {
    const existing = await env.DB.prepare('SELECT student_id FROM attendance WHERE student_id=? AND date=?')
      .bind(studentId, date).first();
    if (existing) {
      if (present.length) {
        const setSql = present.map(c => c + '=?').join(', ') + ', updated_at=?';
        await env.DB.prepare('UPDATE attendance SET ' + setSql + ' WHERE student_id=? AND date=?')
          .bind(...present.map(c => fields[c]), new Date().toISOString(), studentId, date).run();
      }
    } else {
      const allCols = ['student_id', 'date', ...present, 'updated_at'];
      const allVals = [studentId, date, ...present.map(c => fields[c]), new Date().toISOString()];
      await env.DB.prepare('INSERT INTO attendance (' + allCols.join(',') + ') VALUES (' + allCols.map(() => '?').join(',') + ')')
        .bind(...allVals).run();
    }
    const got = await getAttendance(env, studentId);
    return { ok: true, record: got.records[date] || {} };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function deleteAttendance(env, studentId, date) {
  try {
    const res = await env.DB.prepare('DELETE FROM attendance WHERE student_id=? AND date=?').bind(studentId, date).run();
    return { ok: true, removed: (res.meta && res.meta.changes) || 0 };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function listAllAttendance(env) {
  const { results } = await env.DB.prepare(
    'SELECT a.student_id, s.name, a.date, a.status, a.homework, a.homework_note, a.note, a.method ' +
    'FROM attendance a LEFT JOIN students s ON s.id = a.student_id'
  ).all();
  // 🆔 그룹핑 키는 student_id — 이름으로 묶으면 동명이인 두 명의 출결이 한 덩어리로 합쳐진다.
  const byStudent = {};
  for (const r of (results || [])) {
    const key = String(r.student_id);
    if (!byStudent[key]) byStudent[key] = { id: r.student_id, name: r.name || '', records: {}, updatedAt: null };
    byStudent[key].records[r.date] = attRecord(r);
  }
  return Object.values(byStudent);
}

// ════════════ 클리닉 (수업 출결과 별도 테이블) ════════════
// 라이브 수업 출결(attendance)은 절대 안 건드림. 클리닉은 독립 clinic 테이블에 저장.
// 마이그레이션 러너가 없으므로 첫 사용 시 CREATE TABLE IF NOT EXISTS로 보장(아이솔레이트당 1회).
let _clinicReady = false;
async function ensureClinic(env) {
  if (_clinicReady) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS clinic (' +
    'student_id TEXT NOT NULL, date TEXT NOT NULL, status TEXT, ' +
    'achieve INTEGER, minutes INTEGER, note TEXT, updated_at TEXT, ' +
    'PRIMARY KEY (student_id, date))'
  ).run();
  _clinicReady = true;
}

function clinicRecord(r) {
  const rec = {};
  if (r.status) rec.status = r.status;
  if (r.achieve !== null && r.achieve !== undefined) rec.achieve = r.achieve;
  if (r.minutes !== null && r.minutes !== undefined) rec.minutes = r.minutes;
  if (r.note) rec.note = r.note;
  return rec;
}

export async function getClinic(env, studentId, month) {
  await ensureClinic(env);
  let sql = 'SELECT date, status, achieve, minutes, note FROM clinic WHERE student_id = ?';
  const vals = [studentId];
  if (month) { sql += ' AND date LIKE ?'; vals.push(month + '%'); }
  const { results } = await env.DB.prepare(sql).bind(...vals).all();
  const records = {};
  for (const r of (results || [])) records[r.date] = clinicRecord(r);
  return { records, updatedAt: null };
}

export async function upsertClinic(env, studentId, date, fields) {
  await ensureClinic(env);
  const cols = ['status', 'achieve', 'minutes', 'note'];
  const present = cols.filter(c => fields[c] !== undefined);
  try {
    const existing = await env.DB.prepare('SELECT student_id FROM clinic WHERE student_id=? AND date=?')
      .bind(studentId, date).first();
    if (existing) {
      if (present.length) {
        const setSql = present.map(c => c + '=?').join(', ') + ', updated_at=?';
        await env.DB.prepare('UPDATE clinic SET ' + setSql + ' WHERE student_id=? AND date=?')
          .bind(...present.map(c => fields[c]), new Date().toISOString(), studentId, date).run();
      }
    } else {
      const allCols = ['student_id', 'date', ...present, 'updated_at'];
      const allVals = [studentId, date, ...present.map(c => fields[c]), new Date().toISOString()];
      await env.DB.prepare('INSERT INTO clinic (' + allCols.join(',') + ') VALUES (' + allCols.map(() => '?').join(',') + ')')
        .bind(...allVals).run();
    }
    const got = await getClinic(env, studentId);
    return { ok: true, record: got.records[date] || {} };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function deleteClinic(env, studentId, date) {
  await ensureClinic(env);
  try {
    const res = await env.DB.prepare('DELETE FROM clinic WHERE student_id=? AND date=?').bind(studentId, date).run();
    return { ok: true, removed: (res.meta && res.meta.changes) || 0 };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function listAllClinic(env) {
  await ensureClinic(env);
  const { results } = await env.DB.prepare(
    'SELECT c.student_id, s.name, c.date, c.status, c.achieve, c.minutes, c.note ' +
    'FROM clinic c LEFT JOIN students s ON s.id = c.student_id'
  ).all();
  // 🆔 그룹핑 키는 student_id — 이름으로 묶으면 동명이인 두 명의 클리닉이 한 덩어리로 합쳐진다.
  const byStudent = {};
  for (const r of (results || [])) {
    const key = String(r.student_id);
    if (!byStudent[key]) byStudent[key] = { id: r.student_id, name: r.name || '', records: {}, updatedAt: null };
    byStudent[key].records[r.date] = clinicRecord(r);
  }
  return Object.values(byStudent);
}

// ─── 특정 날짜만 뽑는 조회(명단 계산용, 전체 히스토리 로드 회피) ───
export async function listAttendanceByDate(env, date) {
  const { results } = await env.DB.prepare(
    'SELECT a.student_id, s.name, a.status, a.homework, a.homework_note, a.note ' +
    'FROM attendance a LEFT JOIN students s ON s.id = a.student_id WHERE a.date = ?'
  ).bind(date).all();
  return results || [];
}

export async function listClinicByDate(env, date) {
  await ensureClinic(env);
  const { results } = await env.DB.prepare(
    'SELECT c.student_id, s.name, c.status, c.achieve, c.minutes, c.note ' +
    'FROM clinic c LEFT JOIN students s ON s.id = c.student_id WHERE c.date = ?'
  ).bind(date).all();
  return results || [];
}

// ════════════ 클리닉 필수 명단 — 수동 추가/제외 오버라이드 ════════════
// 2026-07-31~ : 명단은 "그날 클리닉 있는 반 전원 기본 포함"이고(시간표에서 파생),
// 이 테이블엔 "수동으로 넣거나 뺀 것"만 저장한다.
// action='add'(그날 대상이 아닌 학생을 강제 포함) / 'exclude'(기본 포함이지만 오늘은 제외).
// ⚠️ PK가 (student_id, date)라서 제외는 그날 하루만 — 상시 제외가 아니다.
// 마이그레이션 러너 없으니 첫 사용 시 CREATE TABLE IF NOT EXISTS로 보장(아이솔레이트당 1회).
let _clinicRosterReady = false;
async function ensureClinicRoster(env) {
  if (_clinicRosterReady) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS clinic_roster (' +
    'student_id TEXT NOT NULL, date TEXT NOT NULL, action TEXT NOT NULL, ' +
    'reason TEXT, updated_at TEXT, ' +
    'PRIMARY KEY (student_id, date))'
  ).run();
  _clinicRosterReady = true;
}

// student_id 정규화(_makeup.js와 동일 규칙) — D1이 JS 숫자를 REAL로 바인딩해 TEXT칸에 "24.0"으로
//   저장되던 과거 버그와 표준형 "24"를 수렴시킨다. write는 "24"로 저장, 조회/삭제는 신·구 둘 다 매칭.
function _normSid(id) { return String(id == null ? '' : id).trim().replace(/\.0+$/, ''); }
function _sidPair(id) { const s = _normSid(id); return [s, s + '.0']; }

export async function listClinicRoster(env, date) {
  await ensureClinicRoster(env);
  const { results } = await env.DB.prepare(
    'SELECT student_id, action, reason FROM clinic_roster WHERE date = ?'
  ).bind(date).all();
  return results || [];
}

export async function setClinicRoster(env, studentId, date, action, reason) {
  await ensureClinicRoster(env);
  try {
    const [a, b] = _sidPair(studentId);   // 신·구("24","24.0") 둘 다 매칭
    const existing = await env.DB.prepare('SELECT student_id FROM clinic_roster WHERE (student_id=? OR student_id=?) AND date=?')
      .bind(a, b, date).first();
    if (existing) {
      // student_id도 표준형("24")으로 덮어 과거 "24.0" 행을 수렴시킨다.
      await env.DB.prepare('UPDATE clinic_roster SET student_id=?, action=?, reason=?, updated_at=? WHERE (student_id=? OR student_id=?) AND date=?')
        .bind(a, action, reason || '', new Date().toISOString(), a, b, date).run();
    } else {
      await env.DB.prepare('INSERT INTO clinic_roster (student_id, date, action, reason, updated_at) VALUES (?,?,?,?,?)')
        .bind(a, date, action, reason || '', new Date().toISOString()).run();
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function deleteClinicRoster(env, studentId, date) {
  await ensureClinicRoster(env);
  try {
    const [a, b] = _sidPair(studentId);   // 신·구("24","24.0") 둘 다 삭제
    const res = await env.DB.prepare('DELETE FROM clinic_roster WHERE (student_id=? OR student_id=?) AND date=?')
      .bind(a, b, date).run();
    return { ok: true, removed: (res.meta && res.meta.changes) || 0 };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ════════════ 클리닉 총평(clinic_reviews) — 조교 코멘트 → 원장 검토 → 학부모 푸시 ════════════
// 클리닉 끝나고 조교가 학생별로 "물어본 것·태도·개선방향·틀린개수·난이도·한줄총평"을 draft로 저장.
// 원장이 검토 후 발송하면 status='sent'로 바뀌고 그때 본문 스냅샷(sent_body)을 남긴다.
// 학생 식별은 이름이 아니라 student_id(동명이인 안전). 마이그레이션 러너 없으니 첫 사용 시 보장(아이솔레이트당 1회).
// difficulty: 'easy'(쉬움) / 'normal'(적절) / 'hard'(어려움) — 배정 난이도가 그 학생에게 적절했는지.
// status: 'draft'(조교 작성/원장 미발송) / 'sent'(원장 발송 완료).
let _clinicReviewsReady = false;
async function ensureClinicReviews(env) {
  if (_clinicReviewsReady) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS clinic_reviews (' +
    'student_id TEXT NOT NULL, date TEXT NOT NULL, ' +
    'author_phone TEXT, author_name TEXT, ' +
    'asked TEXT, attitude TEXT, improvement TEXT, ' +
    'wrong_count INTEGER, difficulty TEXT, summary TEXT, ' +
    'status TEXT, sent_body TEXT, ' +
    'created_at TEXT, updated_at TEXT, sent_at TEXT, ' +
    'PRIMARY KEY (student_id, date))'
  ).run();
  _clinicReviewsReady = true;
}

function clinicReviewRow(r) {
  if (!r) return null;
  return {
    studentId: r.student_id,
    date: r.date,
    authorPhone: r.author_phone || '',
    authorName: r.author_name || '',
    asked: r.asked || '',
    attitude: r.attitude || '',
    improvement: r.improvement || '',
    wrongCount: (r.wrong_count === null || r.wrong_count === undefined) ? null : r.wrong_count,
    difficulty: r.difficulty || '',
    summary: r.summary || '',
    status: r.status || 'draft',
    sentBody: r.sent_body || '',
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null,
    sentAt: r.sent_at || null,
  };
}

export async function getClinicReview(env, studentId, date) {
  await ensureClinicReviews(env);
  const [a, b] = _sidPair(studentId);   // 신·구("24","24.0") 둘 다 매칭 — 과거 REAL 저장분 포함
  const r = await env.DB.prepare('SELECT * FROM clinic_reviews WHERE (student_id=? OR student_id=?) AND date=?')
    .bind(a, b, date).first();
  return clinicReviewRow(r);
}

// 부분 업데이트. fields에 든 컬럼만 갱신. 신규면 created_at·status(기본 draft) 세팅.
export async function upsertClinicReview(env, studentId, date, fields) {
  await ensureClinicReviews(env);
  const cols = ['author_phone', 'author_name', 'asked', 'attitude', 'improvement', 'wrong_count', 'difficulty', 'summary', 'status'];
  const present = cols.filter(c => fields[c] !== undefined);
  try {
    const now = new Date().toISOString();
    const [a, b] = _sidPair(studentId);   // 저장은 "24"로, 조회/갱신은 신·구 둘 다 매칭(중복행 방지)
    const existing = await env.DB.prepare('SELECT student_id FROM clinic_reviews WHERE (student_id=? OR student_id=?) AND date=?')
      .bind(a, b, date).first();
    if (existing) {
      if (present.length) {
        const setSql = present.map(c => c + '=?').join(', ') + ', updated_at=?';
        await env.DB.prepare('UPDATE clinic_reviews SET ' + setSql + ' WHERE (student_id=? OR student_id=?) AND date=?')
          .bind(...present.map(c => fields[c]), now, a, b, date).run();
      }
    } else {
      const insCols = ['student_id', 'date', ...present];
      const insVals = [a, date, ...present.map(c => fields[c])];
      if (!present.includes('status')) { insCols.push('status'); insVals.push('draft'); }
      insCols.push('created_at', 'updated_at');
      insVals.push(now, now);
      await env.DB.prepare('INSERT INTO clinic_reviews (' + insCols.join(',') + ') VALUES (' + insCols.map(() => '?').join(',') + ')')
        .bind(...insVals).run();
    }
    const got = await getClinicReview(env, studentId, date);
    return { ok: true, record: got };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 발송 확정: status='sent' + 본문 스냅샷 + sent_at 기록.
export async function markClinicReviewSent(env, studentId, date, sentBody) {
  await ensureClinicReviews(env);
  try {
    const now = new Date().toISOString();
    const [a, b] = _sidPair(studentId);   // 신·구 둘 다 매칭 — 과거 "24.0" draft도 발송확정됨
    const res = await env.DB.prepare(
      'UPDATE clinic_reviews SET status=?, sent_body=?, sent_at=?, updated_at=? WHERE (student_id=? OR student_id=?) AND date=?'
    ).bind('sent', sentBody || '', now, now, a, b, date).run();
    return { ok: true, changed: (res.meta && res.meta.changes) || 0 };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function deleteClinicReview(env, studentId, date) {
  await ensureClinicReviews(env);
  try {
    const [a, b] = _sidPair(studentId);   // 신·구 둘 다 삭제
    const res = await env.DB.prepare('DELETE FROM clinic_reviews WHERE (student_id=? OR student_id=?) AND date=?')
      .bind(a, b, date).run();
    return { ok: true, removed: (res.meta && res.meta.changes) || 0 };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 특정 날짜 전체 총평(원장 검토 화면용). students JOIN으로 이름·학원·반 덧붙임.
export async function listClinicReviewsByDate(env, date) {
  await ensureClinicReviews(env);
  const { results } = await env.DB.prepare(
    'SELECT r.*, s.name, s.academy, s.class_name ' +
    'FROM clinic_reviews r LEFT JOIN students s ON s.id = r.student_id WHERE r.date = ?'
  ).bind(date).all();
  return (results || []).map(r => ({
    ...clinicReviewRow(r),
    name: r.name || '',
    academy: r.academy || '',
    className: r.class_name || '',
  }));
}

// 학부모/학생 아카이브용: 지정한 student_id들의 '발송 완료' 총평만 최신순.
export async function listSentReviewsForStudentIds(env, studentIds) {
  await ensureClinicReviews(env);
  if (!studentIds || !studentIds.length) return [];
  // 각 id를 신·구 두 형태("24","24.0")로 확장 — 과거 REAL로 "24.0" 저장된 발송분도 아카이브에 포함
  const expanded = [];
  for (const id of studentIds) { const [a, b] = _sidPair(id); expanded.push(a, b); }
  const placeholders = expanded.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    'SELECT r.*, s.name FROM clinic_reviews r LEFT JOIN students s ON s.id = r.student_id ' +
    'WHERE r.status = ? AND r.student_id IN (' + placeholders + ') ORDER BY r.date DESC'
  ).bind('sent', ...expanded).all();
  return (results || []).map(r => ({ ...clinicReviewRow(r), name: r.name || '' }));
}

// ════════════ 클리닉 하루 전체 메모(clinic_day_memo2) — 원장님만 봄 ════════════
// 조교가 그날 세션 전체 요약(귀가시각·전반 난이도 등)을 남기는 곳. 학부모 발송 대상 아님.
// 🔧 2026-07-30 (2차 점검 2-1): 키를 (date, academy)로 — A학원 조교 메모를 B학원 조교가 덮어쓰던 문제.
//   academy '' = 원장 본인 메모 + 구형(date 단독 키) 이관분. SQLite는 PK 변경 불가라 v2 테이블로
//   갈아타고, 구형 clinic_day_memo는 지우지 않고 남긴다(보존 없는 삭제 금지). 이관은 INSERT OR
//   IGNORE라 아이솔레이트마다 재실행돼도 v2에서 수정한 내용을 덮지 않는다(멱등).
// 마이그레이션 러너 없으니 첫 사용 시 보장(아이솔레이트당 1회).
let _clinicDayMemoReady = false;
async function ensureClinicDayMemo(env) {
  if (_clinicDayMemoReady) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS clinic_day_memo2 (' +
    "date TEXT NOT NULL, academy TEXT NOT NULL DEFAULT '', memo TEXT, updated_at TEXT, " +
    'PRIMARY KEY (date, academy))'
  ).run();
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO clinic_day_memo2 (date, academy, memo, updated_at) SELECT date, '', memo, updated_at FROM clinic_day_memo"
    ).run();
  } catch (_) { /* 구형 테이블이 없는 신규 DB — 정상 */ }
  _clinicDayMemoReady = true;
}

export async function getClinicDayMemo(env, date, academy) {
  await ensureClinicDayMemo(env);
  const r = await env.DB.prepare('SELECT memo, updated_at FROM clinic_day_memo2 WHERE date=? AND academy=?').bind(date, academy || '').first();
  return { memo: (r && r.memo) || '', updatedAt: (r && r.updated_at) || null };
}

// 원장 검토용: 그날 조교 학원별 메모 전부 (academy '' = 원장 본인/구형 행은 제외 — 그건 getClinicDayMemo로)
export async function listClinicDayMemos(env, date) {
  await ensureClinicDayMemo(env);
  const { results } = await env.DB.prepare(
    "SELECT academy, memo, updated_at FROM clinic_day_memo2 WHERE date=? AND academy<>'' ORDER BY academy"
  ).bind(date).all();
  return (results || []).map(r => ({ academy: r.academy, memo: r.memo || '', updatedAt: r.updated_at || null }));
}

export async function setClinicDayMemo(env, date, memo, academy) {
  await ensureClinicDayMemo(env);
  try {
    const now = new Date().toISOString();
    const acad = academy || '';
    const existing = await env.DB.prepare('SELECT date FROM clinic_day_memo2 WHERE date=? AND academy=?').bind(date, acad).first();
    if (existing) {
      await env.DB.prepare('UPDATE clinic_day_memo2 SET memo=?, updated_at=? WHERE date=? AND academy=?').bind(memo || '', now, date, acad).run();
    } else {
      await env.DB.prepare('INSERT INTO clinic_day_memo2 (date, academy, memo, updated_at) VALUES (?,?,?,?)').bind(date, acad, memo || '', now).run();
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ════════════ 앱 설정 (app_config) — 강제업데이트 최소버전 등 ════════════
// 관리자만 변경. key-value 한 줄씩. 마이그레이션 러너 없으니 첫 사용 시 보장(아이솔레이트당 1회).
let _appConfigReady = false;
async function ensureAppConfig(env) {
  if (_appConfigReady) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS app_config (' +
    'key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)'
  ).run();
  _appConfigReady = true;
}

export async function getAppConfig(env, key) {
  await ensureAppConfig(env);
  const row = await env.DB.prepare('SELECT value FROM app_config WHERE key=?').bind(key).first();
  return row ? row.value : null;
}

export async function setAppConfig(env, key, value) {
  await ensureAppConfig(env);
  try {
    const existing = await env.DB.prepare('SELECT key FROM app_config WHERE key=?').bind(key).first();
    if (existing) {
      await env.DB.prepare('UPDATE app_config SET value=?, updated_at=? WHERE key=?')
        .bind(value, new Date().toISOString(), key).run();
    } else {
      await env.DB.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
        .bind(key, value, new Date().toISOString()).run();
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ════════════ KW-Study ════════════
export async function getStudySessions(env, studentId) {
  let results;
  try {
    ({ results } = await env.DB.prepare(
      'SELECT id, started_at, ended_at, minutes, date, away_count, away_ms FROM study_sessions WHERE student_id=? ORDER BY started_at DESC'
    ).bind(studentId).all());
  } catch (_) {
    // away_count/away_ms 컬럼이 아직 없으면(마이그레이션 전) 기존 컬럼만 조회
    ({ results } = await env.DB.prepare(
      'SELECT id, started_at, ended_at, minutes, date FROM study_sessions WHERE student_id=? ORDER BY started_at DESC'
    ).bind(studentId).all());
  }
  return (results || []).map(r => ({
    id: r.id, startedAt: r.started_at, endedAt: r.ended_at, minutes: r.minutes, date: r.date,
    awayCount: Number(r.away_count) || 0, awayMs: Number(r.away_ms) || 0,
  }));
}

export async function addStudySession(env, studentId, session) {
  const ac = Math.max(0, Math.round(Number(session.awayCount) || 0));
  const am = Math.max(0, Math.round(Number(session.awayMs) || 0));
  try {
    await env.DB.prepare(
      'INSERT INTO study_sessions (id, student_id, started_at, ended_at, minutes, date, away_count, away_ms) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(session.id, studentId, session.startedAt, session.endedAt, session.minutes, session.date, ac, am).run();
    return { ok: true };
  } catch (e) {
    // away 컬럼이 없으면(마이그레이션 전) 기존 컬럼만으로 저장 — 이탈은 미저장이지만 앱은 정상
    try {
      await env.DB.prepare(
        'INSERT INTO study_sessions (id, student_id, started_at, ended_at, minutes, date) VALUES (?,?,?,?,?,?)'
      ).bind(session.id, studentId, session.startedAt, session.endedAt, session.minutes, session.date).run();
      return { ok: true };
    } catch (e2) { return { ok: false, error: e2.message }; }
  }
}
