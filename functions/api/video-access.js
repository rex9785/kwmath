import { safeError } from './_errors.js';
import { logAudit } from './_auditlog.js';
import { bearerFromRequest, verifyToken, fetchStudentsByPhone, isCompleted } from './_auth.js';
// GET  /api/video-access?code=XXX               → 영상 URL 반환
//   Authorization: Bearer <userToken> — 🎓 2026-08-12부터 **필수**. 수료·졸업 학생을 여기서도 막기 위해서다.
//     (원장은 Bearer <ADMIN_PASSWORD> 로 통과 — 코드가 살아 있는지 직접 확인할 길은 남겨 둔다.)
// POST /api/video-access { code, name, via }     → 접근 기록 저장
//   Authorization: Bearer <userToken> (선택) — 있으면 학부모/학생 계정 식별해 로그에 기록

export async function onRequest({ request, env }) {
  const url = new URL(request.url);

  // ── GET: 코드로 영상 조회 ──────────────────────────────
  // 📓 2026-07-31 — 읽기지만 로그를 남긴다. "수업코드를 넣었는데 영상이 안 나온다"는 신고가 오면
  //   여기 실패 기록(없는 코드 / 비활성)이 유일한 단서다. 성공도 남긴다 —
  //   "이 코드로 실제 영상 주소가 나갔다"를 증명할 수 있는 자리가 여기뿐이기 때문(코드 유출 추적 포함).
  if (request.method === 'GET') {
    const code = (url.searchParams.get('code') || '').trim().toUpperCase();
    if (!code) {
      await logAudit(env, request, {
        action: 'video.access.fail',
        summary: '수업코드 조회 실패 — 코드를 안 넣고 조회함',
        detail: {
          입력한코드: '(비어 있음)',
          해석: '학생이 입력칸을 비운 채 눌렀거나, 앱이 빈 값으로 요청했다',
          효과: '영상 주소가 나가지 않음',
        },
      });
      return Response.json({ error: '코드를 입력해주세요.' }, { status: 400 });
    }

    try {
      // ── 🎓 2026-08-12 — 여기서부터 신원을 본다 (수료·졸업 영상 잠금) ──────────────
      //   관우T 확정(2026-08-10 · 재제안 금지): 「수료생 수업영상 = **즉시 잠금**」. 30일/60일/영구 열람은 기각.
      //   그런데 그 잠금은 `class-videos.js`(로그인 후 목록)에만 들어갔고 **이 GET 에는 없었다.**
      //   실제 사고: 조에스더(세정학원 ▸ 썸머 시동반)를 2026-08-10 수료 처리했는데,
      //   수료 전에 손에 넣은 옛 수업코드로는 이 API 가 영상 주소를 계속 내줬다.
      //   목록만 막고 코드를 안 막으면 「즉시 잠금」이 반쪽이다.
      //
      //   🔴 예전 주석은 "무인증이 의도된 설계"였다 — 그 설계의 **실사용자를 전수로 세어 보니 0명**이었다.
      //     이 GET 을 부르는 곳은 `report.html` 과 `video.html` 의 `unlockVideo()` 둘뿐이고,
      //     두 화면 다 시작하자마자 토큰이 없으면 `/portal` 로 튕긴다(`report.html:207` · `video.html:150`).
      //     MathOS 는 이 API 를 안 쓴다(관리자용 `/api/video-list` 프록시를 쓴다).
      //   ⇒ 익명 통로를 남겨 두면 **Authorization 헤더만 빼면 가드를 그냥 통과**하므로 잠금이 장식이 된다.
      //     그래서 토큰을 필수로 올렸다. 단 조용히 죽이지 않고 `video.access.denied` 로 **소리 나게** 남긴다 —
      //     내가 못 찾은 익명 사용자가 정말 있으면 이 로그에 뜬다(그게 되돌릴 근거가 된다).
      const bearer = bearerFromRequest(request);
      const 원장  = !!(env.ADMIN_PASSWORD && bearer && bearer === env.ADMIN_PASSWORD);
      const 신원  = (!원장 && bearer) ? await verifyToken(env, bearer) : null;
      const 내학생 = (신원 && 신원.phone) ? await fetchStudentsByPhone(env, 신원.phone) : [];

      if (!원장 && (!신원 || !내학생.length)) {
        const 학생없음 = !!신원 && !내학생.length;
        const 사유 = !bearer ? '토큰 없음(로그인 안 함)'
          : !신원 ? '토큰이 만료됐거나 폐기됨'
          : '이 휴대폰에 연결된 학생이 없음';
        await logAudit(env, request, {
          action: 'video.access.denied',
          target: code,
          actorRole: 학생없음 ? 'unknown' : 'anon',
          summary: '수업코드 [' + code + '] 조회 거부 — ' + 사유,
          detail: {
            입력한코드: code,
            사유,
            로그인번호: (신원 && 신원.phone) || '(없음)',
            해석: '2026-08-12부터 이 조회에는 로그인 토큰이 필요하다(수료·졸업 잠금을 여기서도 걸기 위해). '
              + '앱의 두 화면은 이미 로그인 뒤에만 열리므로 정상 경로면 여기 올 일이 없다 — '
              + 'API 를 직접 불렀거나, 내가 못 찾은 익명 사용 경로가 남아 있다는 뜻이다.',
            효과: '영상 주소가 나가지 않음(코드가 실제로 있는지도 알려주지 않는다 — R2 조회 전에 잘랐다)',
            되돌리려면: '이 기록이 실제 학생·학부모에게서 반복되면 「토큰 필수」를 풀고 '
              + '「토큰이 있을 때만 검사」로 낮춘다(그 경우 헤더를 빼면 뚫린다는 점은 감수하는 것).',
          },
        });
        return Response.json({
          error: 학생없음
            ? '이 휴대폰에 연결된 학생이 없습니다. 관우T께 문의해주세요.'
            : (bearer ? '로그인이 만료됐습니다. 앱에서 다시 로그인한 뒤 눌러주세요.'
                      : '수업 영상은 로그인 후에 볼 수 있습니다. 앱에서 로그인한 뒤 다시 눌러주세요.'),
          reason: 학생없음 ? 'no-student' : 'auth',
        }, { status: 학생없음 ? 403 : 401 });
      }

      const obj = await env.BUCKET.get(`video-codes/${code}.json`);
      if (!obj) {
        // 🔴 2026-08-03 (§11-9 ⓒ) — "없는 코드"라고 바로 자르지 않고 **대체 표식**을 먼저 본다.
        //   같은 학원·반·수업날짜로 새 영상이 올라오면 옛 코드는 자동 삭제된다(2026-07-30 확정 규칙).
        //   그 순간 save-video-code.js 가 video-replaced/{코드}.json 에 표식을 남긴다.
        //   표식이 있으면 **오타가 아니라 대체다** — 학생 화면에도 로그에도 그렇게 말해 준다.
        //   (여태 이 자리의 로그는 "잘못 적었거나 / 지워졌거나"라고 추측만 하고 있었다.)
        let 표식 = null, 표식오류 = null;
        try {
          const mk = await env.BUCKET.get(`video-replaced/${code}.json`);
          if (mk) 표식 = await mk.json();
        } catch (e) { 표식오류 = String((e && e.message) || e).slice(0, 200); }

        await logAudit(env, request, {
          action: 'video.access.fail',
          target: code,
          summary: 표식
            ? '수업코드 [' + code + '] 조회 실패 — 새 영상으로 대체된 옛 코드 (' + (표식.title || '제목없음') + ')'
            : '수업코드 [' + code + '] 조회 실패 — 그런 코드의 영상이 없음',
          detail: 표식
            ? {
                입력한코드: code, R2키: 'video-codes/' + code + '.json',
                판정: '✅ 오타가 아니다 — 이 코드는 자동 대체로 삭제됐다(대체 표식 확인됨)',
                대체된시각: 표식.replaced_at || '(기록 없음)',
                대체한새코드: 표식.replaced_by || '(기록 없음)',
                지워진영상: {
                  제목: 표식.title || '', 날짜: 표식.date || '',
                  학원: 표식.school || '', 반: 표식.class_name || '',
                  삭제전열람횟수: 표식.access_count || 0,
                },
                해석: '같은 학원·반·수업날짜로 새 영상이 올라와 옛 코드가 자동 삭제됐다(2026-07-30 확정 규칙). '
                  + '학생이 화면을 오래 열어두고 있었을 가능성이 크다 — 새로고침하면 새 영상이 보인다.',
                효과: '학생 화면에 대체 안내가 나갔다(예전엔 「유효하지 않은 코드입니다.」 한 줄뿐이었다)',
              }
            : {
                입력한코드: code, R2키: 'video-codes/' + code + '.json',
                대체표식: 표식오류
                  ? '🔴 확인 실패 — ' + 표식오류
                  : '없음 (video-replaced/' + code + '.json 이 없다)',
                해석: '대체 표식이 없다. ⓐ 코드를 잘못 옮겨 적었거나 ⓑ 영상 관리 화면에서 원장이 직접 삭제했거나 '
                  + 'ⓒ 표식을 남기기 시작한 2026-08-03 이전에 대체된 코드다'
                  + '(같은 시간대 video.code.overwrite · video.delete 기록 확인).',
                효과: '학생이 영상을 못 봄',
              },
        });

        if (표식) {
          return Response.json({
            error: '이 수업 영상은 새로 올라온 영상으로 바뀌었어요.\n화면을 새로고침하면 새 영상이 보입니다.',
            replaced: true,
            replaced_at: 표식.replaced_at || '',
            title: 표식.title || '',
            date:  표식.date || '',
          }, { status: 404 });
        }
        return Response.json({ error: '유효하지 않은 코드입니다.' }, { status: 404 });
      }

      const data = await obj.json();
      if (!data.active) {
        await logAudit(env, request, {
          action: 'video.access.denied',
          target: code, targetName: data.title || '',
          summary: '수업코드 [' + code + '] 조회 거부 — 비활성 처리된 영상 (' + (data.title || '제목없음') + ')',
          detail: {
            입력한코드: code,
            영상: { 제목: data.title || '', 날짜: data.date || '', 학원: data.school || '', 반: data.class_name || '' },
            비활성으로바꾼시각: data.updated_at || '(기록 없음 — 처음부터 비활성이었거나 기록 이전에 바뀜)',
            해석: '누군가 영상 관리 화면에서 이 영상을 비공개로 돌렸다(video.update 기록에서 누가 언제 껐는지 확인).',
            효과: '학생이 코드를 제대로 넣었는데도 영상을 못 봄',
          },
        });
        return Response.json({ error: '비활성화된 코드입니다.' }, { status: 403 });
      }

      // 🎓 2026-08-12 — 수료·졸업이면 여기서 막는다 (`class-videos.js` 의 목록 잠금과 똑같은 규칙·똑같은 문구).
      //   ⚠️ `=== '수료'` 로 직접 비교하지 말 것 — 졸업생이 그냥 통과한다. 판정은 `isCompleted()` 하나로(_auth.js).
      //   🔴 겸반 주의: 「시동반=수료 · 공통수학2=재원」인 학생을 통째로 막으면 **다니는 반 영상까지 잠긴다.**
      //     그래서 이 영상의 **학원+반과 같은 행**만 골라 그 행의 상태로 판정한다.
      //     (⚠️ 영상 레코드의 학원 필드는 `academy` 가 아니라 `school` 이다 — 설계문서 §8.)
      //     반 이름이 바뀌어 한 행도 안 맞으면 그 사람의 모든 행으로 판정한다(전부 수료·졸업일 때만 막힌다).
      //   🔴 `every` 인 이유: 형제가 한 계정을 쓰면 행이 여러 개다. **한 명이라도 재원이면 열어 준다** —
      //     잘못 막아서 생기는 민원(다니는 아이가 못 봄)이 잘못 열어서 생기는 손해보다 크다.
      if (!원장) {
        const 같음 = (a, b) => String(a || '').trim() === String(b || '').trim();
        const 반행 = 내학생.filter((s) => 같음(s.academy, data.school) && 같음(s.className, data.class_name));
        const 판정대상 = 반행.length ? 반행 : 내학생;
        if (판정대상.every((s) => isCompleted(s.approvalStatus))) {
          // 판정은 isCompleted, 기록은 원문 — '수료'를 박아두면 졸업생이 막힌 기록까지 "수료"로 남는다.
          const 끝난상태 = String(판정대상[0].approvalStatus || '').trim() || '수료';
          await logAudit(env, request, {
            actor: 신원.phone,
            actorRole: 판정대상[0].role || 'unknown',
            actorName: 판정대상[0].name || '',
            action: 'video.access.completed',
            target: code, targetName: data.title || '',
            summary: '수업코드 [' + code + '] 조회 차단(' + 끝난상태 + ') — ['
              + (판정대상[0].name || '이름없음') + '] ' + (data.school || '') + ' · ' + (data.class_name || ''),
            detail: {
              입력한코드: code,
              영상: { 제목: data.title || '', 날짜: data.date || '', 학원: data.school || '', 반: data.class_name || '' },
              학생: 판정대상.map((s) => ({
                학생ID: String(s.id), 이름: s.name, 학원: s.academy || '', 반: s.className || '', 상태: s.approvalStatus || '',
              })),
              판정근거: 반행.length
                ? '이 영상의 학원+반과 같은 행으로 판정'
                : '이 영상의 반과 맞는 행이 하나도 없어 이 사람의 모든 행으로 판정(반 이름이 바뀌었을 수 있다)',
              로그인번호: 신원.phone,
              해석: '이 학생은 ' + 끝난상태 + ' 상태다. 목록(class-videos)은 2026-08-10부터 막혀 있었지만, '
                + '수료 전에 받아 둔 옛 수업코드로 들어오는 이 경로가 2026-08-12까지 열려 있었다.',
              여전히보이는것: '리포트 · 성적 · 오답 · 출결 기록은 그대로 열린다(본인이 만든 기록이므로)',
              효과: '영상 주소가 나가지 않음',
              남은구멍: '이미 복사해 둔 유튜브 주소는 이 가드가 못 막는다 — 끊으려면 유튜브에서 '
                + '「비공개」로 바꿔야 한다(admin.html 의 「🔒 유튜브」 버튼). 일부공개엔 만료도 도메인 제한도 없다.',
            },
          });
          return Response.json({
            error: '수강이 끝난 반입니다. 수업 영상은 재원 중일 때만 볼 수 있어요. 리포트와 성적은 그대로 보실 수 있습니다.',
            reason: 'completed',
          }, { status: 403 });
        }
      }

      await logAudit(env, request, {
        // 🎓 2026-08-12 — 이제 이 조회에도 신원이 실린다. 예전 이 자리의 로그는 「누구인지 알 수 없음」이었다.
        ...(원장
          ? { actorRole: 'admin', actorName: '원장' }
          : { actor: 신원.phone, actorRole: 내학생[0].role || 'unknown', actorName: 내학생[0].name || '' }),
        action: 'video.access.view',
        target: code, targetName: data.title || '',
        summary: '수업코드 [' + code + ']로 영상 주소 받아감 — ' + (data.title || '제목없음')
          + (data.date ? ' · ' + data.date : '') + (data.class_name ? ' · ' + data.class_name : ''),
        detail: {
          입력한코드: code,
          영상: {
            제목: data.title || '', 날짜: data.date || '', 학원: data.school || '',
            반: data.class_name || '', 유튜브: data.youtube_url || '',
          },
          지금까지열람횟수: data.access_count || 0,
          인증: 원장
            ? '원장 비밀번호(ADMIN_PASSWORD)로 조회 — 코드 점검용 통로다'
            : '로그인 토큰으로 신원 확인됨 (2026-08-12부터 이 조회는 로그인 필수)',
          누가: 원장 ? '원장' : {
            로그인번호: 신원.phone,
            연결된학생: 내학생.map((s) => s.name + '(' + (s.approvalStatus || '재원') + ' · ' + (s.className || '반없음') + ')').join(', '),
          },
          효과: '영상 주소가 이 기기로 나갔다(열람 횟수는 별도 POST 요청이 들어와야 올라간다)',
        },
      });

      return Response.json({
        ok: true,
        youtube_url: data.youtube_url,
        title:       data.title,
        date:        data.date,
        school:      data.school,
        class_name:  data.class_name,
        access_count: data.access_count || 0,
      });
    } catch (e) {
      await logAudit(env, request, {
        action: 'video.access.fail',
        target: code,
        summary: '수업코드 [' + code + '] 조회 중 서버 오류',
        detail: {
          입력한코드: code,
          오류: String((e && e.message) || e).slice(0, 500),
          효과: '학생이 영상을 못 봄(코드 자체는 멀쩡할 수 있음 — 재시도 필요)',
        },
      });
      return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  }

  // ── POST: 접근 기록 저장 ───────────────────────────────
  if (request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}

    const code = (body.code || '').trim().toUpperCase();
    const name = (body.name || '').trim();
    const via  = (body.via || 'watch').toString();   // 'watch'(공개영상 시청) | 'code'(수업코드 입력)
    const 경로설명 = via === 'code' ? '수업코드를 직접 입력해서 열람' : (via === 'watch' ? '앱 영상 목록에서 바로 시청' : '경로 표시: ' + via);
    if (!code) {
      await logAudit(env, request, {
        action: 'video.access.fail',
        summary: '영상 열람기록 저장 실패 — 어느 영상인지(code)를 안 보냄',
        detail: {
          보낸이름: name || '(없음)', 열람경로: 경로설명,
          효과: '열람 기록이 안 쌓임 — 이 학생이 영상을 봤다는 사실이 어디에도 안 남는다',
        },
      });
      return Response.json({ error: 'code 필요' }, { status: 400 });
    }

    // 로그인 토큰이 있으면 어떤 계정(학부모/학생)이 눌렀는지 식별. 없으면 익명으로 기록(하위호환).
    let role = null, loginPhone = null, studentId = null;
    try {
      const token = bearerFromRequest(request);
      if (token) {
        const payload = await verifyToken(env, token);
        if (payload && payload.phone) {
          loginPhone = payload.phone;
          const students = await fetchStudentsByPhone(env, loginPhone);
          const matched = students.find(s => s.name === name);
          role = matched ? matched.role : null;   // 'student' | 'parent' | 'other' | null
          // 🔴 2026-08-03 — 이름만 남기면 동명이인(김민준 둘)을 영영 못 가른다. 학생 번호를 같이 남긴다.
          studentId = matched ? matched.id : null;
        }
      }
    } catch (_) { /* 식별 실패해도 로그는 남긴다 */ }

    // 누가 눌렀는지. 로그인 안 했으면 이름만 남는다(위조 가능) — 그 사실도 로그에 적어 둔다.
    const 행위자 = loginPhone
      ? { actor: loginPhone, actorRole: role || 'unknown', actorName: name || '익명' }
      : { actorRole: 'anon', actorName: name || '익명' };

    // 🔴 2026-08-03 — R2에는 트랜잭션이 없다. 아래는 "읽고 → 고치고 → 통째로 다시 쓰기"라,
    //   두 사람이 같은 영상을 동시에 열면 나중에 쓴 쪽이 앞사람 줄을 덮어 지웠다(수업 직후에 잘 생긴다).
    //   → 조건부 쓰기(onlyIf.etagMatches)로 "내가 읽은 그대로일 때만" 저장하고, 아니면 다시 읽어 재시도한다.
    const R2키 = `video-codes/${code}.json`;
    const 최대기록 = 300;   // R2 파일에 남길 열람기록 상한 — 화면엔 최근 30개만 쓴다. 감사로그엔 전부 남는다.

    try {
      const obj = await env.BUCKET.get(R2키);
      if (!obj) {
        // 🔴 2026-08-03 (§11-9 ⓒ) — 여기가 실제로 제일 자주 걸리는 자리다.
        //   공개 영상의 재생 버튼은 유튜브 주소가 **이미 박힌 링크**라 서버를 안 거친다.
        //   그래서 화면을 열어둔 채 영상이 대체되면, 학생은 **옛 주소를 그대로 열고**
        //   이 기록 요청만 조용히 404가 난다(학생은 아무 에러도 못 본다).
        //   → 대체 표식을 확인해 "이 학생은 대체 전 옛 영상을 봤다"를 추측이 아니라 확정으로 남긴다.
        let 표식 = null;
        try {
          const mk = await env.BUCKET.get(`video-replaced/${code}.json`);
          if (mk) 표식 = await mk.json();
        } catch (_) { /* 표식 확인 실패해도 로그는 남긴다 */ }

        await logAudit(env, request, {
          ...행위자,
          action: 'video.access.fail',
          target: code,
          summary: '영상 열람기록 저장 실패 — 코드 [' + code + ']의 영상이 '
            + (표식 ? '새 영상으로 대체됨' : '없음') + ' (' + (name || '익명') + ')',
          detail: {
            코드: code, R2키: 'video-codes/' + code + '.json',
            누가: { 이름: name || '(안 보냄)', 학생번호: studentId, 구분: role || '(로그인 안 함 또는 이름 불일치)', 로그인번호: loginPhone || '(없음)' },
            열람경로: 경로설명,
            대체표식: 표식
              ? {
                  판정: '✅ 대체됨 — 이 학생은 대체 전 옛 영상을 보고 있었다',
                  대체된시각: 표식.replaced_at || '(기록 없음)',
                  대체한새코드: 표식.replaced_by || '(기록 없음)',
                  옛영상: { 제목: 표식.title || '', 날짜: 표식.date || '', 학원: 표식.school || '', 반: 표식.class_name || '' },
                }
              : '없음 — 원장이 직접 삭제했거나, 표식을 남기기 시작한 2026-08-03 이전 건이다',
            해석: 표식
              ? '학생이 화면을 열어둔 사이 같은 학원·반·날짜로 새 영상이 올라와 옛 코드가 자동 삭제됐다. '
                + '공개 영상은 재생 링크에 주소가 박혀 있어 학생 화면에는 에러가 안 뜬다 — '
                + '⚠️ URL을 고치려고 재업로드하셨다면 이 학생은 **고치기 전 주소**를 본 것이다.'
              : '영상 주소는 받아갔는데 기록을 남기려는 순간 파일이 없었다 — 그 사이 삭제됐거나 재업로드로 대체됐다',
            효과: '학생은 영상을 봤을 수 있지만 열람 기록에는 안 남는다',
          },
        });
        return Response.json({ error: '코드 없음', replaced: !!표식 }, { status: 404 });
      }

      let data = await obj.json();
      let etag = obj.etag;

      // 🔴 2026-08-03 — 비활성(비공개)으로 돌린 영상에는 열람기록을 남기지 않는다.
      //   GET(수업코드 조회)에는 예전부터 이 검사가 있었는데 POST에는 없어서,
      //   API를 직접 부르면 꺼둔 영상의 열람 횟수·명단을 얼마든지 부풀릴 수 있었다.
      if (!data.active) {
        await logAudit(env, request, {
          ...행위자,
          action: 'video.access.denied',
          target: code, targetName: data.title || '',
          summary: '영상 열람기록 저장 거부 — 비활성 처리된 영상 [' + code + '] (' + (name || '익명') + ')',
          detail: {
            코드: code, R2키,
            영상: { 제목: data.title || '', 날짜: data.date || '', 학원: data.school || '', 반: data.class_name || '' },
            누가: { 보낸이름: name || '(안 보냄)', 학생번호: studentId, 로그인번호: loginPhone || '(없음)' },
            열람경로: 경로설명, 열람경로코드: via,
            해석: '학생 화면에는 비활성 영상이 안 뜨므로 정상 경로로는 여기 올 일이 없다. '
              + '영상을 끄기 직전에 열어둔 화면에서 늦게 도착한 요청이거나, API를 직접 부른 것이다.',
            효과: '열람 횟수·명단이 올라가지 않음(영상 주소도 이미 GET에서 막힌다)',
          },
        });
        return Response.json({ error: '비활성화된 코드입니다.' }, { status: 403 });
      }

      // 덮어쓰기 전 값 — 이미 읽어온 파일에서 공짜로 얻는다(조회를 늘리지 않음).
      const 전열람횟수 = data.access_count || 0;
      const 전기록수   = Array.isArray(data.access_log) ? data.access_log.length : 0;
      const now    = Date.now();
      const nowIso = new Date(now).toISOString();

      let log = [], recent = null, saved = false, 시도 = 0, 충돌 = 0, 잘라낸수 = 0, 잘라낸줄 = [];
      while (시도 < 3) {
        시도++;
        const 기존기록 = Array.isArray(data.access_log) ? data.access_log : [];
        const 기존횟수 = (typeof data.access_count === 'number') ? data.access_count : 기존기록.length;
        log = 기존기록.slice();

        // 중복 방지: 같은 이름+계정(role)+코드는 5분 이내 재접근 무시.
        //   학부모와 학생은 role이 달라 각각 따로 카운트된다.
        //   ※ 재시도할 때는 새로 읽어온 목록으로 다시 판단한다 — 그 사이 남이 붙인 줄까지 보고 결정해야 한다.
        recent = log.find(l =>
          l.name === name &&
          (l.role || null) === (role || null) &&
          now - new Date(l.time).getTime() < 5 * 60 * 1000
        );
        if (!recent) {
          log.push({
            name:  name || '익명',
            role:  role,           // 학부모/학생 식별 (null = 비로그인·수업코드)
            student_id: studentId, // 🔴 동명이인 구분 — 이름만 남기면 김민준 둘을 영영 못 가른다
            phone: loginPhone,     // 로그인 계정 휴대폰 (관우T 식별용)
            via:   via,            // 'watch' | 'code'
            time:  nowIso,
          });
        }
        // 무한 증식 방지 — 한 줄 쓸 때마다 이 파일을 통째로 읽고 다시 쓰므로, 커질수록 모든 열람이 느려진다.
        //   🔴 자르는 건 되돌릴 수 없다. 2026-07-31 이후의 열람은 감사로그(D1)에 따로 한 줄씩 있으니 안 사라지지만,
        //      **그 전에 쌓인 줄은 이 파일에만 있다.** 그래서 잘라낼 줄을 아래 감사기록에 통째로 박아 두고 자른다.
        //      (detail 은 20000자에서 잘리므로 최대 120줄까지만 싣는다 — 그보다 많이 잘릴 일은 사실상 첫 정리 때뿐이다.)
        if (log.length > 최대기록) {
          잘라낸수 = log.length - 최대기록;
          잘라낸줄 = log.slice(0, Math.min(잘라낸수, 120));
          log = log.slice(-최대기록);
        }

        data.access_log   = log;
        data.access_count = 기존횟수 + (recent ? 0 : 1);   // 잘라내도 줄지 않도록 길이가 아니라 누적값으로 센다

        const put = await env.BUCKET.put(R2키, JSON.stringify(data), {
          httpMetadata: { contentType: 'application/json' },
          onlyIf: { etagMatches: etag },   // 내가 읽은 그대로일 때만 저장. 아니면 put이 null을 돌려준다.
        });
        if (put) { saved = true; break; }

        // 그 사이 다른 사람이 먼저 저장했다 → 새로 읽어서 내 줄을 다시 붙인다(앞사람 줄도 안 지워진다).
        충돌++;
        const again = await env.BUCKET.get(R2키);
        if (!again) break;               // 그 사이 영상이 삭제됨 — 더 쓸 곳이 없다
        data = await again.json();
        etag = again.etag;
      }

      // 📓 2026-07-31 — 여태 이 쓰기는 아무 기록도 안 남겼다. 열람 기록은 영상 파일 안에만 있어서,
      //   그 영상이 지워지면(재업로드 자동 대체 포함) 누가 봤는지가 통째로 같이 사라졌다.
      //   → 이제 영상이 사라져도 "누가 언제 봤다"가 감사 로그에 따로 남는다.
      await logAudit(env, request, {
        ...행위자,
        action: recent ? 'video.access.noop' : 'video.access.log',
        target: code, targetName: data.title || '',
        summary: (recent
          ? '영상 열람 재요청 — 5분 내 같은 사람이라 횟수는 안 올림'
          : '영상 열람 기록 +1')
          + ' [' + code + '] ' + (name || '익명')
          + (role === 'parent' ? '(학부모)' : role === 'student' ? '(학생)' : loginPhone ? '(로그인 계정)' : '(비로그인)')
          + ' — ' + (data.title || '제목없음') + (data.date ? ' · ' + data.date : ''),
        detail: {
          코드: code, R2키: 'video-codes/' + code + '.json',
          영상: { 제목: data.title || '', 날짜: data.date || '', 학원: data.school || '', 반: data.class_name || '' },
          누가: {
            보낸이름: name || '(안 보냄 — 익명으로 기록됨)',
            학생번호: studentId,   // 동명이인 구분용 — null 이면 로그인 계정과 이름이 안 맞았다는 뜻
            구분: role === 'parent' ? '학부모' : role === 'student' ? '학생' : role === 'other' ? '기타 보호자'
              : (loginPhone ? '로그인은 했지만 보낸 이름과 일치하는 학생이 없음' : '로그인 안 함(수업코드로 들어옴)'),
            로그인번호: loginPhone || '(없음)',
          },
          열람경로: 경로설명,
          열람경로코드: via,
          열람횟수: { 전: 전열람횟수, 후: data.access_count },
          기록건수: { 전: 전기록수, 후: log.length },
          중복무시: recent
            ? '같은 이름·같은 구분으로 5분 안에 이미 기록이 있어 새 줄을 안 붙였다(마지막 기록 시각: ' + (recent.time || '') + ')'
            : '(중복 아님 — 새 줄을 붙였다)',
          동시쓰기: {
            저장시도: 시도,
            충돌: 충돌,
            결과: saved ? '저장 성공' : '3번 다시 시도해도 저장 못 함(또는 그 사이 영상이 삭제됨)',
            설명: 충돌
              ? '같은 순간에 다른 사람도 이 영상을 열어서 파일이 먼저 바뀌었다 — 다시 읽어서 붙였으므로 양쪽 다 남는다.'
              : '(충돌 없음)',
          },
          기록상한: 잘라낸수
            ? {
                설명: '영상 파일 안 기록이 ' + 최대기록 + '줄을 넘어 오래된 ' + 잘라낸수 + '줄을 잘라냈다.',
                잘라낸수,
                잘라낸줄,   // 되돌릴 수 없는 삭제라 잘라낸 줄을 여기 통째로 남긴다(최대 120줄)
                미기록: 잘라낸수 > 잘라낸줄.length
                  ? ('용량 때문에 ' + (잘라낸수 - 잘라낸줄.length) + '줄은 여기 못 실었다 — 그 줄들은 열람 시각이 가장 오래된 것들이다.')
                  : '(전부 실었다)',
              }
            : '(상한 ' + 최대기록 + '줄 이내)',
          비고: '보낸 이름은 앱이 실어 보내는 값이라 로그인을 안 했으면 아무 이름이나 들어올 수 있다 — 위 "구분" 칸이 (로그인 안 함)이면 이름은 자기 신고일 뿐이다.',
          효과: !saved
            ? '🔴 영상 파일에는 못 남겼다 — 이 감사기록이 이 열람의 유일한 증거다(열람자 명단은 감사로그와 합쳐 보여주므로 화면에는 나온다)'
            : recent
              ? '영상 파일은 다시 저장됐지만 열람 횟수·기록은 그대로 (관우T가 보는 열람자 명단에 변화 없음)'
              : '관우T가 보는 이 영상의 열람자 명단에 한 줄 추가됨',
        },
      });

      return Response.json({ ok: true });
    } catch (e) {
      await logAudit(env, request, {
        ...행위자,
        action: 'video.access.fail',
        target: code,
        summary: '영상 [' + code + '] 열람기록 저장 중 서버 오류 (' + (name || '익명') + ')',
        detail: {
          코드: code,
          누가: { 이름: name || '(안 보냄)', 학생번호: studentId, 로그인번호: loginPhone || '(없음)' },
          열람경로: 경로설명, 열람경로코드: via,
          오류: String((e && e.message) || e).slice(0, 500),
          효과: '학생은 영상을 봤을 수 있지만 열람 기록에는 안 남는다',
        },
      });
      return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}
