import { safeError } from './_errors.js';
// GET /api/class-videos
//   Authorization: Bearer <userToken>   (학부모/학생 로그인 토큰)
//   ?name=홍길동  ← 자녀 여러 명일 때만 필요. 한 명이면 생략 OK
// 학생의 학원/반 영상 목록 반환 + 접근 로그 저장

import { requireStudentAccess } from './_auth.js';
import { absenceLockContext, isLocked } from './_makeup.js';
import { logAudit } from './_auditlog.js';

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

  // 누가 열었는지. 아래 로그들이 공통으로 쓴다.
  const 행위자 = {
    actor: phone || null,
    actorRole: role || 'unknown',
    actorName: name || '',
  };

  if (!academy) {
    // 📓 "영상이 하나도 안 보여요" 신고의 1순위 원인. 학생 정보에 학원이 비어 있으면 매칭 자체가 불가능하다.
    await logAudit(env, request, {
      ...행위자,
      action: 'video.list.fail',
      target: String(access.student.id || ''), targetName: name || '',
      summary: '수업영상 목록 열람 실패 — [' + (name || '이름없음') + '] 학생 정보에 학원이 비어 있음',
      detail: {
        학생: { 학생ID: access.student.id, 이름: name, 학원: '(비어 있음)', 반: className || '(비어 있음)' },
        누가열었나: role === 'parent' ? '학부모' : role === 'student' ? '학생' : (role || '알 수 없음'),
        로그인번호: phone || '(없음)',
        해석: '영상은 학생의 "학원"(대치동 정규반·세정학원 등)과 영상의 학원 이름을 맞춰 찾는다. '
          + '학생 정보에 학원이 없으면 등록된 영상이 있어도 한 편도 못 찾는다.',
        효과: '학생·학부모 화면에 "수강 정보가 등록되어 있지 않습니다"만 뜬다 — 학생 정보에 학원을 채워야 풀린다',
      },
    });
    return Response.json({ error: '수강 정보(학원/반)가 등록되어 있지 않습니다. 선생님께 문의해주세요.' }, { status: 404 });
  }

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
    const 결석잠금 = [];   // 이번 열람에서 실제로 잠긴 날짜들 — "왜 안 보이냐"의 근거
    let 잠금판정실패 = null;
    try {
      const ctx = await absenceLockContext(env, access.student.id);
      for (const v of videos) {
        if (isLocked(ctx, v.date)) {
          v.locked = true;
          v.lockReason = 'absent';
          v.youtube_url = null;
          v.requested = ctx.requested.has(v.date);
          결석잠금.push({ 날짜: v.date || '', 제목: v.title || '', 인강신청함: !!v.requested });
        }
      }
    } catch (e) {
      // 판정이 실패하면 결석한 날 영상이 그대로 열린다(기존 동작 유지). 조용히 넘어가면 아무도 모른다 → 사유를 남긴다.
      잠금판정실패 = String((e && e.message) || e).slice(0, 300);
    }

    if (!videos.length) {
      // 🔴 "어제 영상이 사라졌다"는 신고가 오면 여기가 첫 단서다. 무엇을 기준으로 찾았는지 통째로 남긴다.
      await logAudit(env, request, {
        ...행위자,
        action: 'video.list.empty',
        target: String(access.student.id || ''), targetName: name || '',
        summary: '수업영상 목록 열람 — [' + (name || '이름없음') + '] 볼 수 있는 영상이 0편 (학원 "' + academy + '" · 반 "' + (className || '(빈칸)') + '")',
        detail: {
          학생: { 학생ID: access.student.id, 이름: name, 학원: academy, 반: className || '(빈칸)' },
          누가열었나: role === 'parent' ? '학부모' : role === 'student' ? '학생' : (role || '알 수 없음'),
          로그인번호: phone || '(없음)',
          찾은기준: {
            비교용학원: targetSchool,
            비교용반: targetClass || '(반이 비어 있어 학원만 맞으면 전부 통과)',
            비교규칙: '공백·괄호 같은 표기 차이를 빼고 영문·숫자·한글만 남겨 비교',
          },
          R2에있던영상코드수: listed.objects.length,
          해석: '영상이 아예 안 올라왔거나 · 영상의 학원/반 표기가 학생 정보와 다르거나 · '
            + '누가 전부 비공개(active=false)로 돌렸거나 · 재업로드 자동 대체로 옛 영상이 지워진 경우다.',
          효과: '학생·학부모 화면에 "등록된 수업 영상이 없습니다"만 뜬다',
        },
      });
      return Response.json({ error: '등록된 수업 영상이 없습니다. 선생님께 문의해주세요.' }, { status: 404 });
    }

    // 접근 로그 (최신 영상에만)
    const latestCode = videos[0].code;
    if (latestCode) {
      try {
        const logObj = await env.BUCKET.get(`video-codes/${latestCode}.json`);
        if (logObj) {
          const logData = await logObj.json();
          const log = logData.access_log || [];
          // 덮어쓰기 전 값 — 이미 읽어온 파일에서 공짜로 얻는다(조회를 늘리지 않음).
          const 전열람횟수 = logData.access_count || 0;
          const 전기록수   = log.length;
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

            // 📓 2026-07-31 — 여태 이 열람 기록은 영상 파일 안에만 있었다. 그 영상이 지워지면
            //   (직접 삭제·재업로드 자동 대체) 누가 봤는지가 통째로 같이 사라졌다. 이제 따로 남긴다.
            //   ⚠️ 일부러 "기록이 실제로 늘어난 때"에만 남긴다 — 위 5분 중복방지 덕에 같은 사람이
            //     화면을 계속 새로고침해도 로그가 폭주하지 않는다(단순 재방문은 access_events 쪽에 남는다).
            await logAudit(env, request, {
              ...행위자,
              action: 'video.list.open',
              target: String(latestCode), targetName: logData.title || '',
              summary: '수업영상 목록 열람 — [' + (name || '이름없음') + ']'
                + (role === 'parent' ? '(학부모)' : role === 'student' ? '(학생)' : '')
                + ' ' + videos.length + '편 중 최신 [' + latestCode + '] ' + (logData.title || '제목없음')
                + (결석잠금.length ? ' · 결석으로 잠긴 영상 ' + 결석잠금.length + '편' : ''),
              detail: {
                학생: { 학생ID: access.student.id, 이름: name, 학원: academy, 반: className || '(빈칸)' },
                누가열었나: role === 'parent' ? '학부모' : role === 'student' ? '학생' : (role || '알 수 없음'),
                로그인번호: phone || '(없음)',
                볼수있는영상수: videos.length,
                화면에보낸영상수: Math.min(videos.length, 10),
                목록: videos.slice(0, 30).map(v => ({
                  코드: v.code || '', 날짜: v.date || '', 제목: v.title || '', 반: v.class_name || '',
                  잠김: v.locked ? (v.lockReason === 'absent' ? '결석으로 잠김' : '수업코드 입력 필요') : '바로 재생됨',
                })),
                결석으로잠긴영상수: 결석잠금.length,
                결석으로잠긴영상: 결석잠금.length ? 결석잠금.slice(0, 30) : '(없음)',
                결석잠금판정실패: 잠금판정실패
                  ? '결석 잠금 판정이 실패해 잠금을 못 걸었다(결석한 날 영상도 그대로 열렸을 수 있음): ' + 잠금판정실패
                  : '(정상 판정)',
                열람기록: {
                  기록남긴영상: latestCode,
                  열람횟수: { 전: 전열람횟수, 후: logData.access_count },
                  기록건수: { 전: 전기록수, 후: log.length },
                  비고: '열람 기록은 목록에서 가장 최신 영상 1편에만 쌓인다 — 학생이 옛날 영상을 봐도 그 영상에는 안 남는다',
                },
                목록잘림: videos.length > 10
                  ? '학생 화면에는 최신 10편만 나간다 — 그보다 오래된 ' + (videos.length - 10) + '편은 앱에서 안 보인다'
                  : '(전부 보임)',
                효과: '관우T가 보는 [' + latestCode + '] 영상의 열람자 명단에 한 줄 추가됨',
              },
            });
          }
        }
      } catch (e) {
        // 예전엔 여기서 통째로 삼켰다("로그 실패해도 영상은 제공"). 영상 제공은 그대로 두되, 실패 사실은 남긴다.
        await logAudit(env, request, {
          ...행위자,
          action: 'video.list.logfail',
          target: String(latestCode || ''), targetName: name || '',
          summary: '수업영상 목록은 정상 제공했으나 열람 기록 저장에 실패 — [' + (name || '이름없음') + ']',
          detail: {
            학생: { 학생ID: access.student.id, 이름: name, 학원: academy, 반: className || '(빈칸)' },
            기록하려던영상: latestCode || '(없음)',
            오류: String((e && e.message) || e).slice(0, 500),
            효과: '학생은 영상을 정상적으로 봤지만 열람자 명단에는 안 남는다',
          },
        });
      }
    }

    return Response.json({
      ok:         true,
      student:    name,
      school:     academy,   // 응답 키는 기존 호환성 위해 school 유지 (실제 값은 학원)
      class_name: className,
      videos:     videos.slice(0, 10),
    });

  } catch (e) {
    await logAudit(env, request, {
      ...행위자,
      action: 'video.list.fail',
      target: String(access.student.id || ''), targetName: name || '',
      summary: '수업영상 목록 열람 중 서버 오류 — [' + (name || '이름없음') + '] (학원 "' + academy + '")',
      detail: {
        학생: { 학생ID: access.student.id, 이름: name, 학원: academy, 반: className || '(빈칸)' },
        로그인번호: phone || '(없음)',
        오류: String((e && e.message) || e).slice(0, 500),
        효과: '학생·학부모 화면에 "서버 오류" 안내만 뜨고 영상 목록이 안 나온다',
      },
    });
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
