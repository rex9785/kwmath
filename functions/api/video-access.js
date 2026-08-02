import { safeError } from './_errors.js';
import { logAudit } from './_auditlog.js';
import { bearerFromRequest, verifyToken, fetchStudentsByPhone } from './_auth.js';
// GET  /api/video-access?code=XXX               → 영상 URL 반환
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
      const obj = await env.BUCKET.get(`video-codes/${code}.json`);
      if (!obj) {
        await logAudit(env, request, {
          action: 'video.access.fail',
          target: code,
          summary: '수업코드 [' + code + '] 조회 실패 — 그런 코드의 영상이 없음',
          detail: {
            입력한코드: code, R2키: 'video-codes/' + code + '.json',
            해석: '학생이 코드를 잘못 옮겨 적었거나, 그 영상이 이미 지워졌다. '
              + '같은 반·같은 날짜로 영상을 다시 올리면 옛 코드는 자동으로 삭제되므로, '
              + '학생이 받아둔 종이 코드가 하루 만에 무효가 됐을 수 있다(같은 시간대 video.code.overwrite · video.delete 기록 확인).',
            효과: '학생이 영상을 못 봄',
          },
        });
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

      await logAudit(env, request, {
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
          인증: '이 조회는 로그인 없이 코드만으로 열린다 — 누구인지는 기기·접속국가로만 짐작할 수 있다(아래 기기 칸 참고)',
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
        await logAudit(env, request, {
          ...행위자,
          action: 'video.access.fail',
          target: code,
          summary: '영상 열람기록 저장 실패 — 코드 [' + code + ']의 영상이 없음 (' + (name || '익명') + ')',
          detail: {
            코드: code, R2키: 'video-codes/' + code + '.json',
            누가: { 이름: name || '(안 보냄)', 구분: role || '(로그인 안 함 또는 이름 불일치)', 로그인번호: loginPhone || '(없음)' },
            열람경로: 경로설명,
            해석: '영상 주소는 받아갔는데 기록을 남기려는 순간 파일이 없었다 — 그 사이 삭제됐거나 재업로드로 대체됐다',
            효과: '학생은 영상을 봤을 수 있지만 열람 기록에는 안 남는다',
          },
        });
        return Response.json({ error: '코드 없음' }, { status: 404 });
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
