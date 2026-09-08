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
//
// 🔴 2026-09-08 — 조교 알림 누수 수정 (관우T 발견: "준원이는 세정학원 조교인데 알람이 갔네")
//   무슨 일이 있었나:
//     session-keep.js 의 adminLoggedIn() 은 kwmath_admin_pw / kwmath_admin_token 이 있으면
//     원장으로 본다. 그런데 조교 로그인도 **같은 키**를 쓴다. 그래서 조교가 알림을 켜면
//     그 폰이 원장 채널 `__admin__` 에 그대로 등록됐다. 위 reservedGuard 도 조교를 막지 못했다 —
//     미들웨어가 조교 세션을 Bearer ADMIN_PASSWORD 로 번역해 주기 때문이다(설계상 정상 동작).
//   샌 것: 생활기록 출석·지각·식사(학생 실명·지각 시간 포함) · 새 수업 문의(문의자 이름/번호)
//          · 새 질문/답변 · 출결 미입력 독촉 · 신규 가입 신청 · 설문 응답 · 월급 알림 등 전부.
//   고친 방법: 조교가 보낸 `__admin__` 요청을 **서버에서** `staff:{전화번호}` 로 갈아끼운다.
//     - 클라이언트(session-keep.js·각 화면)는 종전대로 `__admin__` 을 보내도 된다
//       → 옛 캐시가 남은 폰도 자동으로 교정된다(클라 배포 순서에 의존하지 않는다).
//     - 전화번호는 미들웨어가 ast_ 토큰을 검증한 뒤 넣는 X-Staff-Phone 만 믿는다.
//       외부 주입 헤더는 미들웨어가 무조건 지우므로 위조 불가.
//     - 이미 `__admin__` 에 박혀 있던 조교 기기는 등록/해제할 때 같이 빼낸다(아래 legacy 정리).
function staffPhoneOf(request) {
  return String(request.headers.get('X-Staff-Phone') || '').replace(/\D/g, '');
}
// 조교가 원장 채널을 겨냥한 요청 → 본인 채널로 치환. 원장·학생은 그대로 통과.
function resolveUserId(rawId, request) {
  const sp = staffPhoneOf(request);
  if (!sp) return rawId;
  if (rawId === '__admin__' || rawId.startsWith('staff:')) return 'staff:' + sp;
  return rawId;
}
function isReservedUserId(id) {
  return typeof id === 'string' && (id.startsWith('__') || id.startsWith('staff:'));
}
function adminAuthed(request, env) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  return !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
}
function reservedGuard(userId, request, env) {
  if (!isReservedUserId(userId)) return null;
  if (!adminAuthed(request, env)) {
    return Response.json({ error: '권한이 없습니다.' }, { status: 403 });
  }
  const sp = staffPhoneOf(request);
  if (userId.startsWith('staff:')) {
    // 조교 채널은 그 조교 본인만. (resolveUserId 를 거치면 항상 참이지만, 직접 호출 대비 이중 잠금)
    if (!sp || userId !== 'staff:' + sp) {
      return Response.json({ error: '권한이 없습니다.' }, { status: 403 });
    }
    return null;
  }
  // `__` 시스템 채널은 원장만. (조교는 위에서 이미 갈아끼워졌으므로 여기 오면 우회 시도)
  if (sp) return Response.json({ error: '권한이 없습니다.' }, { status: 403 });
  return null;
}

// 옛 오염 청소 — `push-subs/__admin__.json` 에 박혀 있는 이 기기(endpoint)를 빼낸다.
//   조교가 구독하거나 로그아웃할 때 한 번씩 불러, 손으로 R2를 뒤지지 않아도 저절로 정리되게 한다.
//   반환: 뺀 기기 정보(로그용) 또는 null.
async function pruneFromAdminChannel(env, endpoint) {
  const key = 'push-subs/__admin__.json';
  try {
    const obj = await env.BUCKET.get(key);
    if (!obj) return null;
    const rec = JSON.parse(await obj.text());
    if (!rec || !Array.isArray(rec.subs)) return null;
    const hit = rec.subs.find(s => s && s.endpoint === endpoint);
    if (!hit) return null;
    rec.subs = rec.subs.filter(s => s && s.endpoint !== endpoint);
    rec.userId = '__admin__';
    rec.updatedAt = new Date().toISOString();
    if (rec.subs.length === 0) await env.BUCKET.delete(key);
    else await env.BUCKET.put(key, JSON.stringify(rec), { httpMetadata: { contentType: 'application/json' } });
    return { 기기: describeDevice(hit.ua || ''), 등록시각: hit.savedAt || '', 원장채널남은기기: rec.subs.length };
  } catch (_) { return null; }
}

// ───────── POST: 구독 등록 ─────────
async function handleSubscribe(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}

  const rawId = String(body.userId || '').trim();
  const userId = resolveUserId(rawId, request);   // 조교의 __admin__ → staff:{전화번호}
  const sub = body.subscription;

  if (!rawId)
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

    // 🔴 2026-09-08 — 조교라면, 예전에 원장 채널(__admin__)에 박혀 있던 이 기기를 같이 빼낸다.
    //   이게 없으면 새 채널에 등록만 되고 옛 오염은 영원히 남아 원장 알림이 계속 간다.
    let 원장채널정리 = null;
    if (userId.startsWith('staff:')) {
      원장채널정리 = await pruneFromAdminChannel(env, sub.endpoint);
      if (원장채널정리) {
        await logAudit(env, request, {
          action: 'push.web.staff.unleak',
          target: '__admin__', targetName: describeDevice(ua),
          summary: '조교 기기를 원장 알림 채널에서 분리 [' + rawId + ' → ' + userId + '] · ' + describeDevice(ua),
          detail: {
            빼낸채널: '__admin__(원장 알림)', 옮긴채널: userId,
            빼낸기기: 원장채널정리,
            사유: '조교 로그인이 원장과 같은 저장키(kwmath_admin_pw)를 써서 원장 채널에 등록돼 있었음',
            효과: '이 기기는 이제 원장 전용 알림(문의·질문·생활기록 등)을 받지 않는다',
          },
        });
      }
    }

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
        예약id여부: isReservedUserId(userId) ? '시스템 id(__ 또는 staff: 로 시작) — 관리자/조교 인증 통과함' : '일반 사용자',
        요청id: rawId,
        치환여부: rawId === userId ? '없음' : ('조교 세션 → ' + rawId + ' 를 ' + userId + ' 로 치환'),
        원장채널정리,
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

  const rawId = String(body.userId || '').trim();
  const userId = resolveUserId(rawId, request);   // 조교의 __admin__ → staff:{전화번호}
  const endpoint = String(body.endpoint || '').trim();

  if (!rawId)
    return Response.json({ error: 'userId 필수' }, { status: 400 });
  const guard = reservedGuard(userId, request, env);
  if (guard) return guard;

  // 🔴 2026-09-08 — 조교가 이 기기를 끊을 때, 옛 오염(원장 채널에 박힌 같은 기기)도 같이 뺀다.
  //   endpoint 를 준 경우에만 한다. 안 주면 "이 계정 전체 해제"인데, __admin__ 을 통째로 비우면
  //   관우T 본인 기기까지 날아간다. 조교 기기만 골라낼 방법이 endpoint 말고는 없다.
  if (userId.startsWith('staff:') && endpoint) {
    const 정리 = await pruneFromAdminChannel(env, endpoint);
    if (정리) {
      await logAudit(env, request, {
        action: 'push.web.staff.unleak',
        target: '__admin__', targetName: (정리 && 정리.기기) || '',
        summary: '조교 기기를 원장 알림 채널에서 분리(해제 경로) [' + rawId + ' → ' + userId + ']',
        detail: { 빼낸채널: '__admin__(원장 알림)', 빼낸기기: 정리, 경로: '구독 해제(로그아웃 등)' },
      });
    }
  }

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
        예약id여부: isReservedUserId(userId) ? '시스템 id(__ 또는 staff: 로 시작) — 관리자/조교 인증 통과함' : '일반 사용자',
        요청id: rawId,
        치환여부: rawId === userId ? '없음' : ('조교 세션 → ' + rawId + ' 를 ' + userId + ' 로 치환'),
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
