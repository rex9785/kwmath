// POST /api/push-send
// admin 인증 후 특정 사용자(들)에게 Web Push 발송.
// 표준: RFC 8291 (aes128gcm) + RFC 8292 (VAPID JWT, ES256)
// 의존성 없이 Cloudflare Pages Functions의 Web Crypto API로 구현.
//
// 환경변수 필요 (Cloudflare):
//   ADMIN_PASSWORD      — 기존
//   VAPID_PUBLIC_KEY    — base64url, raw P-256 공개키 65바이트 (앞 0x04)
//   VAPID_PRIVATE_KEY   — base64url, raw P-256 사설키 32바이트
//   VAPID_SUBJECT       — "mailto:rex9785@gmail.com" 또는 사이트 URL
//
// Body: {
//   password: string,         // admin
//   userId | userIds,         // 단일 또는 배열
//   title: string,            // 알림 제목
//   body: string,             // 본문
//   url?: string,             // 클릭 시 이동 (기본 /portal)
//   tag?: string,             // 동일 tag 알림은 덮어씀
//   image?: string            // (선택) 알림 이미지
// }

import { isKstQuietHours, enqueueNightPush } from './_push.js';
import { logAudit, actorOf, describeDevice } from './_auditlog.js';

// 📓 2026-07-31 — 관우T 지시("아주 사소한 거 하나까지도 로그에 다 남겨") 반영.
//   여기는 **수동 푸시 발송구**인데, 그동안 "누구에게 · 무엇을 보냈는지"가 어디에도 안 남았다.
//   R2 push-subs 는 '지금 구독 중'이라는 현재 상태만 들고 있어서, 알림이 엉뚱한 학원에 간 뒤
//   그 알림을 실제로 받은 사람 명단을 사후에 재구성할 방법이 전혀 없었다(2026-07-31 실제 사고).
//   → 성공·부분실패·전멸은 물론 **안 보낸 경우(대상 0명 · 구독 0건 · 야간 무음)** 까지 전부 남긴다.
//     "안 보냈다"가 안 남으면 "왜 안 왔지?"라는 질문에 영영 답할 수 없기 때문이다.
//
// ⚠️ 로그에 절대 넣지 않는 것: 구독 키(p256dh·auth), VAPID 사설키, 관리자 비밀번호.
//   endpoint 도 통째로 남기면 그 자체가 "그 폰에 알림을 쏠 수 있는 열쇠"가 된다
//   → 어느 푸시서버(호스트)인지 + 앞부분만 남긴다.
function pushHost(ep) { try { return new URL(String(ep)).host; } catch (_) { return ''; } }
function epBrief(ep) { const s = String(ep || ''); return s.slice(0, 40) + (s.length > 40 ? '…' : ''); }

export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  let body = {};
  try { body = await request.json(); } catch {}

  // 인증: 둘 중 하나면 통과
  //   (1) Authorization: Bearer <ADMIN_PASSWORD>  — _middleware가 원장 세션토큰(adm_)을 번역해 줌 (admin 페이지 표준 경로)
  //   (2) body.password === ADMIN_PASSWORD        — 서버 내부 호출(notices-write 등)·레거시 호환
  const authz = request.headers.get('Authorization') || '';
  const bearerOk = !!env.ADMIN_PASSWORD && authz === 'Bearer ' + env.ADMIN_PASSWORD;
  const bodyOk   = !!env.ADMIN_PASSWORD && (body.password || '') === env.ADMIN_PASSWORD;
  if (!bearerOk && !bodyOk) {
    // 🔴 2026-07-31 — 인증 없이 푸시를 쏘려던 시도. 예전엔 401만 돌려주고 흔적이 하나도 안 남아서
    //   "우리 학부모 폰에 누가 알림을 보내려 했나"를 나중에 확인할 방법이 아예 없었다.
    //   비밀번호 값 자체는 절대 안 남긴다 — 있었는지 없었는지만 남긴다.
    await logAudit(env, request, {
      action: 'push.send.denied',
      target: 'push-send',
      summary: '푸시 발송 시도 차단 — 인증 실패(관리자 비밀번호·세션 없음)',
      detail: {
        시도한제목: String(body.title || '').slice(0, 120),
        시도한내용: String(body.body || '').slice(0, 200),
        시도한대상수: Array.isArray(body.userIds) ? body.userIds.length : (body.userId ? 1 : 0),
        헤더인증: authz ? 'Authorization 헤더 있음(값 불일치)' : 'Authorization 헤더 없음',
        본문비번: body.password ? '본문 password 있음(값 불일치)' : '본문 password 없음',
        결과: '한 통도 안 나감(401)',
      },
    });
    return Response.json({ error: '인증 실패' }, { status: 401 });
  }

  // 📓 2026-07-31 — "누가 쐈나". 원장·조교 세션은 미들웨어가 심어 준 헤더로 actorOf 가 사람을 특정한다.
  //   본문 password 로 들어오는 건 서버 내부 호출(공지 flush·리포트 업로드)이라 사람이 아니다 → 'system'으로 못 박는다.
  //   이 구분이 없으면 조교가 손으로 보낸 알림과 크론이 보낸 알림이 로그에서 똑같이 보인다.
  const 발신자 = (() => {
    const w = actorOf(request, env);
    return w.actor ? w : { actor: 'system', actorRole: 'system', actorName: '서버 내부 호출(본문 password)' };
  })();

  const vapidPub  = env.VAPID_PUBLIC_KEY  || '';
  const vapidPriv = env.VAPID_PRIVATE_KEY || '';
  const subject   = env.VAPID_SUBJECT     || 'mailto:rex9785@gmail.com';
  if (!vapidPub || !vapidPriv) {
    // 🔴 2026-07-31 — 키가 없어서 한 통도 못 나간 경우. 호출부는 503만 받고 조용히 지나가므로
    //   이 로그가 없으면 "공지 보냈는데 아무도 못 받았다"의 원인이 환경변수 누락이었다는 걸 알 길이 없다.
    const 대상 = Array.isArray(body.userIds) ? body.userIds : (body.userId ? [body.userId] : []);
    await logAudit(env, request, {
      action: 'push.send.failed',
      actor: 발신자.actor, actorRole: 발신자.actorRole, actorName: 발신자.actorName,
      target: 대상.length === 1 ? String(대상[0]) : String(body.tag || 'push-send'),
      summary: '웹푸시 발송 실패 — 서버에 VAPID 키가 없음. 대상 ' + 대상.length + '명 전원 미수신',
      detail: {
        사유: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 환경변수 미설정',
        제목: String(body.title || '').slice(0, 120),
        내용: String(body.body || '').slice(0, 200),
        요청대상수: 대상.length,
        요청대상: 대상.slice(0, 300).map(String),
        요청대상잘림: 대상.length > 300,
        결과: '한 통도 안 나감(503) — Cloudflare 환경변수부터 확인해야 한다',
      },
    });
    return Response.json({ error: 'VAPID 키 미설정' }, { status: 503 });
  }

  const userIds = Array.isArray(body.userIds) ? body.userIds : (body.userId ? [body.userId] : []);
  // 🔎 2026-07-31 — 바로 아래 야간무음 분기가 userIds 를 splice 로 **제자리에서 깎는다**.
  //   원본을 먼저 떠 두지 않으면 로그의 '요청 대상'이 이미 걸러진 뒤 명단이 되어
  //   "누구에게 보내려던 알림이었나"가 통째로 사라진다.
  const 요청대상 = userIds.map(String);
  // 대상을 어떻게 골랐는지 = 오배송 조사의 출발점. 인증 경로까지 함께 남긴다.
  const 발송맥락 = {
    인증방식: bearerOk ? 'Authorization Bearer(원장·조교 세션 번역 포함)' : '본문 password(서버 내부 호출)',
    대상지정: Array.isArray(body.userIds) ? 'userIds 배열로 지정' : (body.userId ? 'userId 하나로 지정' : '지정 없음'),
    요청대상수: 요청대상.length,
    요청대상: 요청대상.slice(0, 300),
    요청대상잘림: 요청대상.length > 300,
    야간무음: body.nightSilent === true ? '이 요청 전원'
      : (Array.isArray(body.nightSilent) ? body.nightSilent.length + '명 지정'
        : (body.nightSilent ? '1명 지정' : '없음')),
    야간큐사용: !!body.queueIfNight,
    야간큐분류: String(body.queueTag || ''),
  };
  if (!userIds.length) {
    // 📓 2026-07-31 — "보낼 대상 0명"도 사건이다. 호출부(공지·리포트)가 대상 계산을 잘못해
    //   빈 명단을 보내면 아무 일도 안 일어나는데, 예전엔 그 사실조차 안 남아서
    //   "공지 눌렀는데 아무도 못 받았다"의 원인을 여기서 끊어진 건지 확인할 수 없었다.
    await logAudit(env, request, {
      action: 'push.send.skipped',
      actor: 발신자.actor, actorRole: 발신자.actorRole, actorName: 발신자.actorName,
      target: String(body.tag || 'push-send'),
      summary: '웹푸시 발송 안 함 — 받을 사람이 0명(userId·userIds 둘 다 비어 있음)',
      detail: {
        ...발송맥락,
        제목: String(body.title || '').slice(0, 120),
        내용: String(body.body || '').slice(0, 200),
        사유: '호출부가 대상 명단을 빈 채로 보냄 — 대상 계산(학원·반 필터) 쪽을 봐야 한다',
        결과: '한 통도 안 나감(400)',
      },
    });
    return Response.json({ error: 'userId 또는 userIds 필요' }, { status: 400 });
  }

  // 밤(KST 23:00~07:00) 무음 — 학부모 대상 호출(reports-write 등)이 body.nightSilent로 옵트인.
  //   true=이 호출 전원 건너뜀 / [id…]=그 id만 제외. 미지정이면 기존대로 항상 발송(학생·원장 등).
  //   body.queueIfNight=true 면 드롭 대신 야간 큐에 쌓아 아침 07시~ 발송(리포트 업로드 경로).
  if (body.nightSilent && isKstQuietHours()) {
    const nightMsg = { title: body.title || '이관우 수학연구소', body: body.body || '', url: body.url || '/portal', tag: body.tag || 'kwmath' };
    if (body.nightSilent === true) {
      let queued = 0;
      if (body.queueIfNight) { const q = await enqueueNightPush(env, userIds, nightMsg, body.queueTag || 'report'); queued = (q && q.queued) || 0; }
      // 📓 2026-07-31 — 밤에 조용히 사라진 알림이 가장 추적이 안 됐다. 학부모가 "리포트 알림 못 받았어요"
      //   해도 발송 기록도 실패 기록도 없어서, 안 보낸 건지 못 받은 건지 구분이 안 됐다.
      //   → 안 보낸 것도 사건으로 남긴다(_push.js 와 같은 action 이름).
      await logAudit(env, request, {
        action: queued ? 'push.night.queued' : 'push.night.dropped',
        actor: 발신자.actor, actorRole: 발신자.actorRole, actorName: 발신자.actorName,
        target: 요청대상.length === 1 ? 요청대상[0] : String(body.queueTag || nightMsg.tag || ''),
        summary: '밤(23~7시) 학부모 무음 — 「' + nightMsg.title + '」 ' + 요청대상.length + '명 '
          + (queued ? '아침 발송으로 예약' : '발송 안 함(드롭)'),
        detail: {
          ...발송맥락,
          제목: nightMsg.title,
          내용: String(nightMsg.body || '').slice(0, 200),
          링크: nightMsg.url, 태그: nightMsg.tag,
          무음대상: '요청 대상 전원(위 요청대상과 동일)',
          예약건수: queued,
          결과: queued
            ? '이 시각엔 아무도 못 받음 — 아침 07시 이후 크론(notices-flush)이 큐를 풀어 발송한다'
            : '이 시각에 드롭 — 다시 보내지 않는다(예약 안 함)',
        },
      });
      return Response.json({ ok: true, sent: 0, skipped: userIds.length, queued, note: queued ? 'quiet-hours→queued(parent)' : 'quiet-hours(parent)' });
    }
    const silent = new Set((Array.isArray(body.nightSilent) ? body.nightSilent : [body.nightSilent]).map(String));
    const silencedIds = userIds.filter(id => silent.has(String(id)));
    for (let i = userIds.length - 1; i >= 0; i--) if (silent.has(String(userIds[i]))) userIds.splice(i, 1);
    let queued = 0;
    if (body.queueIfNight && silencedIds.length) { const q = await enqueueNightPush(env, silencedIds, nightMsg, body.queueTag || 'report'); queued = (q && q.queued) || 0; }
    // 📓 2026-07-31 — 같은 알림이 학생에겐 가고 학부모에겐 안 간 경우. 예전엔 "일부만 갔다"는
    //   사실 자체가 안 남아서, 학부모 문의가 오면 발송 자체를 안 한 것처럼 보였다.
    //   → 누가 무음으로 빠졌고 누구에겐 그대로 나갔는지를 한 줄에 같이 남긴다.
    if (silencedIds.length) {
      await logAudit(env, request, {
        action: queued ? 'push.night.queued' : 'push.night.dropped',
        actor: 발신자.actor, actorRole: 발신자.actorRole, actorName: 발신자.actorName,
        target: String(body.queueTag || nightMsg.tag || ''),
        summary: '밤(23~7시) 학부모 무음 — 「' + nightMsg.title + '」 ' + silencedIds.length + '명 '
          + (queued ? '아침 발송으로 예약' : '발송 안 함(드롭)') + ' · 나머지 ' + userIds.length + '명은 즉시 발송',
        detail: {
          ...발송맥락,
          제목: nightMsg.title,
          내용: String(nightMsg.body || '').slice(0, 200),
          링크: nightMsg.url, 태그: nightMsg.tag,
          무음대상: silencedIds.slice(0, 300).map(String),
          무음대상잘림: silencedIds.length > 300,
          즉시발송대상: userIds.slice(0, 300).map(String),
          즉시발송대상잘림: userIds.length > 300,
          예약건수: queued,
          결과: userIds.length
            ? '학생·원장 등 나머지에게는 지금 나간다(아래 push.send 로그로 이어짐)'
            : '남은 대상이 0명 — 이 요청으로 지금 알림을 받은 사람은 없다',
        },
      });
    }
    if (!userIds.length)
      return Response.json({ ok: true, sent: 0, skipped: silent.size, queued, note: queued ? 'quiet-hours→queued(parent)' : 'quiet-hours(parent)' });
  }

  const payload = {
    title: body.title || '이관우 수학연구소',
    body:  body.body  || '',
    url:   body.url   || '/portal',
    tag:   body.tag   || 'kwmath',
    image: body.image || undefined
  };

  // 사용자별 구독 정보 R2에서 로드
  const allSubs = [];
  for (const uid of userIds) {
    try {
      const obj = await env.BUCKET.get(`push-subs/${encodeURIComponent(uid)}.json`);
      if (!obj) continue;
      const rec = JSON.parse(await obj.text());
      for (const s of (rec.subs || [])) allSubs.push({ uid, sub: s });
    } catch {}
  }
  if (!allSubs.length) {
    // 📓 2026-07-31 — 대상은 있는데 그 사람들 계정에 등록된 웹푸시 구독이 한 대도 없는 경우.
    //   호출부는 ok:true 를 받아 "보냈다"고 착각한다. 실제로는 아무 폰도 안 울렸다.
    //   이 로그가 "보냈는데 왜 안 왔지"의 답(=애초에 받을 기기가 없었다)을 준다.
    await logAudit(env, request, {
      action: 'push.send.skipped',
      actor: 발신자.actor, actorRole: 발신자.actorRole, actorName: 발신자.actorName,
      target: userIds.length === 1 ? String(userIds[0]) : String(payload.tag || 'push-send'),
      summary: '웹푸시 발송 안 함 — 「' + payload.title + '」 대상 ' + userIds.length + '명 중 등록된 구독 기기 0대',
      detail: {
        ...발송맥락,
        제목: payload.title,
        내용: String(payload.body || '').slice(0, 200),
        링크: payload.url, 태그: payload.tag,
        실제발송대상: userIds.slice(0, 300).map(String),
        실제발송대상잘림: userIds.length > 300,
        사유: 'R2 push-subs/{대상}.json 이 없거나 subs 가 비어 있음 — 구독한 적 없거나 전부 해제·만료됨',
        결과: '한 통도 안 나감(호출부에는 ok:true 로 응답)',
        점검힌트: '앱(안드로이드) 사용자는 웹푸시 구독이 아니라 FCM 토큰만 갖고 있다. '
          + '이 엔드포인트는 웹푸시 전용이라 앱 사용자에겐 원래 안 간다 — 앱 알림은 _push.js sendPushToUsers 경로.',
      },
    });
    return Response.json({ ok: true, sent: 0, fails: 0, note: '구독자 없음' });
  }

  // 발송 (병렬, 실패해도 다른 건 계속)
  const results = await Promise.allSettled(
    allSubs.map(({ sub }) => sendWebPush(sub, payload, vapidPub, vapidPriv, subject))
  );

  let sent = 0, fails = 0, gone = [];
  // 🔎 2026-07-31 — 기기 단위 결과를 모은다. "몇 명에게 보냈다"만으로는 부족하다 —
  //   어느 폰이 몇 번 코드로 튕겼는지가 있어야 "이 학부모는 왜 못 받았나"에 답할 수 있다.
  //   detail 20000자 상한이 있어 40대까지만 담고 넘치면 잘림 표시를 단다.
  const 기기별 = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const 대상기기 = allSubs[i] || {};
    const 구독 = 대상기기.sub || {};
    const 행 = {
      계정: String(대상기기.uid == null ? '' : 대상기기.uid),
      기기: describeDevice(구독.ua || '') || '',
      푸시서버: pushHost(구독.endpoint),
    };
    if (r.status === 'fulfilled' && r.value.ok) {
      sent++;
      행.결과 = '성공';
    } else {
      fails++;
      // 410 Gone / 404 = 구독 만료. 정리 대상으로 표시.
      const status = r.status === 'fulfilled' ? r.value.status : 0;
      행.결과 = '실패';
      행.상태코드 = status;
      행.endpoint앞부분 = epBrief(구독.endpoint);   // 실패한 기기만 — 어느 구독인지 대조용
      if (r.status === 'rejected') {
        행.사유 = String((r.reason && r.reason.message) || r.reason || '').slice(0, 80);
      } else if (status === 410 || status === 404) {
        행.사유 = '구독 만료(' + status + ') — 앱 삭제·기기 초기화·브라우저 데이터 삭제. 아래에서 자동 정리됨';
      }
      if (status === 410 || status === 404) {
        gone.push(allSubs[i]);
      }
    }
    if (기기별.length < 40) 기기별.push(행);
  }

  // 만료된 구독 자동 정리
  if (gone.length) {
    const byUser = {};
    for (const g of gone) {
      (byUser[g.uid] = byUser[g.uid] || []).push(g.sub.endpoint);
    }
    for (const [uid, eps] of Object.entries(byUser)) {
      try {
        const key = `push-subs/${encodeURIComponent(uid)}.json`;
        const obj = await env.BUCKET.get(key);
        if (!obj) continue;
        const rec = JSON.parse(await obj.text());
        // 🔎 2026-07-31 — 바로 아랫줄이 rec.subs 를 통째로 갈아치운다. 지우기 전 목록을 먼저 떠 두지 않으면
        //   로그의 '전'과 '후'가 같은 걸 가리켜 무엇이 사라졌는지 알 수 없다(다른 API에서 실제로 당한 실수).
        const 정리전기기 = (rec.subs || []).map(s => ({
          기기: describeDevice((s && s.ua) || '') || '',
          등록시각: (s && s.savedAt) || '',
          푸시서버: pushHost(s && s.endpoint),
          endpoint앞부분: epBrief(s && s.endpoint),
          만료: eps.includes(s && s.endpoint),
        }));
        const 이전수정시각 = rec.updatedAt || '';
        rec.subs = (rec.subs || []).filter(s => !eps.includes(s.endpoint));
        rec.updatedAt = new Date().toISOString();
        if (rec.subs.length === 0) {
          await env.BUCKET.delete(key);
          // ⚠️ 2026-07-31 — 이 계정의 웹푸시 구독 파일이 통째로 사라진다(복구 불가).
          //   나중에 "왜 알림이 안 와요?" 문의가 오면, 사람이 해제한 건지 여기서 자동 정리된 건지를
          //   가릴 근거가 이 로그밖에 없다. 예전엔 조용히 지워져서 흔적이 0이었다.
          await logAudit(env, request, {
            action: 'push.web.expired.delete',
            actor: 발신자.actor, actorRole: 발신자.actorRole, actorName: 발신자.actorName,
            target: String(uid),
            targetName: (정리전기기[0] && 정리전기기[0].기기) || '',
            summary: '[' + uid + '] 만료된 웹푸시 구독 ' + eps.length + '건 자동 정리 — 남은 기기 0대 → 구독 파일 자체 삭제',
            detail: {
              사용자id: String(uid), R2키: key,
              계기: '「' + payload.title + '」 발송 중 410 Gone/404 응답(앱 삭제·기기 초기화·브라우저 데이터 삭제)',
              기기수: { 전: 정리전기기.length, 후: 0 },
              정리건수: eps.length,
              정리전기기: 정리전기기.slice(0, 20),
              정리전기기잘림: 정리전기기.length > 20,
              수정시각: { 전: 이전수정시각, 후: rec.updatedAt },
              효과: '이 계정은 이제 웹푸시 수신 기기가 0대 — 앱(FCM) 토큰마저 없으면 알림이 전혀 안 간다',
            },
          });
        } else {
          await env.BUCKET.put(key, JSON.stringify(rec), { httpMetadata:{ contentType:'application/json' } });
          // 📓 2026-07-31 — 죽은 기기만 골라내고 나머지는 남겼다. 어느 기기가 목록에서 빠졌는지 남긴다.
          //   (구독 목록은 최신 상태만 저장돼서, 이 기록이 없으면 "예전에 그 폰이 있었다"는 증거가 사라진다.)
          await logAudit(env, request, {
            action: 'push.web.expired.prune',
            actor: 발신자.actor, actorRole: 발신자.actorRole, actorName: 발신자.actorName,
            target: String(uid),
            targetName: (정리전기기.find(x => x.만료) || {}).기기 || '',
            summary: '[' + uid + '] 만료된 웹푸시 구독 ' + eps.length + '건 자동 정리 — 남은 기기 ' + rec.subs.length + '대',
            detail: {
              사용자id: String(uid), R2키: key,
              계기: '「' + payload.title + '」 발송 중 410 Gone/404 응답(앱 삭제·기기 초기화·브라우저 데이터 삭제)',
              기기수: { 전: 정리전기기.length, 후: rec.subs.length },
              정리건수: eps.length,
              정리전기기: 정리전기기.slice(0, 20),
              정리전기기잘림: 정리전기기.length > 20,
              남은기기: rec.subs.slice(0, 20).map(s => ({
                기기: describeDevice((s && s.ua) || '') || '',
                등록시각: (s && s.savedAt) || '',
                푸시서버: pushHost(s && s.endpoint),
              })),
              수정시각: { 전: 이전수정시각, 후: rec.updatedAt },
              효과: '만료된 기기만 알림이 끊긴다 — 남은 기기는 계속 받는다',
            },
          });
        }
      } catch {}
    }
  }

  // 📓 2026-07-31 — 발송 1건을 통째로 남긴다: 누가 · 누구에게 · 무엇을 · 몇 대에 도착했나.
  //   ★ 수신자 명단이 이 로그의 핵심이다. 2026-07-31 공지 오배송 때 "그 알림을 실제로 받은 사람"이
  //     어디에도 저장돼 있지 않아 끝내 재구성하지 못했다. 그 구멍을 여기서 막는다.
  await logAudit(env, request, {
    action: sent === 0 ? 'push.send.failed' : (fails ? 'push.send.partial' : 'push.send'),
    actor: 발신자.actor, actorRole: 발신자.actorRole, actorName: 발신자.actorName,
    target: userIds.length === 1 ? String(userIds[0]) : String(payload.tag || 'push-send'),
    summary: '「' + payload.title + '」 웹푸시 ' + userIds.length + '명 → 기기 ' + sent + '/' + allSubs.length + ' 도착'
      + (fails ? ' · 실패 ' + fails : '')
      + (gone.length ? ' · 만료구독 ' + gone.length + '건 정리' : ''),
    detail: {
      ...발송맥락,
      제목: payload.title,
      내용: String(payload.body || '').slice(0, 200),
      링크: payload.url, 태그: payload.tag, 이미지: payload.image || '(없음)',
      실제발송대상: 요청대상.length === userIds.length
        ? '요청대상과 동일(야간 무음으로 빠진 사람 없음)'
        : userIds.slice(0, 300).map(String),
      실제발송대상잘림: 요청대상.length !== userIds.length && userIds.length > 300,
      기기수: { 시도: allSubs.length, 성공: sent, 실패: fails },
      만료정리: gone.length,
      기기별,
      기기별잘림: allSubs.length > 기기별.length,
      결과: sent === 0
        ? '한 대도 도착 안 함 — 전부 실패'
        : (fails ? '일부 기기만 도착 — 실패한 기기는 위 기기별 목록의 사유 확인' : '시도한 기기 전부 도착'),
      비고: '이 경로는 웹푸시(브라우저·PWA) 전용 — 앱(안드로이드 FCM) 알림은 _push.js sendPushToUsers 가 따로 보낸다',
    },
  });
  return Response.json({ ok: true, sent, fails, cleanedExpired: gone.length });
}

// ─────────────────────────────────────────────────────────────
// Web Push 표준 구현
// ─────────────────────────────────────────────────────────────

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...arrs) {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// VAPID JWT (ES256)
async function makeVapidJwt(endpoint, vapidPubB64, vapidPrivB64, subject) {
  const u = new URL(endpoint);
  const aud = `${u.protocol}//${u.host}`;
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const header  = b64url(new TextEncoder().encode(JSON.stringify({ typ:'JWT', alg:'ES256' })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ aud, exp, sub: subject })));
  const data = `${header}.${payload}`;

  const pub  = b64urlDecode(vapidPubB64);  // 65바이트 (0x04 || x32 || y32)
  const priv = b64urlDecode(vapidPrivB64); // 32바이트
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65)),
    d: b64url(priv)
  };
  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name:'ECDSA', namedCurve:'P-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name:'ECDSA', hash:'SHA-256' }, key,
    new TextEncoder().encode(data)
  );
  return `${data}.${b64url(sig)}`;
}

// HKDF-SHA256
async function hkdf(salt, ikm, info, lengthBytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name:'HKDF', hash:'SHA-256', salt, info },
    key, lengthBytes * 8
  );
  return new Uint8Array(bits);
}

// aes128gcm 페이로드 암호화 (RFC 8291)
async function encryptPayload(plaintext, p256dhB64, authB64) {
  const receiverPub = b64urlDecode(p256dhB64); // 65바이트
  const authSecret  = b64urlDecode(authB64);   // 16바이트

  // 임시 sender ECDH 키쌍
  const ephemeral = await crypto.subtle.generateKey(
    { name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']
  );
  const senderJwk = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
  const senderPub = concat(new Uint8Array([0x04]), b64urlDecode(senderJwk.x), b64urlDecode(senderJwk.y)); // 65바이트

  // Receiver public 키 import
  const receiverKey = await crypto.subtle.importKey(
    'jwk',
    { kty:'EC', crv:'P-256',
      x: b64url(receiverPub.slice(1, 33)),
      y: b64url(receiverPub.slice(33, 65)) },
    { name:'ECDH', namedCurve:'P-256' },
    false, []
  );

  // ECDH 공유 비밀
  const sharedBits = await crypto.subtle.deriveBits(
    { name:'ECDH', public: receiverKey },
    ephemeral.privateKey, 256
  );
  const ecdhSecret = new Uint8Array(sharedBits);

  // Salt (16바이트 랜덤)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // PRK_key 도출: HKDF(auth, ecdhSecret, "WebPush: info\0" || receiver || sender, 32)
  const keyInfo = concat(
    new TextEncoder().encode('WebPush: info\0'),
    receiverPub,
    senderPub
  );
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // CEK: HKDF(salt, ikm, "Content-Encoding: aes128gcm\0", 16)
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  // Nonce: HKDF(salt, ikm, "Content-Encoding: nonce\0", 12)
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  // 평문 + 0x02 끝 마커 (RFC 8188 단일 레코드)
  const pt = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : new Uint8Array(plaintext);
  const padded = concat(pt, new Uint8Array([0x02]));

  // AES-GCM 암호화
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv: nonce }, cekKey, padded));

  // 헤더 조립: salt(16) + recordSize(4 BE) + keyIdLen(1=65) + keyId(senderPub 65) + ciphertext
  const recordSize = 4096;
  const header = new Uint8Array(21);
  header.set(salt, 0);
  header[16] = (recordSize >>> 24) & 0xff;
  header[17] = (recordSize >>> 16) & 0xff;
  header[18] = (recordSize >>>  8) & 0xff;
  header[19] =  recordSize         & 0xff;
  header[20] = 65;
  return { body: concat(header, senderPub, ct), salt, senderPub };
}

// 한 구독에 발송
async function sendWebPush(sub, payload, vapidPub, vapidPriv, subject) {
  const jwt = await makeVapidJwt(sub.endpoint, vapidPub, vapidPriv, subject);
  const { body } = await encryptPayload(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
  return await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'TTL': '86400',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Authorization': `vapid t=${jwt}, k=${vapidPub}`
    },
    body
  });
}
