import { safeError } from './_errors.js';
import { logAudit } from './_auditlog.js';
// POST /api/save-video-code
// MathOS에서 수업 영상 코드를 R2에 저장
export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  let body = {};
  try { body = await request.json(); } catch {}

  const password = body.password || '';
  if (password !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  const code        = (body.code        || '').trim().toUpperCase();
  const youtubeUrl  = (body.youtube_url || '').trim();
  const title       = (body.title       || '').trim();
  const date        = (body.date        || '').trim();
  const school      = (body.school      || '').trim();
  const className   = (body.class_name  || '').trim();
  const requireCode = body.require_code === true;

  if (!code)       return Response.json({ error: 'code 필요' }, { status: 400 });
  if (!youtubeUrl) return Response.json({ error: 'youtube_url 필요' }, { status: 400 });

  const data = {
    code,
    youtube_url: youtubeUrl,
    title,
    date,
    school,
    class_name: className,
    active: true,
    require_code: requireCode,
    created_at: new Date().toISOString(),
    access_log: [],
    access_count: 0,
  };

  try {
    // 🔎 2026-07-31 — 같은 코드로 다시 올리면 옛 내용이 통째로 덮인다. 덮기 전 원본을 읽어둔다.
    let 덮인것 = null;
    try {
      const prev = await env.BUCKET.get(`video-codes/${code}.json`);
      if (prev) 덮인것 = await prev.json();
    } catch (_) {}

    await env.BUCKET.put(`video-codes/${code}.json`, JSON.stringify(data), {
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
    //   ⚠️ 옛 코드의 access_log(열람 기록)도 파일과 함께 삭제된다.
    let replaced = 0;
    const 대체삭제내역 = [];   // 📓 여기서 사라지는 옛 영상 코드 = 학생이 받아간 코드일 수 있다. 전부 남긴다.
    if (date && school && className) {
      const norm = (s) => (s || '').toString().replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();
      try {
        const listed = await env.BUCKET.list({ prefix: 'video-codes/' });
        for (const obj of listed.objects) {
          if (obj.key === `video-codes/${code}.json`) continue;   // 방금 저장한 새 코드는 보존
          try {
            const item = await env.BUCKET.get(obj.key);
            if (!item) continue;
            const old = await item.json();
            if ((old.date || '').trim() === date &&
                norm(old.school) === norm(school) &&
                norm(old.class_name) === norm(className)) {
              대체삭제내역.push({
                지워진코드: old.code || obj.key.replace('video-codes/', '').replace('.json', ''),
                제목: old.title || '', 날짜: old.date || '',
                학원: old.school || '', 반: old.class_name || '',
                유튜브: old.youtube_url || '',
                올린시각: old.created_at || '',
                열람횟수: old.access_count || 0,
                열람기록건수: Array.isArray(old.access_log) ? old.access_log.length : 0,
                R2키: obj.key,
              });
              await env.BUCKET.delete(obj.key);
              replaced++;
            }
          } catch { /* 개별 파일 오류 무시 */ }
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
      target: code, targetName: title || '',
      summary: '수업영상 코드 [' + code + '] ' + (덮인것 ? '덮어쓰기' : '등록')
        + ' — ' + (title || '제목없음') + (date ? ' · ' + date : '')
        + (school ? ' · ' + school : '') + (className ? ' ' + className : '')
        + (replaced ? ' · 같은 반/날짜 옛 코드 ' + replaced + '건 삭제' : ''),
      detail: {
        코드: code, R2키: 'video-codes/' + code + '.json',
        새영상: { 제목: title, 날짜: date, 학원: school, 반: className, 유튜브: youtubeUrl, 코드입력필요: requireCode },
        같은코드덮어쓰기: 덮인것 ? {
          이전제목: 덮인것.title || '', 이전날짜: 덮인것.date || '',
          이전유튜브: 덮인것.youtube_url || '',
          이전열람횟수: 덮인것.access_count || 0,
          이전등록시각: 덮인것.created_at || '',
        } : '(없음 — 새 코드)',
        대체삭제건수: replaced,
        대체삭제내역: 대체삭제내역.slice(0, 30),
        대체규칙: date && school && className
          ? '같은 학원+반+수업날짜의 옛 코드는 자동 삭제(2026-07-30 관우T 확정: 항상 최신 1건만)'
          : '날짜·학원·반 중 빠진 값이 있어 자동 대체를 건너뜀 — 옛 코드가 남아 목록에 2줄 뜰 수 있음',
        영향: replaced
          ? '위 옛 코드를 받아간 학생은 이제 그 코드로 영상을 못 연다(열람기록도 함께 소멸)'
          : '삭제된 옛 코드 없음',
      },
    });

    return Response.json({ ok: true, code, replaced });
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
