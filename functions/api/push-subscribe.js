import { safeError } from './_errors.js';
import { logAudit, describeDevice } from './_auditlog.js';
// /api/push-subscribe
// 브라우저 푸쉬 구독 정보 저장/해제.
// portal 페이지가 결정한 userId(이메일이든, 학생ID든, 휴대폰이든) 기준으로 묶음.
// 한 사용자 = 여러 기기/브라우저 가능 (구독 여러 개 누적, endpoint로 중복 제거).
//
// POST  — 구독 등록 (Body: { userId, subscription })
// DELETE — 구독 해제 (Body: { userId, endpoint })
//
// 저장: R2 key = push-subs/{userId}.json
// 구조: { userId, subs: [ { endpoint, keys: {p256dh, auth}, ua, savedAt } ], updatedAt }

export async function onRequest({ request, env }) {
  if (request.method === 'POST')   return handleSubscribe(request, env);
  if (request.method === 'DELETE') return handleUnsubscribe(request, env);
  return Response.json({ error: 'POST 또는 DELETE만 허용' }, { status: 405 });
}

// 예약(시스템) userId 보호.
//   '__' 접두 id(예: __admin__)는 새 질문·문의 알림 수신자다. 무인증이면 아무나
//   그 id로 자기 기기를 구독(알림 가로채기)하거나 전체 해제(알림 끊기)할 수 있으므로,
//   관리자/조교 인증이 있을 때만 조작을 허용한다.
//   미들웨어가 adm_/ast_ 세션을 Bearer ADMIN_PASSWORD로 번역하므로 그 값만 통과.
//   학생 전화번호 id(숫자, '__' 아님)는 종전대로 무인증 허용 → portal 흐름 무변경.
function isReservedUserId(id) { return typeof id === 'string' && id.startsWith('__'); }
function adminAuthed(request, env) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  return !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
}
function reservedGuard(userId, request, env) {
  if (isReservedUserId(userId) && !adminAuthed(request, env)) {
    return Response.json({ error: '권한이 없습니다.' }, { status: 403 });
  }
  return null;
}

// ───────── POST: 구독 등록 ─────────
async function handleSubscribe(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}

  const userId = String(body.userId || '').trim();
  const sub = body.subscription;

  if (!userId)
    return Response.json({ error: 'userId 필수' }, { status: 400 });
  const guard = reservedGuard(userId, request, env);
  if (guard) return guard;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
    return Response.json({ error: 'subscription 형식 오류' }, { status: 400 });

  const key = `push-subs/${encodeURIComponent(userId)}.json`;
  const ua = request.headers.get('user-agent') || '';

  // 기존 구독 로드 (있으면)
  let record = { userId, subs: [], updatedAt: '' };
  try {
    const existing = await env.BUCKET.get(key);
    if (existing) {
      const text = await existing.text();
      const parsed = JSON.parse(text);
      if (parsed && Array.isArray(parsed.subs)) record = parsed;
    }
  } catch {}

  // endpoint 기준 중복 제거 후 추가
  const 전기기수 = record.subs.length;
  const 이미있던기기 = record.subs.some(s => s.endpoint === sub.endpoint);
  const filtered = record.subs.filter(s => s.endpoint !== sub.endpoint);
  filtered.push({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    ua,
    savedAt: new Date().toISOString()
  });
  record.subs = filtered;
  record.userId = userId;
  record.updatedAt = new Date().toISOString();

  try {
    await env.BUCKET.put(key, JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' }
    });

    // 📓 2026-07-31 — 웹푸시 구독은 여태 **아무 기록도 없었다**. FCM(앱 푸시)은 등록·해제·교체가
    //   전부 로그에 남는데 웹푸시만 깜깜이여서, "알림이 안 와요"가 들어와도
    //   구독을 한 적이 있는지/언제 끊겼는지 확인할 방법이 없었다. 비대칭을 없앤다.
    //   ⚠️ keys(p256dh·auth)는 절대 안 남긴다 — 그 값이면 이 기기로 푸시를 쏠 수 있다.
    //      endpoint 도 앞 60자만(어느 푸시서버인지 + 구분용).
    await logAudit(env, request, {
      action: 이미있던기기 ? 'push.web.subscribe.refresh' : 'push.web.subscribe',
      target: userId, targetName: describeDevice(ua),
      summary: '웹푸시 구독 ' + (이미있던기기 ? '갱신' : '등록')
        + ' [' + userId + '] · ' + describeDevice(ua)
        + ' · 기기 ' + 전기기수 + '대 → ' + record.subs.length + '대',
      detail: {
        사용자id: userId,
        기기: describeDevice(ua),
        기기수: { 전: 전기기수, 후: record.subs.length },
        같은기기재등록: 이미있던기기,
        푸시서버: (() => { try { return new URL(sub.endpoint).host; } catch (_) { return '(주소 파싱 실패)'; } })(),
        endpoint앞부분: String(sub.endpoint).slice(0, 60) + '…',
        보관기기목록: record.subs.map(s => ({
          기기: describeDevice(s.ua || ''),
          등록시각: s.savedAt || '',
          endpoint앞부분: String(s.endpoint || '').slice(0, 40) + '…',
        })).slice(0, 20),
        R2키: key,
        예약id여부: isReservedUserId(userId) ? '시스템 id(__로 시작) — 관리자 인증 통과함' : '일반 사용자',
        비고: 'keys(p256dh·auth)는 보안상 로그에 남기지 않음',
      },
    });
    return Response.json({ ok: true, deviceCount: record.subs.length });
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}

// ───────── DELETE: 구독 해제 ─────────
// body: { userId, endpoint? }
//   endpoint 명시 → 그 기기 1개만 해제
//   endpoint 없음 → 해당 userId의 모든 기기 해제 (계정 삭제용)
async function handleUnsubscribe(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}

  const userId = String(body.userId || '').trim();
  const endpoint = String(body.endpoint || '').trim();

  if (!userId)
    return Response.json({ error: 'userId 필수' }, { status: 400 });
  const guard = reservedGuard(userId, request, env);
  if (guard) return guard;

  const key = `push-subs/${encodeURIComponent(userId)}.json`;

  try {
    const existing = await env.BUCKET.get(key);
    if (!existing) {
      // 이미 없으면 성공으로 처리 (idempotent)
      // 📓 "지울 게 없었다"도 기록한다 — 로그아웃했는데 알림이 계속 오는 신고가 들어오면
      //   여기가 0건이었는지(애초에 구독이 다른 id로 저장됐는지) 확인해야 한다.
      await logAudit(env, request, {
        action: 'push.web.unsubscribe.noop',
        target: userId, targetName: describeDevice(request.headers.get('user-agent') || ''),
        summary: '웹푸시 해제 요청 [' + userId + '] — 저장된 구독이 이미 없었음(0건 처리)',
        detail: {
          사용자id: userId, R2키: key,
          요청범위: endpoint ? '기기 1대(endpoint 지정)' : '이 id 전체',
          결과: '해당 R2 파일이 없음 — 구독한 적 없거나 이미 전부 해제됨',
          점검힌트: '알림이 계속 온다면 다른 userId(전화번호 형식 차이 등)로 구독돼 있을 수 있음',
        },
      });
      return Response.json({ ok: true, removed: 0, remaining: 0 });
    }
    const text = await existing.text();
    let record = JSON.parse(text);
    if (!record || !Array.isArray(record.subs)) record = { userId, subs: [] };

    const before = record.subs.length;
    // ⚠️ 어떤 기기의 알림이 끊겼는지가 핵심이다 — 지우기 전에 그 기기들을 붙잡아 둔다.
    const 지워질기기 = (endpoint ? record.subs.filter(s => s.endpoint === endpoint) : record.subs.slice())
      .map(s => ({
        기기: describeDevice(s.ua || ''),
        등록시각: s.savedAt || '',
        endpoint앞부분: String(s.endpoint || '').slice(0, 40) + '…',
      }));
    if (endpoint) {
      // 특정 endpoint만 제거
      record.subs = record.subs.filter(s => s.endpoint !== endpoint);
    } else {
      // 전체 제거
      record.subs = [];
    }
    const removed = before - record.subs.length;
    record.userId = userId;
    record.updatedAt = new Date().toISOString();

    let R2처리 = '';
    if (record.subs.length === 0) {
      // 구독 0개면 R2 파일 자체 삭제
      await env.BUCKET.delete(key);
      R2처리 = '남은 기기 0 → R2 파일 자체를 삭제(복구 불가)';
    } else {
      await env.BUCKET.put(key, JSON.stringify(record), {
        httpMetadata: { contentType: 'application/json' }
      });
      R2처리 = '남은 기기 ' + record.subs.length + '대 → 파일 갱신';
    }

    await logAudit(env, request, {
      action: endpoint ? 'push.web.unsubscribe' : 'push.web.unsubscribe.all',
      target: userId,
      targetName: (지워질기기[0] && 지워질기기[0].기기) || '',
      summary: '웹푸시 구독 해제 [' + userId + '] · '
        + (endpoint ? '기기 1대 지정' : '이 id 전체')
        + ' — ' + removed + '대 해제 · 남은 기기 ' + record.subs.length + '대'
        + (removed === 0 ? ' (지정한 기기가 목록에 없었음)' : ''),
      detail: {
        사용자id: userId, R2키: key,
        요청범위: endpoint ? '기기 1대(endpoint 지정 — 보통 그 기기 로그아웃)' : '이 id 전체(계정 삭제·전체 해제)',
        기기수: { 전: before, 후: record.subs.length },
        해제건수: removed,
        해제된기기: 지워질기기.slice(0, 20),
        남은기기: record.subs.map(s => ({
          기기: describeDevice(s.ua || ''), 등록시각: s.savedAt || '',
        })).slice(0, 20),
        R2처리,
        요청한기기: describeDevice(request.headers.get('user-agent') || ''),
        예약id여부: isReservedUserId(userId) ? '시스템 id(__로 시작) — 관리자 인증 통과함' : '일반 사용자',
        효과: removed > 0
          ? '위 기기들은 이제 웹푸시 알림을 받지 않는다(앱 FCM은 별도)'
          : '실제로 끊긴 기기 없음 — endpoint가 목록에 없었다',
      },
    });
    return Response.json({ ok: true, removed, remaining: record.subs.length });
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
