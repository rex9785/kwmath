// /api/study-class
// 같은 반 학생들의 주간 공부량 통계 + 본인 순위 (익명)
//
// 공부 데이터: Cloudflare D1 study_sessions (Phase 4 전환 — 이전엔 R2 study/{name}.json)
// 반 명단: Cloudflare D1 students (예전 주석엔 "노션 유지"라고 적혀 있었으나 이미 D1로 넘어왔다)
//
// GET ?week=YYYY-Www (선택)
//   학생/학부모 토큰 → 본인(자녀) 반 통계 / admin 토큰 + ?academy=X&class=Y → 그 반 전체

import { requireStudentAccess } from './_auth.js';
import { getStudySessions } from './_db.js';
import { safeError } from './_errors.js';

function ymd(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
}

// 이번 주 월요일 ~ 일요일 범위
function weekRange(date) {
  const d = new Date(date);
  d.setHours(0,0,0,0);
  const day = (d.getDay() + 6) % 7;  // 월=0
  const monday = new Date(d); monday.setDate(d.getDate() - day);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  return { start: monday, end: sunday };
}

// 기간별 범위 (day=오늘 / week=월~일 / month=1일~말일)
function rangeFor(period, date) {
  const d = new Date(date); d.setHours(0,0,0,0);
  if (period === 'day')   return { start: d, end: d };
  if (period === 'month') {
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end   = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { start, end };
  }
  return weekRange(d);  // 기본 week
}

// student_id → 기간 내 공부 분 합계
//   👥 2026-07-31 — 예전엔 이름을 받아 getStudentByName(ORDER BY id LIMIT 1) 으로 다시 학생을 찾았다.
//     ① 같은 이름이 다른 학원에도 있으면 **그 학생의 공부시간**이 이 반 통계에 섞여 들어왔고,
//     ② 같은 반에 동명이인이 있으면 두 줄 모두 같은 학생을 가리켜 한 명은 통째로 사라졌다.
//     명단을 뽑을 때 이미 id 를 알고 있으니 이름으로 되짚을 이유가 없다 — id 를 그대로 쓴다.
async function loadStudyTotal(env, studentId, startStr, endStr) {
  try {
    if (studentId == null || studentId === '') return 0;
    const sessions = await getStudySessions(env, studentId);
    let sum = 0;
    for (const s of sessions) {
      const d = s.date || ymd(s.startedAt);
      if (d >= startStr && d <= endStr) sum += Number(s.minutes) || 0;
    }
    return sum;
  } catch {
    return 0;
  }
}

async function listClassmates(env, academy, className) {
  // 같은 academy + className 학생 명단 (Cloudflare D1). id 를 같이 뽑아야 동명이인이 섞이지 않는다.
  try {
    const { results } = await env.DB.prepare(
      'SELECT id, name FROM students WHERE academy = ? AND class_name = ? ORDER BY id ASC'
    ).bind(academy, className).all();
    return (results || []).map(r => ({ id: r.id, name: r.name })).filter(s => s.id != null && s.name);
  } catch {
    return [];
  }
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET')
    return Response.json({ error: 'GET만 허용' }, { status: 405 });

  const url = new URL(request.url);
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;

  let academy, className, myId;
  if (isAdmin) {
    academy   = (url.searchParams.get('academy') || '').trim();
    className = (url.searchParams.get('class') || '').trim();
    if (!academy || !className) return Response.json({ error: 'admin: academy + class 필요' }, { status: 400 });
    myId = null;  // admin은 본인 없음
  } else {
    const access = await requireStudentAccess(env, request);
    if (!access.ok) return access.response;
    academy   = access.student.academy || '';
    className = access.student.className || '';
    // 👥 "나"는 이름이 아니라 학생 id 로 찾는다 — 같은 반에 동명이인이 있으면
    //   이름 비교로는 두 줄 다 "나"가 되고, 순위·백분위가 엉뚱한 사람 것으로 나온다.
    myId      = access.student.id != null ? String(access.student.id) : null;
    if (!academy || !className) {
      return Response.json({ ok: true, students: [], myMinutes: 0, classAvg: 0, note: '학원/반 정보 없음' });
    }
  }

  // 기간 범위 (period=day|week|month, 기본 week)
  const period = (url.searchParams.get('period') || 'week').trim();
  const weekParam = (url.searchParams.get('week') || '').trim();
  const ref = weekParam ? new Date(weekParam) : new Date();
  const { start, end } = rangeFor(period, ref);
  const startStr = ymd(start);
  const endStr   = ymd(end);

  try {
    const classmates = await listClassmates(env, academy, className);
    const results = [];
    for (const s of classmates) {
      const mins = await loadStudyTotal(env, s.id, startStr, endStr);
      results.push({ id: String(s.id), name: s.name, minutes: mins, isMe: myId != null && String(s.id) === myId });
    }
    // 정렬 (분 많은 순)
    results.sort((a, b) => b.minutes - a.minutes);
    // 순위 매기기
    results.forEach((r, i) => { r.rank = i + 1; });
    // 익명화 (학생 모드만)
    const studentsOut = results.map((r, i) => ({
      anonName: r.isMe ? '나' : '친구 ' + (r.rank),
      name: isAdmin ? r.name : undefined,  // admin은 실명도 보냄
      id: isAdmin ? r.id : undefined,      // 같은 반에 동명이인이 있으면 실명만으론 못 가린다(원장 화면 전용)
      minutes: r.minutes,
      isMe: r.isMe,
      rank: r.rank,
    }));
    const myEntry = results.find(r => r.isMe);
    const myMinutes = myEntry ? myEntry.minutes : 0;
    const myRank = myEntry ? myEntry.rank : null;
    const total = results.reduce((sum, r) => sum + r.minutes, 0);
    const classAvg = results.length ? Math.round(total / results.length) : 0;
    const myPercentile = (myEntry && results.length > 1)
      ? Math.round(100 - (myRank - 1) * 100 / results.length)
      : null;

    return Response.json({
      ok: true,
      academy, className, period,
      weekStart: startStr, weekEnd: endStr,
      classSize: results.length,
      classTotal: total,
      classAvg,
      myMinutes,
      myRank,
      myPercentile,
      students: studentsOut,
    });
  } catch (e) {
    return safeError(e, env, { message: '반 통계를 불러오지 못했습니다.' });
  }
}
