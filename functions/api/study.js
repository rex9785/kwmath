// /api/study
// KW-Study — 학생 자기보고 공부 시간 기록
//
// 저장: Cloudflare D1 study_sessions 테이블 (Phase 4 전환 — 이전엔 R2 study/{name}.json)
// 인증: requireStudentAccess (_auth, 현재 Notion). 로그인 phone+이름 → D1 student_id.
//
// GET (학생/학부모 토큰) → 통계
//   { ok, name, totalMinutes, today, week, month, all, byDate, recentSessions }
// POST { startedAt, endedAt, minutes } (학생 본인 토큰만) → 세션 1회 추가

import { requireStudentAccess } from './_auth.js';
import { getStudentsByPhone, getStudySessions, addStudySession } from './_db.js';
import { safeError } from './_errors.js';

const MAX_SESSION_MINUTES = 720;   // 한 세션 최대 12시간
const MAX_DAILY_MINUTES   = 960;   // 하루 누계 최대 16시간 (부정 방지)

function ymd(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
}

function uuid() {
  return 'ss_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// 로그인 phone + 학생 이름 → D1 student_id (동명이인은 phone으로 구분)
async function resolveStudentId(env, phone, name) {
  const list = await getStudentsByPhone(env, phone);
  const me = list.find(s => s.name === name) || (list.length === 1 ? list[0] : null);
  return me ? me.id : null;
}

function aggregateStats(sessions) {
  const today = ymd(new Date());
  const now = new Date();
  const mondayDate = new Date(now);
  const day = (now.getDay() + 6) % 7;
  mondayDate.setDate(now.getDate() - day);
  mondayDate.setHours(0,0,0,0);
  const monday = ymd(mondayDate);
  const monthStr = today.slice(0,7);

  const byDate = {};
  let todayM = 0, weekM = 0, monthM = 0, allM = 0;
  let weekAwayCount = 0, weekAwayMs = 0;

  for (const s of sessions) {
    const m = Number(s.minutes) || 0;
    if (m <= 0) continue;
    const d = s.date || ymd(s.startedAt || s.endedAt || new Date());
    byDate[d] = (byDate[d] || 0) + m;
    allM += m;
    if (d === today) todayM += m;
    if (d >= monday) {
      weekM += m;
      weekAwayCount += Number(s.awayCount) || 0;
      weekAwayMs    += Number(s.awayMs) || 0;
    }
    if (d.startsWith(monthStr)) monthM += m;
  }
  const weekMs = weekM * 60000;
  const focusPct = weekMs > 0 ? Math.max(0, Math.min(100, Math.round((weekMs - weekAwayMs) / weekMs * 100))) : 100;
  return { byDate, today: todayM, week: weekM, month: monthM, all: allM, weekAwayCount, focusPct };
}

export async function onRequest({ request, env }) {
  const access = await requireStudentAccess(env, request);
  if (!access.ok) return access.response;
  const studentName = access.student.name;

  let studentId;
  try {
    studentId = await resolveStudentId(env, access.phone, studentName);
  } catch (e) {
    return safeError(e, env, { message: '공부 기록을 불러오지 못했습니다.' });
  }

  if (request.method === 'GET') {
    let sessions = [];
    try {
      sessions = studentId ? await getStudySessions(env, studentId) : [];
    } catch (e) {
      return safeError(e, env, { message: '공부 기록을 불러오지 못했습니다.' });
    }
    const agg = aggregateStats(sessions);
    const recent = [...sessions]
      .sort((a,b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
      .slice(0, 20);
    return Response.json({
      ok: true,
      name: studentName,
      role: access.student.role,
      sessionsCount: sessions.length,
      totalMinutes: agg.all,
      today: agg.today,
      week: agg.week,
      month: agg.month,
      all: agg.all,
      byDate: agg.byDate,
      weekAwayCount: agg.weekAwayCount,
      focusPct: agg.focusPct,
      recentSessions: recent,
    });
  }

  if (request.method === 'POST') {
    // 학부모는 자녀 대신 세션 기록 불가 — 본인이 학생일 때만 OK
    if (access.student.role !== 'student') {
      return Response.json({ error: '학생 본인 계정에서만 공부 세션을 기록할 수 있습니다.' }, { status: 403 });
    }
    if (!studentId) {
      return Response.json({ error: '학생 정보를 찾을 수 없습니다. 관리자에게 문의하세요.' }, { status: 404 });
    }

    let body = {};
    try { body = await request.json(); } catch {}

    const startedAt = (body.startedAt || '').toString();
    const endedAt = (body.endedAt || '').toString();
    const ts = Date.parse(startedAt);
    const te = Date.parse(endedAt);
    if (isNaN(ts) || isNaN(te) || te <= ts)
      return Response.json({ error: 'startedAt/endedAt 유효하지 않음' }, { status: 400 });

    let minutes = Math.round(Number(body.minutes));
    if (!Number.isFinite(minutes) || minutes < 1)
      return Response.json({ error: 'minutes는 1 이상' }, { status: 400 });
    if (minutes > MAX_SESSION_MINUTES) minutes = MAX_SESSION_MINUTES;

    const elapsedMin = (te - ts) / 60000;
    if (minutes > elapsedMin + 1)
      return Response.json({ error: 'minutes가 경과 시간보다 큼' }, { status: 400 });

    const date = ymd(new Date(ts));

    let sessions = [];
    try {
      sessions = await getStudySessions(env, studentId);
    } catch (e) {
      return safeError(e, env, { message: '공부 기록 저장에 실패했습니다.' });
    }

    const todayBefore = sessions
      .filter(s => (s.date || ymd(s.startedAt)) === date)
      .reduce((sum, s) => sum + (Number(s.minutes) || 0), 0);
    if (todayBefore + minutes > MAX_DAILY_MINUTES)
      return Response.json({ error: '하루 누계가 ' + MAX_DAILY_MINUTES + '분을 초과합니다' }, { status: 400 });

    const awayCount = Math.max(0, Math.round(Number(body.awayCount) || 0));
    const awayMs    = Math.max(0, Math.round(Number(body.awayMs) || 0));
    const session = {
      id: uuid(),
      startedAt: new Date(ts).toISOString(),
      endedAt:   new Date(te).toISOString(),
      minutes,
      date,
      awayCount,
      awayMs,
    };
    const r = await addStudySession(env, studentId, session);
    if (!r.ok) return safeError(r.error || 'addStudySession failed', env, { message: '공부 기록 저장에 실패했습니다.' });

    return Response.json({ ok: true, session, todayTotal: todayBefore + minutes });
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
