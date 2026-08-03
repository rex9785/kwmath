import { safeError } from './_errors.js';
import { logAudit } from './_auditlog.js';
// POST /api/save-video-code
// MathOS에서 수업 영상 코드를 R2에 저장
export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  let body = {};
  try { body = await request.json(); } catch {}
  // JSON이 객체가 아닐 수도 있다(문자열·숫자·null). 아래에서 `'키' in body` 를 쓰므로 여기서 막는다.
  if (!body || typeof body !== 'object') body = {};

  const password = body.password || '';
  if (password !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  const code        = (body.code        || '').trim().toUpperCase();
  const youtubeUrl  = (body.youtube_url || '').trim();
  const title       = (body.title       || '').trim();
  const date        = (body.date        || '').trim();
  const school      = (body.school      || '').trim();
  const className   = (body.class_name  || '').trim();

  if (!code)       return Response.json({ error: 'code 필요' }, { status: 400 });
  if (!youtubeUrl) return Response.json({ error: 'youtube_url 필요' }, { status: 400 });

  const R2키 = `video-codes/${code}.json`;

  try {
    // 🔎 2026-07-31 — 같은 코드로 다시 올리면 옛 내용이 통째로 덮인다. 덮기 전 원본을 읽어둔다.
    // 🔴 2026-08-03 (§11-9) — 이 읽기가 이제 "기록용"이 아니라 **데이터 승계용**이다.
    //   실패를 조용히 삼키면 옛 열람기록을 그대로 날려버리므로, 읽기 자체가 터진 경우에는 저장하지 않는다.
    //   (§11-8에서 정한 것과 같은 태도 — 안전하게 못 쓸 바엔 안 쓴다.)
    let 덮인것 = null;
    let 이전읽기오류 = null;
    try {
      const prev = await env.BUCKET.get(R2키);
      if (prev) 덮인것 = await prev.json();
    } catch (e) {
      이전읽기오류 = String((e && e.message) || e);
    }

    if (이전읽기오류) {
      await logAudit(env, request, {
        action: 'video.code.abort',
        actor: '__mathos__', actorRole: 'mathos', actorName: 'MathOS 영상 업로더',
        target: code, targetName: title || '',
        summary: '수업영상 코드 [' + code + '] 저장 중단 — 이전 파일을 못 읽어 열람기록을 잃을 위험',
        detail: {
          코드: code, R2키,
          오류: 이전읽기오류,
          해석: '같은 코드가 이미 있는데 그 내용을 못 읽었다. 그대로 저장하면 옛 열람기록·소속(학원/반/날짜)이 통째로 사라진다.',
          효과: '아무것도 저장하지 않았다 — 옛 영상은 그대로다. MathOS에서 다시 시도하면 된다.',
        },
      });
      return Response.json(
        { error: '이전 영상 정보를 읽지 못해 저장을 중단했습니다. 잠시 후 다시 시도해 주세요.' },
        { status: 503 });
    }

    // ── 승계 규칙 (2026-08-03 §11-9 신설) ─────────────────────────────────────────
    //   같은 코드로 다시 저장할 때, 예전에는 `data`를 매번 맨바닥에서 새로 지어서
    //   ① access_log·access_count가 0으로 초기화되고
    //   ② 안 보낸 title/date/school/class_name이 빈 문자열로 덮여 **학원·반·날짜가 통째로 날아갔다**
    //      (class-videos.js가 학원+반으로 매칭하므로 그 영상은 학생 목록에서 사라진다)
    //   ③ require_code가 false로, active가 true로 되돌아갔다.
    //   MathOS 정상 경로(send-to-notion)는 매번 새 랜덤 코드를 만들어서 이 문제를 안 겪지만,
    //   URL만 고치는 `/api/update-video-code` 릴레이(server.py:907)는 같은 코드로 재저장한다.
    //   → 새 코드면 지금까지와 똑같고, 기존 코드면 안 보낸 값·기록을 옛 파일에서 그대로 이어받는다.
    //   ⚠️ 값을 "비우는" 건 이 API로 못 한다(빈 문자열 = 안 보냄으로 본다). 비우기·끄기는 admin 영상관리(video-update.js).
    const 승계 = (보낸값, 옛값) => 보낸값 || (덮인것 ? (옛값 || '') : '');
    const requireCode = ('require_code' in body)
      ? body.require_code === true
      : (덮인것 ? 덮인것.require_code === true : false);
    const active = ('active' in body)
      ? body.active !== false
      : (덮인것 ? 덮인것.active !== false : true);

    const 유효제목 = 승계(title,     덮인것 && 덮인것.title);
    const 유효날짜 = 승계(date,      덮인것 && 덮인것.date);
    const 유효학원 = 승계(school,    덮인것 && 덮인것.school);
    const 유효반   = 승계(className, 덮인것 && 덮인것.class_name);

    const nowIso = new Date().toISOString();
    const data = {
      code,
      youtube_url: youtubeUrl,
      title:      유효제목,
      date:       유효날짜,
      school:     유효학원,
      class_name: 유효반,
      active,
      require_code: requireCode,
      created_at: (덮인것 && 덮인것.created_at) || nowIso,
      ...(덮인것 ? { updated_at: nowIso } : {}),
      // 🔴 열람기록 승계 — 여기가 §11-9의 핵심이다. 옛 파일이 있으면 절대 0으로 되돌리지 않는다.
      access_log:   (덮인것 && Array.isArray(덮인것.access_log)) ? 덮인것.access_log : [],
      access_count: (덮인것 && typeof 덮인것.access_count === 'number') ? 덮인것.access_count : 0,
    };

    await env.BUCKET.put(R2키, JSON.stringify(data), {
      httpMetadata: { contentType: 'application/json' },
    });

    // ── 재업로드 대체 규칙 (2026-07-30 관우T 확정: "무조건 새로 올린 거 기준으로 — 영상도"): ──
    //   같은 학원+반+수업날짜의 옛 코드를 전부 삭제해 항상 최신 업로드 1건만 남긴다.
    //   (전엔 재업로드마다 새 랜덤 코드가 쌓여 학생 영상 목록·MathOS 타임라인에 같은 날짜가 2줄씩 떴음.
    //    리포트는 reports-write.js:34 가드로 이미 최신 1건 유지 — 이제 영상도 같은 규칙.)
    //   순서 의도: 새 코드 저장 "성공 후"에만 옛 것을 지운다 — 저장 실패 시 옛 영상이 그대로 남아 안전.
    //   삭제 실패는 비치명(중복이 잠깐 남을 뿐, 다음 재업로드 때 다시 정리됨).
    //   비교 규칙은 class-videos.js의 norm과 동일(공백·괄호 차이 흡수) — 두 파일이 어긋나면 안 됨.
    //   ⚠️ 한계(의도): 같은 반이 같은 날짜에 서로 다른 영상 2편을 일부러 올리는 경우도 앞 편이 대체된다.
    //   ⚠️ 옛 코드의 access_log(열람 기록)도 파일과 함께 삭제된다 → 아래에서 감사로그에 원본을 박아 둔다.
    //   🔎 2026-08-03 (§11-9) — 비교 기준을 body 값이 아니라 **승계된 유효값**으로 바꿨다.
    //      URL만 고치는 재저장(날짜·학원·반 미전송)에서도 소속을 알 수 있게 됐기 때문.
    let replaced = 0;
    let 훑은파일수 = 0;
    let 목록못끝냄 = false;
    const 대체삭제내역 = [];   // 📓 여기서 사라지는 옛 영상 코드 = 학생이 받아간 코드일 수 있다. 전부 남긴다.
    if (유효날짜 && 유효학원 && 유효반) {
      const norm = (s) => (s || '').toString().replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();
      try {
        // 🔴 2026-08-03 (§11-9) — 예전엔 limit도 커서도 없어서 R2 기본 페이지(1000개)까지만 훑었다.
        //   그 뒤 영상은 조용히 안 지워져 학생 목록에 같은 날짜가 2줄씩 뜨기 시작한다(증상만 보면 원인을 못 찾는다).
        //   → 커서로 끝까지 돈다. 20페이지(=2만 개) 넘어가면 멈추고 아래 감사로그에 "못 끝냄"으로 남긴다.
        let cursor;
        for (let page = 0; page < 20; page++) {
          const listed = await env.BUCKET.list({ prefix: 'video-codes/', limit: 1000, cursor });
          훑은파일수 += listed.objects.length;
          for (const obj of listed.objects) {
            if (obj.key === R2키) continue;   // 방금 저장한 새 코드는 보존
            try {
              const item = await env.BUCKET.get(obj.key);
              if (!item) continue;
              const old = await item.json();
              if ((old.date || '').trim() === 유효날짜 &&
                  norm(old.school) === norm(유효학원) &&
                  norm(old.class_name) === norm(유효반)) {
                // 🔴 2026-08-03 (§11-9) — 예전엔 "열람기록 12건" 같은 **숫자만** 남기고 실제 줄은 안 남겼다.
                //   같은 리포의 video-delete.js:41 은 지워진 원본을 통째로 남기는데,
                //   원장이 직접 누른 삭제보다 자동 대체가 더 조용한데 기록은 더 부실했던 셈이다.
                //   → 실제 줄을 감사로그에 박아 둔다. detail 은 20000자에서 잘리므로 **첫 1건에만 최근 60줄**.
                //   (2026-07-31 이후의 열람은 §11-7 덕분에 감사로그에 video.access.log 로 한 줄씩 따로 있다.
                //    여기서 건지는 건 사실상 그 전에 쌓인 줄이다.)
                const 원본줄 = Array.isArray(old.access_log) ? old.access_log : [];
                const 항목 = {
                  지워진코드: old.code || obj.key.replace('video-codes/', '').replace('.json', ''),
                  제목: old.title || '', 날짜: old.date || '',
                  학원: old.school || '', 반: old.class_name || '',
                  유튜브: old.youtube_url || '',
                  올린시각: old.created_at || '',
                  열람횟수: old.access_count || 0,
                  열람기록건수: 원본줄.length,
                  R2키: obj.key,
                };
                if (대체삭제내역.length === 0) {
                  항목.열람기록_실은줄 = 원본줄.slice(-60);
                  항목.열람기록_실은줄수 = Math.min(원본줄.length, 60);
                  항목.열람기록_나머지 = 원본줄.length > 60
                    ? (원본줄.length - 60) + '줄은 여기 못 실었다 — audit_log 에서 target=' + 항목.지워진코드 + ' 로 찾아볼 것'
                    : '(없음 — 전부 실었다)';
                } else {
                  항목.열람기록_실은줄 = '(2건째부터는 건수만 — detail 길이 상한. audit_log target=' + 항목.지워진코드 + ' 로 조회)';
                }
                // 🔴 2026-08-03 (§11-9 ⓒ) — 지우기 **전에** "이 코드는 대체됐다"는 표식을 따로 남긴다.
                //   여태 옛 코드로 들어온 요청은 「유효하지 않은 코드입니다.」 한 줄만 받았고,
                //   서버 로그조차 "잘못 옮겨 적었거나 / 지워졌거나"라고 **추측**만 적고 있었다.
                //   → 표식이 있으면 학생에게는 정확한 안내를, 로그에는 확정 기록(언제·어느 코드로)을 남긴다.
                //   순서 의도: 표식을 먼저 쓰고 지운다(반대면 "지워졌는데 표식 없음" 구간이 생긴다).
                //   별도 prefix(video-replaced/)라 video-codes/ 를 훑는 다른 API에는 영향이 없다
                //   (list 호출은 전부 prefix를 명시하고 있음 — 2026-08-03 확인).
                const 표식코드 = (항목.지워진코드 || '').toUpperCase();
                if (표식코드) {
                  try {
                    await env.BUCKET.put('video-replaced/' + 표식코드 + '.json', JSON.stringify({
                      code: 표식코드,
                      replaced_by: code,               // 이 코드로 바뀌었다
                      replaced_at: nowIso,
                      title:      old.title || '',
                      date:       old.date || '',
                      school:     old.school || '',
                      class_name: old.class_name || '',
                      access_count: old.access_count || 0,
                      reason: '같은 학원·반·수업날짜로 새 영상이 올라와 자동 대체됨',
                    }), { httpMetadata: { contentType: 'application/json' } });
                    항목.대체표식 = '남김 (video-replaced/' + 표식코드 + '.json)';
                  } catch (e) {
                    항목.대체표식 = '🔴 못 남김 — ' + String((e && e.message) || e).slice(0, 200)
                      + ' → 이 코드로 들어오면 예전처럼 「유효하지 않은 코드입니다.」만 나간다';
                  }
                }
                대체삭제내역.push(항목);
                await env.BUCKET.delete(obj.key);
                replaced++;
              }
            } catch { /* 개별 파일 오류 무시 */ }
          }
          if (!listed.truncated) break;
          cursor = listed.cursor;
          if (page === 19) 목록못끝냄 = true;
        }
      } catch { /* 목록 조회 실패 시 대체 생략 — 다음 업로드 때 정리 */ }
    }

    // 📓 2026-07-31 — 영상 등록은 여태 기록이 없었다. 그런데 이 한 번의 호출이
    //   ① 같은 코드 덮어쓰기 ② 같은 반·같은 날짜 옛 코드 **삭제**(열람기록 포함) 두 가지를 한다.
    //   "어제 영상이 사라졌다"는 신고가 오면 이 로그가 유일한 단서다.
    //   ⚠️ 이 API는 Bearer가 아니라 body.password 로 인증한다(MathOS가 호출) → 행위자를 직접 지정.
    await logAudit(env, request, {
      action: 덮인것 ? 'video.code.overwrite' : 'video.code.create',
      actor: '__mathos__', actorRole: 'mathos', actorName: 'MathOS 영상 업로더',
      target: code, targetName: 유효제목 || '',
      summary: '수업영상 코드 [' + code + '] ' + (덮인것 ? '덮어쓰기' : '등록')
        + ' — ' + (유효제목 || '제목없음') + (유효날짜 ? ' · ' + 유효날짜 : '')
        + (유효학원 ? ' · ' + 유효학원 : '') + (유효반 ? ' ' + 유효반 : '')
        + (replaced ? ' · 같은 반/날짜 옛 코드 ' + replaced + '건 삭제' : ''),
      detail: {
        코드: code, R2키,
        새영상: { 제목: 유효제목, 날짜: 유효날짜, 학원: 유효학원, 반: 유효반, 유튜브: youtubeUrl, 코드입력필요: requireCode, 공개: active },
        같은코드덮어쓰기: 덮인것 ? {
          이전제목: 덮인것.title || '', 이전날짜: 덮인것.date || '',
          이전유튜브: 덮인것.youtube_url || '',
          이전열람횟수: 덮인것.access_count || 0,
          이전등록시각: 덮인것.created_at || '',
          승계: '열람기록·열람횟수·등록시각을 그대로 이어받았다. 안 보낸 제목/날짜/학원/반/코드입력필요/공개 값도 옛 값 유지(2026-08-03 §11-9).',
          안보낸값: [
            !title     ? '제목' : null, !date      ? '날짜' : null,
            !school    ? '학원' : null, !className ? '반'   : null,
            !('require_code' in body) ? '코드입력필요' : null,
            !('active' in body)       ? '공개여부'     : null,
          ].filter(Boolean).join(' · ') || '(없음 — 전부 보냈다)',
        } : '(없음 — 새 코드)',
        대체삭제건수: replaced,
        대체삭제내역: 대체삭제내역.slice(0, 30),
        훑은파일수,
        목록못끝냄: 목록못끝냄
          ? '⚠️ video-codes/ 가 2만 개를 넘어 끝까지 못 훑었다 — 옛 코드가 안 지워지고 남아 있을 수 있다'
          : false,
        대체규칙: (유효날짜 && 유효학원 && 유효반)
          ? '같은 학원+반+수업날짜의 옛 코드는 자동 삭제(2026-07-30 관우T 확정: 항상 최신 1건만)'
          : '날짜·학원·반 중 빠진 값이 있어 자동 대체를 건너뜀 — 옛 코드가 남아 목록에 2줄 뜰 수 있음',
        영향: replaced
          ? '위 옛 코드를 받아간 학생은 이제 그 코드로 영상을 못 연다(영상 파일과 함께 열람기록도 소멸 — 위 「열람기록_실은줄」이 사본)'
          : '삭제된 옛 코드 없음',
      },
    });

    return Response.json({ ok: true, code, replaced, overwritten: !!덮인것 });
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
