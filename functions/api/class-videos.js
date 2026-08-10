import { safeError } from './_errors.js';
// GET /api/class-videos
//   Authorization: Bearer <userToken>   (학부모/학생 로그인 토큰)
//   ?name=홍길동  ← 자녀 여러 명일 때만 필요. 한 명이면 생략 OK
// 학생의 학원/반 영상 목록 반환 + 접근 로그 저장

import { requireStudentAccess, isCompleted } from './_auth.js';
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

  // 🎓 2026-08-10 — 수료생은 수업영상을 못 본다 (관우T 확정: 유예 없이 «즉시 잠금»).
  //   왜: 리포트·성적은 「본인이 만든 기록」이라 계속 보여주는 게 맞지만, 수업영상은 매주 새로 쌓이는 자산이다.
  //   유예를 두면 "안 다녀도 볼 게 있다"가 되어 재등록을 미루는 이유가 된다.
  //   🔴 반 이름 재사용 방지와 **둘 다** 있어야 막힌다: 영상 매칭은 학원 + 반 이름으로만 하므로,
  //     수료생이 「시동반」이라는 같은 이름을 달고 남아 있으면 다음 학기 새 영상까지 매칭된다.
  //     그래서 반 이름에 기수를 붙인다(시동반 (26-2)). 여기 잠금은 그 위의 2차 방어선이다.
  if (isCompleted(access.student.approvalStatus)) {
    // 🎓 2026-08-10 — 잠그는 조건은 수료·졸업이 같지만, **로그에는 실제 상태를 그대로 적는다.**
    //   여기에 '수료'를 박아두면 졸업생이 막힌 기록까지 "수료"로 남아, 나중에 로그만 보고
    //   "졸업 처리한 적 없는데?"라고 헷갈리게 된다. 판정은 isCompleted, 기록은 원문.
    const 끝난상태 = String(access.student.approvalStatus || '').trim() || '수료';
    await logAudit(env, request, {
      ...행위자,
      action: 'video.list.completed',
      target: String(access.student.id || ''), targetName: name || '',
      summary: '수업영상 열람 차단(' + 끝난상태 + ') — [' + (name || '이름없음') + '] ' + (academy || '') + ' · ' + (className || ''),
      detail: {
        학생: { 학생ID: access.student.id, 이름: name, 학원: academy || '(빈칸)', 반: className || '(빈칸)', 상태: 끝난상태 },
        누가열었나: role === 'parent' ? '학부모' : role === 'student' ? '학생' : (role || '알 수 없음'),
        로그인번호: phone || '(없음)',
        해석: '이 학생은 ' + 끝난상태 + ' 상태다. 수업영상은 재원생 전용이다.',
        여전히보이는것: '리포트 · 성적 · 오답 · 출결 기록은 그대로 열린다(본인이 만든 기록이므로)',
        되돌리려면: '관리자 화면에서 이 학생을 새 반에 배정하면 그 반의 영상이 다시 보인다',
      },
    });
    return Response.json({
      error: '수강이 끝난 반입니다. 수업 영상은 재원 중일 때만 볼 수 있어요. 리포트와 성적은 그대로 보실 수 있습니다.',
      reason: 'completed',
    }, { status: 403 });
  }

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

    // 📌 학생 화면에 몇 편을 내려줄지 — 예전엔 최신 10편에서 잘랐다(§11-8 전).
    //   그 바람에 11편째부터는 안내 한 줄 없이 사라졌고, **결석으로 잠긴 영상의 「인강 신청하기」 버튼까지
    //   같이 잘려** 오래 전 결석은 학생이 신청조차 못 했다. 이제 전부 내려주고 앱이 접어서 보여준다.
    //   상한 200은 응답 크기 안전장치일 뿐이다(한 반 영상이 200편을 넘으면 오래된 쪽부터 잘린다).
    const 응답상한 = 200;
    const 보낼영상 = videos.slice(0, 응답상한);

    // 접근 로그 — 「목록 열람」은 **영상 파일(R2)에 안 쓰고 감사로그(D1)에만** 남긴다 (2026-08-03 §11-8).
    //   예전엔 목록만 열어도 최신 영상 1편의 access_log 에 줄이 들어갔다. 세 가지가 잘못됐다.
    //     ① 실제로는 안 본 사람이 그 영상 열람자로 집계돼 명단이 부풀려졌다.
    //     ② 여기서 R2 파일을 **조건 없이** 통째로 덮어써, 그 사이 video-access.js 가 적은 진짜 시청 기록을
    //        조용히 지울 수 있었다(video-access.js 는 조건부 쓰기로 막았는데 이 파일이 남은 구멍이었다).
    //     ③ access_count 를 log.length 로 덮어써, 상한 300줄로 잘라도 안 줄도록 만든 누적 횟수를 되돌렸다.
    //   화면에서는 그대로 보인다 — video-list.js 가 이 감사기록을 열람자 명단과 합쳐 「목록열람」으로 표시한다.
    //   ※ 학생이 실제로 영상을 보면 그 영상에 /api/video-access 가 따로 기록한다(이 파일과 무관).
    const 최신영상 = videos[0];
    const latestCode = 최신영상.code;
    if (latestCode) {
      try {
        // 5분 중복방지 — 예전엔 R2 파일 안 기록으로 판단했다. 이제 감사로그에서 직접 본다.
        //   같은 사람이 화면을 새로고침해도 로그가 폭주하지 않게 한다.
        let 직전기록 = null;
        try {
          const 기준시각 = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          직전기록 = await env.DB.prepare(
            "SELECT id FROM audit_log WHERE action = 'video.list.open' AND target = ? "
            + 'AND actor_name = ? AND actor_role = ? AND ts >= ? ORDER BY id DESC LIMIT 1'
          ).bind(String(latestCode), name || '', role || 'unknown', 기준시각).first();
        } catch (_) {
          직전기록 = null;   // 중복 판정을 못 해도 기록은 남긴다 — 빠뜨리는 것보다 한 줄 더 남는 게 낫다
        }
        if (!직전기록) {
          await logAudit(env, request, {
            ...행위자,
            action: 'video.list.open',
            target: String(latestCode), targetName: 최신영상.title || '',
            summary: '수업영상 목록 열람 — [' + (name || '이름없음') + ']'
              + (role === 'parent' ? '(학부모)' : role === 'student' ? '(학생)' : '')
              + ' ' + videos.length + '편 중 최신 [' + latestCode + '] ' + (최신영상.title || '제목없음')
              + (결석잠금.length ? ' · 결석으로 잠긴 영상 ' + 결석잠금.length + '편' : ''),
            detail: {
              학생: { 학생ID: access.student.id, 이름: name, 학원: academy, 반: className || '(빈칸)' },
              누가열었나: role === 'parent' ? '학부모' : role === 'student' ? '학생' : (role || '알 수 없음'),
              로그인번호: phone || '(없음)',
              볼수있는영상수: videos.length,
              화면에보낸영상수: 보낼영상.length,
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
                기록위치: '영상 파일(R2)에는 안 쓴다 — 이 감사기록이 「목록 열람」의 유일한 기록이다',
                붙는영상: latestCode,
                비고: '관리자 화면은 이 기록을 열람자 명단과 합쳐 「목록열람」으로 따로 세어 보여준다. '
                  + '실제 시청·수업코드 입력은 /api/video-access 가 그 영상에 따로 남긴다.',
              },
              목록잘림: videos.length > 보낼영상.length
                ? '영상이 ' + videos.length + '편이라 오래된 ' + (videos.length - 보낼영상.length)
                  + '편은 응답에서 잘렸다(상한 ' + 응답상한 + '편)'
                : '(전부 보냄 — 앱이 최근 것부터 펼치고 나머지는 「더 보기」로 접는다)',
              효과: '관우T가 보는 [' + latestCode + '] 영상의 열람자 명단에 「목록열람」 한 줄로 표시됨 (영상 파일은 안 건드림)',
            },
          });
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
      videos:       보낼영상,          // 전부(상한 200) — 앱이 최근 것부터 펼치고 나머지는 「더 보기」로 접는다
      videos_total: videos.length,     // 잘렸는지 앱이 알 수 있게
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
