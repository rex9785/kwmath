// /api/makeup-class — admin/조교 전용: "한 반 · 한 날짜"의 학생 전원 + 각자의 영상 열림/잠김 상태
//   GET ?academy=세정학원&className=시동반&date=YYYY-MM-DD
//   → { ok, academy, className, date,
//        videos:[{code,title,requireCode}], videoCount, codeOnlyCount, videosTruncated,
//        students:[{ id, name, status, present, blocked, grantStatus, approved, locked, lockSource }],
//        counts:{ total, locked, open, requested }, isOwner }
//
//   admin-makeup.html의 "반별 영상 열기·잠금" 화면용. 학원·반·날짜 세 개만 고르면 그 반 학생이 전부 뜨고,
//   막힌 학생이 위로 정렬돼 한 화면에서 열고 잠글 수 있게 하는 것이 목적이다.
//
//   ⚠️ makeup-videos.js(학생 1명)를 학생 수만큼 부르면 R2 video-codes/*를 N번 통째로 훑는다(20명이면 20번).
//      그래서 이 API는 학생 목록 1회 · 그날 출결 1쿼리 · 그날 grant 1쿼리 · R2 리스트 1회로 끝낸다.
//      영상은 "반 단위"로 한 벌만 있으면 되고(학생마다 다르지 않다), 학생마다 다른 것은 출결·승인뿐이다.
//
//   ※ 조회 전용 — 접근 로그(access_log)는 남기지 않는다. 실제 열기/잠그기는 POST /api/makeup(원장 전용)이 처리하고
//     그쪽에서 감사로그(makeup.approve / makeup.revoke)를 남긴다.
import { listStudents, listAttendanceByDate } from './_db.js';
import { PRESENT_STATUS, BLOCK_STATUS, normSid, listGrantsByDate } from './_makeup.js';
import { staffScopeAcademy } from './_staff.js';
import { safeError } from './_errors.js';

// class-videos.js·makeup-videos.js와 동일한 느슨한 이름 비교(공백·기호·대소문자 무시)
const norm = (s) => (s || '').toString().replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();

export async function onRequest({ request, env }) {
  if (request.method !== 'GET')
    return Response.json({ error: 'GET만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '관리자 인증이 필요합니다.' }, { status: 401 });

  const url = new URL(request.url);
  const date = (url.searchParams.get('date') || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return Response.json({ error: 'date(YYYY-MM-DD) 필수' }, { status: 400 });
  if (!url.searchParams.has('academy'))
    return Response.json({ error: 'academy 필수' }, { status: 400 });
  // 빈 문자열은 "학원 미지정 / 반 없음"을 뜻한다(화면의 '(미지정)'·'(반 없음)' 묶음). 그래서 has()로 존재만 확인한다.
  const academy   = (url.searchParams.get('academy')   || '').trim();
  const className = (url.searchParams.get('className') || '').trim();

  try {
    // 🔒 조교 학원 스코프 — 미들웨어는 GET을 차단목록에 없으면 다 열어주므로 여기서 직접 막는다.
    //   원장(adm_)은 X-Staff-Phone이 없어 null → 전체. 미배정 조교('')는 아무것도 못 본다.
    //   학원 미지정('') 반은 조교에게 보이지 않는다(scopeAcademy와 절대 같아질 수 없으므로).
    const scopeAcademy = await staffScopeAcademy(env, request);
    const isOwner = scopeAcademy === null;
    if (!isOwner && (!scopeAcademy || academy !== scopeAcademy))
      return Response.json({ error: '담당 학원 학생만 조회할 수 있어요.' }, { status: 403 });

    // ── ① 이 반 학생 ─────────────────────────────────────────
    //   admin-makeup.html 학생 셀렉트와 같은 기준: 승인 대기/거절 학생은 뺀다(''는 옛 데이터=승인으로 간주).
    const all = await listStudents(env);
    const students = all.filter((s) => {
      const st = s.approvalStatus || '';
      if (st !== '' && st !== '승인') return false;
      return (String(s.academy || '').trim() === academy)
          && (String(s.className || '').trim() === className);
    });

    // ── ② 그날 출결 · 그날 인강 grant (각 1쿼리) ───────────────
    const [attRows, grantMap] = await Promise.all([
      listAttendanceByDate(env, date),
      listGrantsByDate(env, date),
    ]);
    const attMap = {};
    for (const r of (attRows || [])) attMap[normSid(r.student_id)] = r.status || '';

    // ── ③ 이 학원·반의 그날 영상 (R2 1회) ─────────────────────
    //   makeup-videos.js와 같은 매칭 규칙: active · date 일치 · 학원 일치 · (반이 지정돼 있으면) 반 일치.
    const targetSchool = norm(academy);
    const targetClass  = norm(className);
    const videos = [];
    let videosTruncated = false;
    if (academy) {
      const listed = await env.BUCKET.list({ prefix: 'video-codes/' });
      videosTruncated = !!listed.truncated;   // 1000개 넘으면 뒷부분을 못 본다 — 화면에 경고를 띄우기 위해 알린다
      for (const obj of (listed.objects || [])) {
        try {
          const item = await env.BUCKET.get(obj.key);
          if (!item) continue;
          const data = await item.json();
          if (!data || !data.active) continue;
          if (String(data.date || '') !== date) continue;
          if (norm(data.school) !== targetSchool) continue;
          if (targetClass && norm(data.class_name) !== targetClass) continue;
          videos.push({ code: data.code, title: data.title || '', requireCode: data.require_code === true });
        } catch { /* 개별 파일 오류 무시 */ }
      }
      videos.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ko'));
    }
    const codeOnlyCount = videos.filter(v => v.requireCode).length;

    // ── ④ 학생별 잠금 판정 (정책B 2026-07-21) ─────────────────
    //   locked = ¬present ∧ ¬approved.  출석·지각한 날은 자동으로 열리고, 그 외(결석계열 + 출결기록 자체가
    //   없는 전입/신규생)는 관우T가 승인해야 열린다. class-videos.js의 isLocked와 같은 식이어야
    //   관리자뷰와 학생뷰가 어긋나지 않는다.
    //   ※ lockSource='attendance' 인 학생은 revoke(다시 잠그기)를 눌러도 안 잠긴다 — present가 이기기 때문.
    //     화면이 그런 학생에게 잠금 버튼을 보여주면 "눌러도 아무 일 없는 버튼"이 되므로 이 필드로 구분한다.
    const out = students.map((s) => {
      const key = normSid(s.id);
      const status = attMap[key] || '';
      const present = PRESENT_STATUS.has(status);
      const blocked = BLOCK_STATUS.has(status);
      const g = grantMap[key] || null;
      const grantStatus = g ? g.status : null;
      const approved = grantStatus === 'approved';
      return {
        id: s.id, name: s.name || '',
        status: status || null, present, blocked,
        grantStatus, approved,
        locked: !present && !approved,
        lockSource: present ? 'attendance' : (approved ? 'grant' : null),  // 왜 열려 있는가
        approvedBy: (approved && g) ? (g.approved_by || '') : '',
        approvedAt: (approved && g) ? (g.approved_at || '') : '',
      };
    });

    // 막힌 학생이 위, 열린 학생이 아래. 같은 묶음 안에서는 이름순(가나다).
    //   관우T 지시: "영상 막힌애들을 위쪽으로, 영상 뚫려있는애는 그밑으로".
    out.sort((a, b) => {
      if (a.locked !== b.locked) return a.locked ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '', 'ko');
    });

    return Response.json({
      ok: true, academy, className, date,
      videos, videoCount: videos.length, codeOnlyCount, videosTruncated,
      students: out,
      counts: {
        total: out.length,
        locked: out.filter(s => s.locked).length,
        open: out.filter(s => !s.locked).length,
        requested: out.filter(s => s.grantStatus === 'requested').length,
      },
      isOwner,
    });
  } catch (e) {
    return safeError(e, env, { message: '반 목록을 불러오지 못했습니다.' });
  }
}
