// /api/study
// KW-Study — 학생 자기보고 공부 시간 기록 (Phase 1, 단순화 v2)
//
// 저장: R2 study/{학생이름}.json
// 구조:
//   { name, sessions: [ {id, startedAt, endedAt, minutes, date} ], updatedAt }
//
// GET (학생/학부모 토큰)
//   → { ok, name, totalMinutes, today, week, month, all, byDate, recentSessions }
// POST { startedAt, endedAt, minutes } (학생/학부모 토큰)
//   → 세션 1회 기록 추가

import { requireStudentAccess } from './_auth.js';

const MAX_SESSION_MINUTES = 720;   // 한 세션 최대 12시간
const MAX_DAILY_MINUTES   = 960;   // 하루 누계 최대 16시간 (부정 방지)

function ymd(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
}

function uuid() {
  return 'ss_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function loadKey(name) {
  return 'study/' + encodeURIComponent(name) + '.json';
}

async function loadRecord(env, name) {
  try {
    const obj = await env.BUCKET.get(loadKey(name));
    if (!obj) return { name, sessions: [], updatedAt: null };
    const rec = JSON.parse(await obj.text());
    if (!Array.isArray(rec.sessions)) rec.sessions = [];
    rec.name = name;
    return rec;
  } catch {
    return { name, sessions: [], updatedAt: null };
  }
}

async function saveRecord(env, rec) {
  await env.BUCKET.put(loadKey(rec.name), JSON.stringify(rec), {
    httpMetadata: { contentType: 'application/json' },
  });
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

  for (const s of sessions) {
    const m = Number(s.minutes) || 0;
    if (m <= 0) continue;
    const d = s.date || ymd(s.startedAt || s.endedAt || new Date());
    byDate[d] = (byDate[d] || 0) + m;
    allM += m;
    if (d === today) todayM += m;
    if (d >= monday)  weekM += m;
    if (d.startsWith(monthStr)) monthM += m;
  }
  return { byDate, today: todayM, week: weekM, month: monthM, all: allM };
}

export async function onRequest({ request, env }) {
  const access = await requireStudentAccess(env, request);
  if (!access.ok) return access.response;
  const studentName = access.student.name;

  if (request.method === 'GET') {
    const rec = await loadRecord(env, studentName);
    const agg = aggregateStats(rec.sessions);
    const recent = [...rec.sessions]
      .sort((a,b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
      .slice(0, 20);
    return Response.json({
      ok: true,
      name: studentName,
      role: access.student.role,
      sessionsCount: rec.sessions.length,
      totalMinutes: agg.all,
      today: agg.today,
      week: agg.week,
      month: agg.month,
      all: agg.all,
      byDate: agg.byDate,
      recentSessions: recent,
    });
  }

  if (request.method === 'POST') {
    // 학부모는 자녀 대신 세션 기록 불가 — 본인이 학생일 때만 OK
    if (access.student.role !== 'student') {
      return Response.json({ error: '학생 본인 계정에서만 공부 세션을 기록할 수 있습니다.' }, { status: 403 });
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

    const rec = await loadRecord(env, studentName);
    const date = ymd(new Date(ts));

    const todayBefore = rec.sessions
      .filter(s => (s.date || ymd(s.startedAt)) === date)
      .reduce((sum, s) => sum + (Number(s.minutes) || 0), 0);
    if (todayBefore + minutes > MAX_DAILY_MINUTES)
      return Response.json({ error: '하루 누계가 ' + MAX_DAILY_MINUTES + '분을 초과합니다' }, { status: 400 });

    const session = {
      id: uuid(),
      startedAt: new Date(ts).toISOString(),
      endedAt:   new Date(te).toISOString(),
      minutes,
      date,
    };
    rec.sessions.push(session);
    rec.updatedAt = new Date().toISOString();
    await saveRecord(env, rec);

    return Response.json({ ok: true, session, todayTotal: todayBefore + minutes });
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
