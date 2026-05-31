// /api/study-class
// 같은 반 학생들의 주간 공부량 통계 + 본인 순위 (익명)
//
// 공부 데이터: Cloudflare D1 study_sessions (Phase 4 전환 — 이전엔 R2 study/{name}.json)
// 반 명단: Notion 학생 DB (students 묶음 전환 전까지 노션 유지)
//
// GET ?week=YYYY-Www (선택)
//   학생/학부모 토큰 → 본인(자녀) 반 통계 / admin 토큰 + ?academy=X&class=Y → 그 반 전체

import { requireStudentAccess, STUDENTS_DB } from './_auth.js';
import { getStudentByName, getStudySessions } from './_db.js';
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

// 학생 이름 → D1 student_id → 주간 공부 분 합계
async function loadStudyTotal(env, name, startStr, endStr) {
  try {
    const st = await getStudentByName(env, name);
    if (!st) return 0;
    const sessions = await getStudySessions(env, st.id);
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
  // Notion 학생 DB 조회 — 같은 academy + className
  const res = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: {
        and: [
          { property: '학원', select: { equals: academy } },
          { property: '반',   select: { equals: className } },
        ],
      },
      page_size: 100,
    }),
  });
  const data = await res.json();
  if (data.object === 'error') return [];
  return (data.results || []).filter(p => !p.archived && !p.in_trash).map(p => {
    const ttl = (p.properties?.['이름']?.title || [])[0]?.plain_text || '';
    return { name: ttl };
  }).filter(s => s.name);
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET')
    return Response.json({ error: 'GET만 허용' }, { status: 405 });

  const url = new URL(request.url);
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;

  let academy, className, myName;
  if (isAdmin) {
    academy   = (url.searchParams.get('academy') || '').trim();
    className = (url.searchParams.get('class') || '').trim();
    if (!academy || !className) return Response.json({ error: 'admin: academy + class 필요' }, { status: 400 });
    myName = '';  // admin은 본인 없음
  } else {
    const access = await requireStudentAccess(env, request);
    if (!access.ok) return access.response;
    academy   = access.student.academy || '';
    className = access.student.className || '';
    myName    = access.student.name || '';
    if (!academy || !className) {
      return Response.json({ ok: true, students: [], myMinutes: 0, classAvg: 0, note: '학원/반 정보 없음' });
    }
  }

  // 주간 범위
  const weekParam = (url.searchParams.get('week') || '').trim();
  const ref = weekParam ? new Date(weekParam) : new Date();
  const { start, end } = weekRange(ref);
  const startStr = ymd(start);
  const endStr   = ymd(end);

  try {
    const classmates = await listClassmates(env, academy, className);
    const results = [];
    for (const s of classmates) {
      const mins = await loadStudyTotal(env, s.name, startStr, endStr);
      results.push({ name: s.name, minutes: mins, isMe: s.name === myName });
    }
    // 정렬 (분 많은 순)
    results.sort((a, b) => b.minutes - a.minutes);
    // 순위 매기기
    results.forEach((r, i) => { r.rank = i + 1; });
    // 익명화 (학생 모드만)
    const studentsOut = results.map((r, i) => ({
      anonName: r.isMe ? '나' : '친구 ' + (r.rank),
      name: isAdmin ? r.name : undefined,  // admin은 실명도 보냄
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
      academy, className,
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
