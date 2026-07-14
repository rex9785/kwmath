// POST /api/notify-class-materials (admin only)
// 반 전용 수업자료(class/{학원}_{반}/…)가 올라오면 → 그 반 학생의 "학부모" 폰으로 푸시 1회.
//   body: { academy, className, date?, count? }
//   대상: listStudents 중 academy+className 일치 학생의 parentPhone(정규화). 학부모만(관우T 지시 2026-07-14).
//   ⚠️ 대상 결정은 서버가 함 — 클라(admin.html)는 "어느 반"만 알려줌. 임의 폰 목록 발송 차단.
//   공개 자료(전체 공개)·리포트는 이 엔드포인트 대상 아님(호출부가 class-shared 업로드에서만 호출).
//   best-effort: 실패해도 등록/업로드는 이미 끝났으니 알림만 조용히 실패.
import { normalizePhone } from './_auth.js';
import { listStudents } from './_db.js';
import { sendPushToUsers } from './_push.js';
import { safeError } from './_errors.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용' }, { status: 405 });

  // 인증: 원장/조교 세션을 미들웨어가 Bearer ADMIN_PASSWORD로 번역 → 그 값만 통과.
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const academy = String(body.academy || '').trim();
  const className = String(body.className || '').trim();
  const date = String(body.date || '').trim();
  const count = Number(body.count) || 0;
  if (!academy || !className) return Response.json({ error: 'academy·className 필수' }, { status: 400 });

  try {
    const all = await listStudents(env);
    const inClass = (all || []).filter(s => (s.academy || '') === academy && (s.className || '') === className);
    // 학부모만 — 정규화한 학부모 폰(포털이 푸시 구독에 쓰는 키와 동일 형식: 010-1234-5678).
    const phones = [...new Set(inClass.map(s => normalizePhone(s.parentPhone)).filter(Boolean))];
    if (!phones.length) return Response.json({ ok: true, targeted: 0, note: '대상 학부모 없음' });

    const nice = date && date.length >= 10 ? date.slice(5).replace('-', '/') : date;   // 2026-07-14 → 07/14
    const p = sendPushToUsers(env, phones, {
      title: '📚 새 수업자료가 올라왔어요',
      body: className + (nice ? (' · ' + nice) : '') + ' 수업자료' + (count ? (' ' + count + '개') : '') + ' — 앱에서 확인하세요',
      url: '/materials',                                   // 포털 "수업 자료실" = materials.html (반 전용 R2 자료 로드)
      // tag를 반+날짜로 고유화 → 형제(다른 반)·다른 날 알림이 서로 덮어쓰지 않음. 같은 반·같은 날 재업로드는 1건으로 합쳐짐.
      tag: 'kwmath-mat-' + academy + '_' + className + (date ? '-' + date : ''),
    });
    if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
    else if (p && typeof p.catch === 'function') p.catch(() => {});

    return Response.json({ ok: true, targeted: phones.length });
  } catch (e) {
    return safeError(e, env, { message: '알림 발송 중 오류가 발생했습니다.' });
  }
}
