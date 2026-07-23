// /api/makeup-videos — admin 전용: "한 학생 · 한 날짜"의 수업영상 목록 + 현재 열림/잠김 상태
//   GET ?studentId=123&date=YYYY-MM-DD
//   → { ok, student:{id,name,academy,className}, date, status, blocked, grantStatus,
//        videos:[{ code, title, date, requireCode, absenceLocked, open, lockReason }] }
//
//   admin-makeup.html "직접 해제" 카드에서, 열기/닫기 전에 "무엇을 여는지 + 지금 열려있는지"를
//   보여주기 위한 조회 전용 엔드포인트. class-videos.js(학생용)의 R2 매칭 + _makeup.js 잠금로직을
//   그대로 미러하되, 학생 토큰이 아니라 admin 토큰으로 임의 학생(studentId)을 조회한다.
//   ※ 조회 전용 — 접근 로그(access_log)는 남기지 않는다(관우T가 보는 것은 학생 시청이 아님).

import { getStudentById, getAttendance } from './_db.js';
import { isBlockStatus, listGrantsForStudent, PRESENT_STATUS } from './_makeup.js';
import { safeError } from './_errors.js';

const norm = (s) => (s || '').toString().replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();

export async function onRequest({ request, env }) {
  if (request.method !== 'GET')
    return Response.json({ error: 'GET만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '관리자 인증이 필요합니다.' }, { status: 401 });

  const url = new URL(request.url);
  const studentId = (url.searchParams.get('studentId') || '').trim();
  const date = (url.searchParams.get('date') || '').trim();
  if (!studentId) return Response.json({ error: 'studentId 필수' }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return Response.json({ error: 'date(YYYY-MM-DD) 필수' }, { status: 400 });

  try {
    const st = await getStudentById(env, studentId);
    if (!st) return Response.json({ error: '학생을 찾을 수 없습니다.' }, { status: 404 });
    const academy   = st.academy || '';
    const className  = st.className || '';
    if (!academy) {
      return Response.json({
        ok: true, student: { id: st.id, name: st.name, academy, className },
        date, status: null, blocked: false, grantStatus: null, videos: [],
        note: '학생에 학원(academy) 정보가 없어 영상을 매칭할 수 없습니다.',
      });
    }

    // 그날의 출결 상태 + 인강 grant 상태 (잠금 판정용) — 한 번씩만 읽는다.
    const [attRes, grants] = await Promise.all([
      getAttendance(env, studentId, date.slice(0, 7)),
      listGrantsForStudent(env, studentId),
    ]);
    const records = (attRes && attRes.records) || {};
    const rec = records[date];
    const status = (rec && typeof rec === 'object') ? (rec.status || null) : (typeof rec === 'string' ? rec : null);
    const blocked = isBlockStatus(status);                        // 결석·병결·공결 기록이 있는 날(라벨용)
    const present = PRESENT_STATUS.has(status);                   // 출석·지각한 날 = 자동 열림 (정책B 2026-07-21)
    const grant = (grants || []).find(g => g.date === date);
    const grantStatus = grant ? grant.status : null;              // 'approved' | 'requested' | null
    const approved = grantStatus === 'approved';
    // 정책B: 온 날(출석·지각) 또는 관우T가 승인한 날만 열림. 그 외(결석계열 + 기록없는 전입/신규생)는 잠금.
    //   class-videos.js의 isLocked(¬present ∧ ¬approved)와 동일하게 미러 — 관리자뷰/학생뷰 불일치 방지.
    const absenceLocked = !present && !approved;                  // 미출석(기록없음 포함) & 미승인 → 잠김
    const dayLocked = absenceLocked;                              // 날짜 단위 잠금 여부(관리자 액션 판정용)

    // R2에서 그 학원·반의 "그 날짜" 영상만 추림 (class-videos.js와 동일한 매칭 규칙)
    const targetSchool = norm(academy);
    const targetClass  = norm(className);
    const listed = await env.BUCKET.list({ prefix: 'video-codes/' });
    const videos = [];
    for (const obj of listed.objects) {
      try {
        const item = await env.BUCKET.get(obj.key);
        if (!item) continue;
        const data = await item.json();
        if (!data || !data.active) continue;
        if (String(data.date || '') !== date) continue;          // 이 날짜만
        const schoolMatch = norm(data.school) === targetSchool;
        const classMatch  = !targetClass || norm(data.class_name) === targetClass;
        if (!schoolMatch || !classMatch) continue;

        const requireCode = data.require_code === true;          // 수업코드 잠금(인강해제와 무관)
        const open = !requireCode && !absenceLocked;             // 지금 학생에게 실제로 열려있는가
        let lockReason = null;
        if (!open) {
          if (absenceLocked && requireCode) lockReason = 'absent+code';
          else if (absenceLocked)           lockReason = 'absent';
          else if (requireCode)             lockReason = 'code';
        }
        videos.push({
          code: data.code, title: data.title || '', date: data.date,
          requireCode, absenceLocked, open, lockReason,
        });
      } catch { /* 개별 파일 오류 무시 */ }
    }
    videos.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ko'));

    return Response.json({
      ok: true,
      student: { id: st.id, name: st.name, academy, className },
      date, status, blocked, present, approved, grantStatus, dayLocked, videos,
    });
  } catch (e) {
    return safeError(e, env, { message: '영상 잠금 상태를 불러오지 못했습니다.' });
  }
}
