import { safeError } from './_errors.js';
// GET /api/class-videos
//   Authorization: Bearer <userToken>   (학부모/학생 로그인 토큰)
//   ?name=홍길동  ← 자녀 여러 명일 때만 필요. 한 명이면 생략 OK
// 학생의 학원/반 영상 목록 반환 + 접근 로그 저장

import { requireStudentAccess } from './_auth.js';
import { absenceLockContext, isLocked } from './_makeup.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET')
    return Response.json({ error: 'GET만 허용' }, { status: 405 });

  const access = await requireStudentAccess(env, request);
  if (!access.ok) return access.response;

  // ⚠️ 매칭 기준: 학생 DB의 "학원"(academy: 대치동 정규반/세정학원).
  //   MathOS는 R2 video-codes/*.json 의 data.school 필드에 "학원" 이름을 저장하므로
  //   학생의 academy(학원)와 R2의 data.school을 비교해야 함.
  //   ※ 학생의 학교(school: "OO고등학교" 같은 텍스트)와 헷갈리지 말 것.
  const name      = access.student.name;
  const academy   = access.student.academy;
  const className = access.student.className;
  const role      = access.student.role;   // 'student' | 'parent' | 'other' — 누가 열람했는지
  const phone     = access.phone;           // 로그인 계정 휴대폰 (관우T 식별용)

  if (!academy)
    return Response.json({ error: '수강 정보(학원/반)가 등록되어 있지 않습니다. 선생님께 문의해주세요.' }, { status: 404 });

  // 표기 차이(공백·괄호 등) 흡수: 영문/숫자/한글만 남기고 비교
  const norm = (s) => (s || '').toString().replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();
  const targetSchool = norm(academy);
  const targetClass  = norm(className);

  try {
    // R2에서 해당 반의 영상 코드 목록 조회
    const listed = await env.BUCKET.list({ prefix: 'video-codes/' });
    const videos = [];

    for (const obj of listed.objects) {
      try {
        const item = await env.BUCKET.get(obj.key);
        if (!item) continue;
        const data = await item.json();
        const schoolMatch = norm(data.school) === targetSchool;
        const classMatch  = !targetClass || norm(data.class_name) === targetClass;
        if (schoolMatch && classMatch && data.active) {
          const locked = data.require_code === true;
          videos.push({
            code:        data.code,
            youtube_url: locked ? null : data.youtube_url,
            locked:      locked,
            lockReason:  locked ? 'code' : null,   // 기존 잠금은 '수업코드'
            title:       data.title,
            date:        data.date,
            school:      data.school,
            class_name:  data.class_name,
          });
        }
      } catch { /* 개별 파일 오류 무시 */ }
    }

    videos.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    // 🔒 결석·병결·공결한 날의 영상은 자동 잠금(인강 미신청/미승인 시). '수업코드' 잠금보다 우선.
    //   해제는 학생이 인강 신청 → 관우T/조교 승인, 또는 관우T 직접 해제(/api/makeup).
    try {
      const ctx = await absenceLockContext(env, access.student.id);
      for (const v of videos) {
        if (isLocked(ctx, v.date)) {
          v.locked = true;
          v.lockReason = 'absent';
          v.youtube_url = null;
          v.requested = ctx.requested.has(v.date);
        }
      }
    } catch (_) { /* 잠금 판정 실패 시 기존 동작 유지 */ }

    if (!videos.length)
      return Response.json({ error: '등록된 수업 영상이 없습니다. 선생님께 문의해주세요.' }, { status: 404 });

    // 접근 로그 (최신 영상에만)
    const latestCode = videos[0].code;
    if (latestCode) {
      try {
        const logObj = await env.BUCKET.get(`video-codes/${latestCode}.json`);
        if (logObj) {
          const logData = await logObj.json();
          const log = logData.access_log || [];
          const now = Date.now();
          const recent = log.find(l =>
            l.name === name &&
            (l.role || null) === (role || null) &&
            now - new Date(l.time).getTime() < 5 * 60 * 1000
          );
          if (!recent) {
            log.push({ name, role, phone, via: 'open', time: new Date().toISOString() });
            logData.access_log   = log;
            logData.access_count = log.length;
            await env.BUCKET.put(`video-codes/${latestCode}.json`, JSON.stringify(logData), {
              httpMetadata: { contentType: 'application/json' },
            });
          }
        }
      } catch { /* 로그 실패해도 영상은 제공 */ }
    }

    return Response.json({
      ok:         true,
      student:    name,
      school:     academy,   // 응답 키는 기존 호환성 위해 school 유지 (실제 값은 학원)
      class_name: className,
      videos:     videos.slice(0, 10),
    });

  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
