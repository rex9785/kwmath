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
  const byStudent = {};
  for (const r of (results || [])) {
    const key = r.name || ('id:' + r.student_id);
    if (!byStudent[key]) byStudent[key] = { name: r.name || '', records: {}, updatedAt: null };
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
  const byStudent = {};
  for (const r of (results || [])) {
    const key = r.name || ('id:' + r.student_id);
    if (!byStudent[key]) byStudent[key] = { name: r.name || '', records: {}, updatedAt: null };
    byStudent[key].records[r.date] = clinicRecord(r);
  }
  return Object.values(byStudent);
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
