// /api/study-prefs — KW-Study 개인 설정 (목표 시간 + 개인 디데이)
// ───────────────────────────────────────────────────────────
// D1 table: study_prefs (student_id PK). 학생 1명당 1행.
// 인증: requireStudentAccess. GET=학생·학부모(자녀 ?name=), POST=학생 본인만.
//
//  GET  ?name=홍길동  → { ok, weeklyGoal, dailyGoal, ddays:[{label,date}] }
//  POST { weeklyGoal?, dailyGoal?, ddays? }  (학생 본인) → 저장
//     weeklyGoal: 0~6000(분, 0=해제) · dailyGoal: 0~960 · ddays: [{label(≤20), date 'YYYY-MM-DD'}] 최대 10개
// ───────────────────────────────────────────────────────────
import { requireStudentAccess } from './_auth.js';
import { getStudentsByPhone } from './_db.js';

const MAX_WEEKLY = 6000;   // 100시간
const MAX_DAILY  = 960;    // 16시간
const MAX_DDAYS  = 10;

async function ensureTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS study_prefs (' +
    'student_id INTEGER PRIMARY KEY, weekly_goal INTEGER, daily_goal INTEGER, ' +
    'ddays_json TEXT, updated_at TEXT)'
  ).run();
}

async function resolveStudentId(env, phone, name) {
  const list = await getStudentsByPhone(env, phone);
  const me = list.find(s => s.name === name) || (list.length === 1 ? list[0] : null);
  return me ? me.id : null;
}

function parseDdays(raw) {
  let arr = [];
  try { arr = JSON.parse(raw || '[]'); } catch (_) { arr = []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(d => d && d.date)
    .map(d => ({ label: String(d.label || '').slice(0, 20), date: String(d.date).slice(0, 10) }))
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    .slice(0, MAX_DDAYS);
}

function clampInt(v, min, max, dflt) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

export async function onRequest({ request, env }) {
  const access = await requireStudentAccess(env, request);
  if (!access.ok) return access.response;

  try { await ensureTable(env); }
  catch (e) { return Response.json({ error: '설정 DB 초기화 실패' }, { status: 500 }); }

  let studentId;
  try { studentId = await resolveStudentId(env, access.phone, access.student.name); }
  catch (e) { return Response.json({ error: '학생 식별 실패' }, { status: 500 }); }
  if (!studentId) return Response.json({ error: '학생 정보를 찾을 수 없습니다.' }, { status: 404 });

  // ── GET ──
  if (request.method === 'GET') {
    try {
      const row = await env.DB.prepare(
        'SELECT weekly_goal, daily_goal, ddays_json FROM study_prefs WHERE student_id=?'
      ).bind(studentId).first();
      return Response.json({
        ok: true,
        weeklyGoal: row && row.weekly_goal != null ? row.weekly_goal : 0,
        dailyGoal:  row && row.daily_goal  != null ? row.daily_goal  : 0,
        ddays: row ? parseDdays(row.ddays_json) : [],
      });
    } catch (e) {
      return Response.json({ error: '설정을 불러오지 못했습니다.' }, { status: 500 });
    }
  }

  // ── POST (학생 본인만) ──
  if (request.method === 'POST') {
    if (access.student.role !== 'student') {
      return Response.json({ error: '학생 본인 계정에서만 목표를 설정할 수 있어요.' }, { status: 403 });
    }
    let body = {};
    try { body = await request.json(); } catch (_) {}

    // 기존값 로드 (부분 업데이트 지원)
    let cur = { weekly_goal: 0, daily_goal: 0, ddays_json: '[]' };
    try {
      const row = await env.DB.prepare(
        'SELECT weekly_goal, daily_goal, ddays_json FROM study_prefs WHERE student_id=?'
      ).bind(studentId).first();
      if (row) cur = row;
    } catch (_) {}

    const weeklyGoal = body.weeklyGoal !== undefined ? clampInt(body.weeklyGoal, 0, MAX_WEEKLY, 0) : (cur.weekly_goal || 0);
    const dailyGoal  = body.dailyGoal  !== undefined ? clampInt(body.dailyGoal,  0, MAX_DAILY,  0) : (cur.daily_goal  || 0);
    let ddaysJson = cur.ddays_json || '[]';
    if (body.ddays !== undefined) {
      const cleaned = parseDdays(JSON.stringify(Array.isArray(body.ddays) ? body.ddays : []));
      ddaysJson = JSON.stringify(cleaned);
    }
    const now = new Date().toISOString();

    try {
      await env.DB.prepare(
        'INSERT INTO study_prefs (student_id, weekly_goal, daily_goal, ddays_json, updated_at) VALUES (?,?,?,?,?) ' +
        'ON CONFLICT(student_id) DO UPDATE SET weekly_goal=excluded.weekly_goal, daily_goal=excluded.daily_goal, ' +
        'ddays_json=excluded.ddays_json, updated_at=excluded.updated_at'
      ).bind(studentId, weeklyGoal, dailyGoal, ddaysJson, now).run();
      return Response.json({ ok: true, weeklyGoal, dailyGoal, ddays: parseDdays(ddaysJson) });
    } catch (e) {
      return Response.json({ error: '설정 저장에 실패했습니다.' }, { status: 500 });
    }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
