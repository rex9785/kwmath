import { safeError } from './_errors.js';
import { logAudit } from './_auditlog.js';
// POST /api/video-delete  (admin only)
// 영상 코드 R2 객체 삭제 — admin.html 영상 관리 탭의 🗑 삭제 버튼용
// body: { code }
export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}

  const code = (body.code || '').trim().toUpperCase();
  if (!code) return Response.json({ error: 'code 필요' }, { status: 400 });

  try {
    const key = `video-codes/${code}.json`;
    const obj = await env.BUCKET.get(key);
    if (!obj) return Response.json({ error: '해당 코드 영상 없음' }, { status: 404 });

    // 삭제 전에 메타데이터 한 번 더 읽어서 응답에 포함 (감사 로그용)
    let meta = null;
    try { meta = await obj.json(); } catch {}

    await env.BUCKET.delete(key);

    // 📓 2026-07-31 — 여기 주석은 예전부터 "감사 로그용"이라고 적혀 있었지만, 실제로는
    //   응답(JSON)에만 담고 어디에도 저장하지 않았다. 응답은 브라우저가 닫히면 사라진다.
    //   → 진짜 로그로 남긴다. 코드가 사라지면 그 코드로 보던 학생은 영상을 못 본다.
    await logAudit(env, request, {
      action: 'video.delete',
      target: code, targetName: (meta && meta.title) || '',
      summary: '영상 코드 [' + code + '] 삭제 — ' + ((meta && meta.title) || '제목없음')
        + ((meta && meta.date) ? ' · ' + meta.date : '') + ' (복구 불가)',
      detail: {
        코드: code, R2키: key,
        지워진영상: meta || '(메타 파싱 실패 — 원본 JSON을 못 읽음)',
        영향: '이 코드를 받은 학생은 더 이상 해당 영상을 열 수 없음',
      },
    });

    return Response.json({
      ok: true,
      code,
      deleted: {
        code,
        date:       meta?.date || '',
        school:     meta?.school || '',
        class_name: meta?.class_name || '',
        title:      meta?.title || '',
      },
    });
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
