import { safeError } from './_errors.js';
import { logAuditMany, actorOf, describeDevice } from './_auditlog.js';
// /api/push-register-fcm
// 안드로이드 네이티브 앱(Capacitor)에서 받은 FCM 디바이스 토큰 저장/해제.
// portal/admin-qna 페이지가 결정한 userId(휴대폰 등) 기준으로 묶음.
// 한 사용자 = 여러 기기 가능 (token으로 중복 제거, 최근 20개만 유지).
//
// POST   — 토큰 등록 (Body: { userId, token, via? })   via='ensure' → 화면 진입 시 자동 보충
// DELETE — 토큰 해제 (Body: { userId, token?, reason? }) token 없으면 전체 해제
//
// 📓 2026-07-31 — 여기서 일어나는 모든 일을 audit_log 에 남긴다 (관우T 지시: "로그가 정말 중요해").
//   예전에는 fcm-tokens/{id}.json 이 "지금 붙어 있는 기기"만 들고 있어서,
//   붙었다 떨어졌다 다시 붙은 이력이 통째로 사라졌다(실제로 김서율 학부모 폰 추적 때 막혔다).
//   이제 한 번의 등록이 만들어내는 사건을 쪼개서 각각 남긴다:
//     push.token.new      새 기기가 이 계정에 붙음
//     push.token.refresh  이미 붙어 있던 같은 기기가 토큰 재확인 (via로 자동/수동 구분)
//     push.token.moved    같은 폰이 물려 있던 다른 계정에서 회수 (뺀 계정·뺀 기기정보 포함)
//     push.token.trim     계정당 20기기 상한에 밀려 조용히 사라지던 것 — 이제 남긴다
//     push.token.remove   해제 (해제 전 기기명·UA·등록시각을 같이 남긴다)
//     push.token.remove.miss  이미 없는 것을 해제 요청 (변화 없음)
//
// 저장: R2 key = fcm-tokens/{userId}.json
// 구조: { userId, tokens: [ { token, ua, savedAt } ], updatedAt }
//
// 🔒 1기기 = 1계정 (2026-07-31 신설)
//   등록할 때 "이 토큰(=이 폰)이 물려 있던 다른 계정"에서 자동으로 뺀다.
//   이게 없으면 학생이 선생님 폰으로 한 번 로그인한 흔적이 영원히 남아,
//   그 학생에게 보낸 알림이 선생님 폰까지 울린다(2026-07-31 실제 발생).
//   역인덱스 fcm-owner/{sha256(token)}.json = { userId, updatedAt } 로 O(1) 유지.
//   인덱스가 없는 토큰(배포 전부터 있던 기기)은 그 첫 1회만 전수 스캔해서 정리한다.
//   ⚠️ 예약 id(__admin__ 등)는 양방향 예외 — 원장은 관리자 알림과 본인 포털 계정을
//      한 폰에서 같이 써야 하므로, 서로를 밀어내면 안 된다.

export async function onRequest({ request, env }) {
  if (request.method === 'POST')   return handleRegister(request, env);
  if (request.method === 'DELETE') return handleUnregister(request, env);
  return Response.json({ error: 'POST 또는 DELETE만 허용' }, { status: 405 });
}

// 예약(시스템) userId 보호 — push-subscribe.js와 동일 규약.
//   '__' 접두 id(__admin__ 등)는 관리자/조교 인증(Bearer ADMIN_PASSWORD, 미들웨어 번역)이 있을 때만 조작 허용.
//   학생 전화번호 id는 종전대로 무인증 허용.
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

// ───────── 1기기 = 1계정 헬퍼 ─────────
const TOKENS_PREFIX = 'fcm-tokens/';
const OWNER_PREFIX  = 'fcm-owner/';

async function ownerKey(token) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${OWNER_PREFIX}${hex}.json`;
}

function uidFromTokensKey(key) {
  try { return decodeURIComponent(key.slice(TOKENS_PREFIX.length, -'.json'.length)); }
  catch { return ''; }
}

// ───────── 로그용 토큰 지문 ─────────
// 로그에 토큰 원문은 넣지 않는다.
//   ① audit_log 는 D1 → R2 백업으로 흘러간다. 2026-07-31 그 백업이 무인증으로 통째 열려 있던 사고가 있었다.
//      로그가 사고 시 피해를 키우는 물건이 되면 안 된다.
//   ② 추적에 정말 필요한 건 "같은 폰인가/다른 폰인가"이지 토큰 값 자체가 아니다.
//      해시가 같으면 같은 기기(계정이 달라도 대조된다), 꼬리 12자는 사람이 눈으로 맞춰볼 때 쓴다.
async function tokenFp(token) {
  const t = String(token || '');
  let hash = '';
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    hash = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch (_) {}
  return { 토큰지문: hash, 토큰꼬리: t.slice(-12), 토큰길이: t.length };
}

// 저장돼 있던 토큰 항목 1개 → 로그에 남길 형태(무슨 폰이 언제 붙어 있었나).
async function entryInfo(e) {
  if (!e) return null;
  const fp = await tokenFp(e.token);
  return Object.assign({ 기기: describeDevice(e.ua || '') || '', ua: e.ua || '', 등록시각: e.savedAt || '' }, fp);
}

// 특정 userId의 기록에서 토큰 1개만 뺀다. 남는 게 없으면 키 자체를 지움.
// 반환: { entry: 뺀 항목 원본, remaining: 남은 개수 } · 뺄 게 없으면 null.
//   ⚠️ 예전엔 true/false만 돌려줬다. 그러면 "무엇을 지웠는지"가 그 자리에서 증발해
//      로그에 지우기 전 값(before)을 남길 수가 없다. 지우는 일에는 before를 반드시 남긴다.
async function removeTokenFrom(env, uid, token) {
  const k = `${TOKENS_PREFIX}${encodeURIComponent(uid)}.json`;
  const obj = await env.BUCKET.get(k);
  if (!obj) return null;
  let rec;
  try { rec = JSON.parse(await obj.text()); } catch { return null; }
  if (!rec || !Array.isArray(rec.tokens)) return null;
  const hit = rec.tokens.find(t => t && t.token === token) || null;
  if (!hit) return null;
  rec.tokens = rec.tokens.filter(t => t && t.token !== token);
  rec.userId = uid;
  rec.updatedAt = new Date().toISOString();
  if (rec.tokens.length === 0) await env.BUCKET.delete(k);
  else await env.BUCKET.put(k, JSON.stringify(rec), { httpMetadata: { contentType: 'application/json' } });
  return { entry: hit, remaining: rec.tokens.length };
}

// 역인덱스에 없는(=배포 전부터 있던) 토큰만 전수 스캔으로 정리. 기기당 최초 1회만 돈다.
async function legacySweep(env, keepUid, token) {
  const moved = [];
  const listed = await env.BUCKET.list({ prefix: TOKENS_PREFIX, limit: 1000 });
  for (const o of (listed.objects || [])) {
    const uid = uidFromTokensKey(o.key);
    if (!uid || uid === keepUid || isReservedUserId(uid)) continue;   // 예약 id는 건드리지 않음
    try {
      const r = await removeTokenFrom(env, uid, token);
      if (r) moved.push({ uid, entry: r.entry, remaining: r.remaining, 경로: '전수스캔' });
    } catch {}
  }
  return moved;
}

// 등록 직전에 호출. 실패해도 등록 자체는 절대 막지 않는다(best-effort).
// 반환: [{ uid, entry, remaining, 경로 }] — 이 폰을 빼앗아 온 계정들. 로그에 그대로 쓴다.
async function claimDeviceForUser(env, userId, token) {
  if (isReservedUserId(userId)) return [];   // __admin__ 등록은 다른 계정을 밀어내지 않음
  const okey = await ownerKey(token);
  let prevUid = '';
  let hadIndex = false;
  try {
    const o = await env.BUCKET.get(okey);
    if (o) { hadIndex = true; prevUid = String((JSON.parse(await o.text()) || {}).userId || ''); }
  } catch {}

  let moved = [];
  if (hadIndex) {
    if (prevUid && prevUid !== userId && !isReservedUserId(prevUid)) {
      const r = await removeTokenFrom(env, prevUid, token);
      if (r) moved.push({ uid: prevUid, entry: r.entry, remaining: r.remaining, 경로: '역인덱스' });
    }
  } else {
    moved = await legacySweep(env, userId, token);
  }

  await env.BUCKET.put(okey, JSON.stringify({ userId, updatedAt: new Date().toISOString() }), {
    httpMetadata: { contentType: 'application/json' },
  });
  return moved;
}

// ───────── POST: 토큰 등록 ─────────
async function handleRegister(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}

  const userId = String(body.userId || '').trim();
  const token  = String(body.token  || '').trim();
  const via    = String(body.via    || '').trim().slice(0, 20);   // 'ensure' = 로그인 후 자동 보충, 빈값 = 사용자가 직접

  if (!userId) return Response.json({ error: 'userId 필수' }, { status: 400 });
  const guard = reservedGuard(userId, request, env);
  if (guard) return guard;
  if (!token)  return Response.json({ error: 'token 필수' }, { status: 400 });

  const key = `${TOKENS_PREFIX}${encodeURIComponent(userId)}.json`;
  const ua = request.headers.get('user-agent') || '';

  // 🔒 1기기 = 1계정 — 이 폰이 물려 있던 다른 계정에서 먼저 뺀다(실패해도 등록은 진행).
  let movedFrom = [];
  try { movedFrom = await claimDeviceForUser(env, userId, token); } catch (_) {}

  // 기존 토큰 로드 (있으면)
  let record = { userId, tokens: [], updatedAt: '' };
  try {
    const existing = await env.BUCKET.get(key);
    if (existing) {
      const parsed = JSON.parse(await existing.text());
      if (parsed && Array.isArray(parsed.tokens)) record = parsed;
    }
  } catch {}

  // token 기준 중복 제거 후 추가, 최근 20개만 유지
  const prev = record.tokens.find(t => t && t.token === token) || null;   // 이미 붙어 있던 같은 폰인가?
  const filtered = record.tokens.filter(t => t && t.token !== token);
  filtered.push({ token, ua, savedAt: new Date().toISOString() });
  // 20개 상한에 밀려 사라지는 것들 — 예전엔 slice(-20) 한 줄로 소리 없이 증발했다. 이제 붙들어서 로그에 남긴다.
  const overflow = filtered.slice(0, Math.max(0, filtered.length - 20));
  record.tokens = filtered.slice(-20);
  record.userId = userId;
  record.updatedAt = new Date().toISOString();

  try {
    await env.BUCKET.put(key, JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' }
    });
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }

  // 저장이 끝난 뒤에 남긴다. 로깅은 절대 본 작업을 막지 않는다.
  await logRegister(env, request, { userId, token, ua, via, prev, movedFrom, overflow, count: record.tokens.length });

  return Response.json({ ok: true, deviceCount: record.tokens.length, movedFrom: movedFrom.map(m => m.uid) });
}

// 등록 1회가 만들어낸 사건들을 쪼개서 각각 남긴다.
//   폰을 바꿔 끼우거나 형제가 한 폰을 같이 쓰면 등록 한 번이 계정 여러 개를 건드린다.
//   그걸 한 줄로 뭉뚱그리면 나중에 "왜 이 폰에 저 애 알림이 갔나"를 되짚을 수 없다.
async function logRegister(env, request, x) {
  try {
    const fp = await tokenFp(x.token);
    const 기기 = describeDevice(x.ua) || '';
    const 경위 = x.via || '직접';
    const who = actorOf(request, env, isReservedUserId(x.userId) ? {} : { actor: x.userId, actorRole: 'student-or-parent' });
    const base = { actor: who.actor, actorRole: who.actorRole, target: x.userId };
    const events = [];

    if (x.prev) {
      events.push(Object.assign({}, base, {
        action: 'push.token.refresh',
        summary: `${기기} 토큰 재확인 (${경위})`,
        detail: Object.assign({ 기기, ua: x.ua, 경위, 기기수: x.count, 이전등록시각: x.prev.savedAt || '', 이전UA: x.prev.ua || '' }, fp),
      }));
    } else {
      events.push(Object.assign({}, base, {
        action: 'push.token.new',
        summary: `${기기} 알림 등록 (${경위})`,
        detail: Object.assign({ 기기, ua: x.ua, 경위, 기기수: x.count }, fp),
      }));
    }

    for (const m of (x.movedFrom || [])) {
      events.push(Object.assign({}, base, {
        action: 'push.token.moved',
        target: m.uid,                                   // 검색은 "뺏긴 쪽" 기준으로 걸리게 한다
        summary: `${기기} 를 ${m.uid} 에서 회수 → ${x.userId}`,
        detail: { 뺀계정: m.uid, 준계정: x.userId, 경로: m.경로, 뺀계정남은기기수: m.remaining, 회수전등록: await entryInfo(m.entry), 기기 },
      }));
    }

    for (const o of (x.overflow || [])) {
      const info = await entryInfo(o);
      events.push(Object.assign({}, base, {
        action: 'push.token.trim',
        summary: `기기 20개 초과 — 가장 오래된 기기 제거 (${(info && info.기기) || '?'})`,
        detail: { 제거됨: info, 이유: '계정당 최근 20기기만 유지', 남은기기수: x.count },
      }));
    }

    await logAuditMany(env, request, events);
  } catch (_) { /* 로깅 실패는 조용히 넘어간다 */ }
}

// ───────── DELETE: 토큰 해제 ─────────
// body: { userId, token?, reason? }
//   token 명시 → 그 기기 1개만 해제
//   token 없음 → 해당 userId의 모든 기기 해제 (계정 삭제·로그아웃용)
//   reason    → 로그에 그대로 적힌다('로그아웃' 등). 안 보내면 '미지정'.
async function handleUnregister(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}

  const userId = String(body.userId || '').trim();
  const token  = String(body.token  || '').trim();
  const reason = String(body.reason || '').trim().slice(0, 40);   // 'logout' 등 — 왜 뺐는지

  if (!userId) return Response.json({ error: 'userId 필수' }, { status: 400 });
  const guard = reservedGuard(userId, request, env);
  if (guard) return guard;

  const key = `${TOKENS_PREFIX}${encodeURIComponent(userId)}.json`;

  try {
    const existing = await env.BUCKET.get(key);
    if (!existing) {
      // 변화가 없어도 "해제 시도가 있었다"는 사실은 남긴다 — 알림 안 온다는 문의를 되짚을 때 이 빈칸이 단서다.
      await logUnregister(env, request, { userId, token, reason, droppedEntries: [], removed: 0, before: 0, remaining: 0, all: !token });
      return Response.json({ ok: true, removed: 0, remaining: 0 });  // idempotent
    }
    let record = JSON.parse(await existing.text());
    if (!record || !Array.isArray(record.tokens)) record = { userId, tokens: [] };

    const before = record.tokens.length;
    // 🔴 지우기 전 항목 자체를 붙든다. 아래 filter가 돌고 나면 "무슨 폰이 언제부터 붙어 있었는지"가 사라진다.
    const droppedEntries = token ? record.tokens.filter(t => t && t.token === token) : record.tokens.filter(Boolean);
    const dropped = token ? [token] : record.tokens.map(t => t && t.token).filter(Boolean);
    record.tokens = token ? record.tokens.filter(t => t && t.token !== token) : [];
    const removed = before - record.tokens.length;
    record.userId = userId;
    record.updatedAt = new Date().toISOString();

    // 역인덱스도 같이 정리 — 이 계정이 소유자로 적혀 있을 때만 지운다(다른 계정 소유권은 보존).
    for (const tk of dropped) {
      try {
        const okey = await ownerKey(tk);
        const o = await env.BUCKET.get(okey);
        if (o && String((JSON.parse(await o.text()) || {}).userId || '') === userId) {
          await env.BUCKET.delete(okey);
        }
      } catch (_) {}
    }

    if (record.tokens.length === 0) {
      await env.BUCKET.delete(key);
    } else {
      await env.BUCKET.put(key, JSON.stringify(record), {
        httpMetadata: { contentType: 'application/json' }
      });
    }
    await logUnregister(env, request, { userId, token, reason, droppedEntries, removed, before, remaining: record.tokens.length, all: !token });
    return Response.json({ ok: true, removed, remaining: record.tokens.length });
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}

// 해제된 기기 하나하나를 "해제 전 값"과 함께 남긴다.
//   해제는 되돌릴 수 없다. 무엇이 있었는지를 지우기 전에 적어두지 않으면 영원히 모른다.
async function logUnregister(env, request, x) {
  try {
    const who = actorOf(request, env, isReservedUserId(x.userId) ? {} : { actor: x.userId, actorRole: 'student-or-parent' });
    const base = { actor: who.actor, actorRole: who.actorRole, target: x.userId };
    const 이유 = x.reason || '미지정';
    const events = [];

    for (const e of (x.droppedEntries || [])) {
      const info = await entryInfo(e);
      events.push(Object.assign({}, base, {
        action: 'push.token.remove',
        summary: `${(info && info.기기) || '기기'} 알림 해제 (${이유})`,
        detail: { 해제된기기: info, 이유, 전체해제: !!x.all, 해제전기기수: x.before, 남은기기수: x.remaining },
      }));
    }

    if (!events.length) {
      events.push(Object.assign({}, base, {
        action: 'push.token.remove.miss',
        summary: `해제 요청했지만 등록된 게 없었음 (${이유})`,
        detail: { 이유, 전체해제: !!x.all, 요청토큰꼬리: String(x.token || '').slice(-12), 해제전기기수: x.before, 남은기기수: x.remaining },
      }));
    }

    await logAuditMany(env, request, events);
  } catch (_) { /* 로깅 실패는 조용히 넘어간다 */ }
}
