// /api/notifications — 학부모/학생 알림함(인박스) 조회·읽음 + 관리자 발신
// ───────────────────────────────────────────────────────────
// D1 table: notifications (스키마는 _notifications.js가 소유; 없으면 자동 생성).
// 인증: admin(Bearer ADMIN_PASSWORD) = 학생 지정 조회·발신 / 학생·학부모(토큰) = 본인·자녀만.
//   출결 트리거(결석·숙제25%↓)는 attendance.js가 직접 createNotification 호출 → 여기 POST와 무관.
//   이 엔드포인트의 POST create 경로는 주로 "클리닉 미참석 연락"(조교/원장) + 원장 자유 알림.
//
//  GET                       → 내(자녀들) 알림 목록 + 안읽음 수  { notifications, unread }
//  GET   ?name=홍길동 (admin) → 그 학생에게 나간 알림 목록 (조교는 자기 학원 학생만)
//  POST  { action:'read', id }       (학생/학부모) → 그 알림 읽음 처리(자녀 소유만)
//  POST  { action:'read_all' }       (학생/학부모) → 자녀 알림 전부 읽음
//  POST  { action:'create', name, type, date?, title?, body?, url? }  (admin)
//         type='clinic_absent' → 서버가 문구 합성 + dedup(clinic_absent:sid:date). 조교 가능.
//         type='manual'        → 원장 전용 자유 문구(title/body).
//        → 알림 1건 생성(dedup 시 재삽입 안 함) + 학부모/학생 폰으로 푸시(best-effort).
// ───────────────────────────────────────────────────────────
import { requireStudentAccess, normalizePhone } from './_auth.js';
import { listStudentsByName, getStudentById } from './_db.js';   // listStudents 는 staffNameScope 제거로 더 안 씀
import { staffScopeAcademy } from './_staff.js';
import { sendPushToUsers } from './_push.js';
import { safeError } from './_errors.js';
import { logAudit } from './_auditlog.js';
import {
  createNotification, listNotifications, countUnread,
  markRead, markAllRead, listNotificationsByStudentId,
  listRecentNotificationsAdmin, deleteNotifications,
} from './_notifications.js';

// 👥 2026-07-31 — 여기 있던 staffNameScope(담당 학원 학생 "이름" Set)를 없앴다.
//   이름 Set 통과는 동명이인 앞에서 무의미하다: 세정학원에 김민준이 있으면 대치동 김민준도 통과했고,
//   그 뒤 getStudentByName 이 id 낮은 쪽을 집어 **다른 학원 학생의 알림**을 열어 줬다.
//   권한 판정은 학생을 먼저 확정한 뒤 그 학생의 academy 로 한다(scores.js 와 같은 방식).
//   원장 여부만 필요할 땐 staffScopeAcademy(env, request) === null 로 본다.

function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 로그인한 사람의 자녀/본인 목록 → 알림 수신대상 스코프.
//   학부모로 매칭된 학생 → parentIds(부모 대상 알림 노출), 학생 본인으로 매칭 → studentIds(학생 대상만).
function scopeFromStudents(students) {
  const parentIds = [], studentIds = [];
  for (const s of (students || [])) {
    if (!s || !s.id) continue;
    if (s.role === 'student') studentIds.push(s.id);
    else parentIds.push(s.id);   // 'parent' 또는 그 외 → 부모 뷰
  }
  return { parentIds, studentIds };
}

export async function onRequest(context) {
  const { request, env } = context;
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  const url = new URL(request.url);

  try {
    // ── GET: 목록 ──
    if (request.method === 'GET') {
      if (isAdmin) {
        // 관리자 "보낸 알림함": 최근 나간 알림 전체(학생 이름 포함) — 회수(삭제)용 목록. 원장 전용.
        if (url.searchParams.get('recent')) {
          const academy = await staffScopeAcademy(env, request);   // null=원장
          if (academy !== null) return Response.json({ error: '보낸 알림함은 원장만 볼 수 있어요.' }, { status: 403 });
          const notifications = await listRecentNotificationsAdmin(env, url.searchParams.get('limit'));
          return Response.json({ notifications });
        }
        // 관리자: 특정 학생에게 나간 알림 조회 (id 권장 · 조교는 자기 학원 학생만)
        //   👥 2026-07-31 — 예전엔 ①이름이 담당 학원 명단에 있으면 통과시키고 ②getStudentByName 으로
        //     "먼저 등록된 1명"을 집었다. 같은 이름이 다른 학원에도 있으면 그 학생의 알림 내역이
        //     엉뚱한 조교에게 보였다(이름만 같으면 통과 → id 낮은 쪽이 잡힘).
        //     지금은 학생을 먼저 확정하고 **그 학생의 학원**을 담당 학원과 대조한다.
        const qsid = (url.searchParams.get('id') || '').trim();
        const name = (url.searchParams.get('name') || '').trim();
        if (!qsid && !name) return Response.json({ error: 'id 또는 name 필수' }, { status: 400 });
        const 스코프학원 = await staffScopeAcademy(env, request);   // null=원장 · ''=미배정 조교 · '학원명'
        if (스코프학원 !== null && !스코프학원)
          return Response.json({ error: '담당 학원이 아직 지정되지 않았어요. 원장님께 학원 배정을 요청해 주세요.' }, { status: 403 });
        let st = null;
        if (qsid) {
          st = await getStudentById(env, qsid);
        } else {
          const 후보 = await listStudentsByName(env, name);
          if (후보.length > 1) {
            return Response.json({
              error: '같은 이름 학생이 ' + 후보.length + '명이라 누구인지 확정할 수 없어요. 학생 목록에서 학생을 골라 주세요.',
              동명이인수: 후보.length,
              후보목록: 후보.map((s) => ({ id: String(s.id), 학원: s.academy || '', 반: s.className || '', 학교: s.school || '' })),
            }, { status: 409 });
          }
          st = 후보[0] || null;
        }
        if (!st) return Response.json({ error: '학생을 찾을 수 없습니다.' }, { status: 404 });
        if (스코프학원 !== null && (st.academy || '') !== 스코프학원)
          return Response.json({ error: '담당 학원 학생만 조회할 수 있어요.' }, { status: 403 });
        const notifications = await listNotificationsByStudentId(env, st.id, url.searchParams.get('limit'));
        const unread = await countUnread(env, [st.id]);
        return Response.json({ name: st.name, notifications, unread });
      }
      // 학생/학부모: 본인·자녀 알림 (수신대상 필터 — 학부모=parent, 학생 본인=student만)
      const access = await requireStudentAccess(env, request);
      if (!access.ok) return access.response;
      const scope = scopeFromStudents(access.students);
      const notifications = await listNotifications(env, scope, url.searchParams.get('limit'));
      const unread = await countUnread(env, scope);
      return Response.json({ notifications, unread });
    }

    // ── POST: 발신(admin) / 읽음(학생·학부모) ──
    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const action = (body.action || '').trim();

      // 관리자 발신 (클리닉 미참석 연락 등)
      if (action === 'create') {
        if (!isAdmin) return Response.json({ error: '권한이 없습니다.' }, { status: 403 });
        // 학생 식별은 id 우선(동명이인 안전 — D1 이주 때 정한 계약). 구버전 클라 대비 name도 fallback 허용.
        const sid = (body.id == null ? '' : String(body.id)).trim();
        const name = (body.name || '').trim();
        if (!sid && !name) return Response.json({ error: 'id 또는 name 필수' }, { status: 400 });
        // 조교 스코프는 이름이 아니라 학원(academy)으로 판정 — 같은 이름이 다른 학원에 있어도 안 섞임.
        const academy = await staffScopeAcademy(env, request);   // null=원장(제한없음) · ''=미배정 조교 · '학원명'
        // 👥 2026-07-31 — 이름 폴백이 가장 위험한 자리다. 여기서 잘못 잡히면 **다른 집 학부모 폰으로
        //   푸시가 실제로 나간다**(회수해도 이미 읽음). 예전엔 getStudentByName 이 동명이인 중
        //   먼저 등록된 1명을 조용히 집었다 → 같은 이름의 다른 학생 가정에 "클리닉 미참석" 문자가 갈 수 있었다.
        //   지금은 2명 이상이면 아무에게도 보내지 않고 409로 되돌려 학생을 고르게 한다.
        //   (라이브 화면인 clinic-roster.html·admin-notify.html 은 이미 id 를 보낸다 — 이 폴백은 구버전 대비용.)
        let st = null;
        if (sid) {
          st = await getStudentById(env, sid);
        } else {
          const 후보 = await listStudentsByName(env, name);
          if (후보.length > 1) {
            await logAudit(env, request, {
              action: 'notification.send.ambiguous',
              target: '', targetName: name,
              summary: '[' + name + '] 알림 발송 중단 — 같은 이름 학생이 ' + 후보.length + '명이라 누구인지 확정 못 함',
              detail: {
                찾은이름: name, 동명이인수: 후보.length,
                후보목록: 후보.map((s) => ({ id: String(s.id), 학원: s.academy || '', 반: s.className || '' })),
                유형: (body.type || 'manual').trim(),
                효과: '아무에게도 알림·푸시를 보내지 않았다. 예전엔 먼저 등록된 학생(id 작은 쪽)의 가정으로 실제 발송됐다',
                조치: '학생 목록에서 학생을 골라 id 로 다시 보낼 것',
              },
            });
            return Response.json({
              error: '같은 이름 학생이 ' + 후보.length + '명이라 누구인지 확정할 수 없어요. 학생 목록에서 학생을 골라 주세요.',
              동명이인수: 후보.length,
              후보목록: 후보.map((s) => ({ id: String(s.id), 학원: s.academy || '', 반: s.className || '', 학교: s.school || '' })),
            }, { status: 409 });
          }
          st = 후보[0] || null;
        }
        if (!st) return Response.json({ error: '학생을 찾을 수 없습니다.' }, { status: 404 });
        if (academy !== null && (!academy || (st.academy || '') !== academy)) {
          return Response.json({ error: '담당 학원 학생만 연락할 수 있어요.' }, { status: 403 });
        }
        const isOwner = (academy === null);   // 원장만 자유(manual) 알림 가능

        const type = (body.type || 'manual').trim();
        const date = (body.date || '').trim() || todayKST();
        let title = '', bodyText = '', dedupKey = null, urlPath = '/portal', audience = 'parent';

        if (type === 'clinic_absent') {
          title = '📋 클리닉 미참석 안내';
          bodyText = st.name + ' 학생이 ' + date + ' 클리닉에 참석하지 않았습니다. 확인 부탁드립니다.';
          dedupKey = 'clinic_absent:' + st.id + ':' + date;
          urlPath = '/portal';
          audience = 'parent';   // 보고성 — 학부모 전용(푸시·알림함 모두 학생 제외)
        } else if (type === 'manual') {
          // 자유 문구는 원장만 (조교는 정형 알림만 발신)
          if (!isOwner) return Response.json({ error: '자유 알림은 원장만 보낼 수 있어요.' }, { status: 403 });
          title = (body.title || '').trim() || '📢 알림';
          bodyText = (body.body || '').trim();
          if (!bodyText) return Response.json({ error: '알림 내용을 입력해주세요.' }, { status: 400 });
          if (body.url) urlPath = String(body.url);
          // 받는 사람 선택: parent(학부모) · student(학생) · all(둘 다). 기본 all.
          audience = ['parent', 'student', 'all'].includes((body.audience || '').trim()) ? (body.audience || '').trim() : 'all';
        } else {
          return Response.json({ error: '지원하지 않는 알림 유형입니다.' }, { status: 400 });
        }

        const created = await createNotification(env, {
          studentId: st.id, type, title, body: bodyText, url: urlPath, dedupKey, audience,
        });
        if (!created.ok) return Response.json({ error: created.error || '알림 생성에 실패했습니다.' }, { status: 500 });

        // 새로 생긴 알림만 푸시(dedup으로 재삽입 안 된 경우 푸시도 생략). 푸시 대상은 audience 따라. best-effort.
        if (created.created) {
          const targets = audience === 'parent' ? [st.parentPhone]
                        : audience === 'student' ? [st.studentPhone]
                        : [st.parentPhone, st.studentPhone];
            // ⚠️ 푸시 조회키는 포털이 구독에 쓴 형식(하이픈형 010-1234-5678)이어야 매칭됨(_auth.normalizePhone).
            //    숫자만(replace \D)으로 조회하면 R2 fcm-tokens/push-subs 키 불일치 → 토큰 미발견 → 푸시 누락(알람함만 남음).
          const phones = targets.map(p => normalizePhone(p)).filter(Boolean);
          if (phones.length) {
            // 학부모 번호만 밤(KST 23~7) 무음 — 학생 대상(audience:student)이면 무음 없음.
            const nightSilent = audience === 'student' ? [] : [normalizePhone(st.parentPhone)].filter(Boolean);
            // 📓 2026-08-07 — body.queueIfNight 옵트인: 밤에 드롭하지 말고 R2 야간 큐에 쌓아 아침 7시 첫 크론에 발송.
            //   왜 옵트인인가: 출결·수동공지는 밤에 드롭되는 게 맞다(_push.js §야간 큐 주석). 하지만 '보고서/자료 배포'는
            //   드롭되면 학부모가 영영 못 받고 알림함에만 남는다. 7월 보고서 때 이 구멍 때문에 push-send를 따로 한 번 더
            //   불러야 했다. 일괄전송처럼 "배포"인 호출만 이 플래그를 켠다.
            const pushOpts = nightSilent.length
              ? (body.queueIfNight ? { nightSilent, queueIfNight: true, queueTag: 'kwmath-notif' } : { nightSilent })
              : {};
            const p = sendPushToUsers(env, phones, { title, body: bodyText, url: urlPath, tag: 'kwmath-notif' }, pushOpts);
            if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
            else if (p && typeof p.catch === 'function') p.catch(() => {});
          }
        }
        // 📓 발신도 기록한다. "이 알림이 왜 이 학부모한테 갔나"를 나중에 되짚을 수 있어야 한다
        //    (실제로 '세정학원 공지가 다른 학원에 갔다'를 추적한 적이 있다). 문구·대상·중복차단 결과까지.
        await logAudit(env, request, {
          action: 'notification.send',
          target: String(st.id),
          targetName: st.name || '',
          summary: '[' + (st.name || st.id) + '] 알림 발송(' + type + ') — ' + String(title).slice(0, 40)
            + (created.created ? '' : ' · 중복이라 재발송 안 함'),
          detail: {
            학생id: st.id, 학생이름: st.name || '', 학원: st.academy || '', 반: st.className || '',
            유형: type, 제목: title, 본문: String(bodyText).slice(0, 1000), 링크: urlPath,
            받는사람: audience, 중복키: dedupKey || null,
            새로생성: !!created.created, 알림id: created.id || null,
            푸시대상: created.created
              ? (audience === 'parent' ? [st.parentPhone] : audience === 'student' ? [st.studentPhone] : [st.parentPhone, st.studentPhone])
                  .map((p) => normalizePhone(p)).filter(Boolean)
              : [],
            야간큐옵트인: !!body.queueIfNight,   // 밤이면 학부모 푸시를 드롭 대신 아침 큐로 (2026-08-07)
          },
        });
        return Response.json({ ok: true, created: created.created, id: created.id });
      }

      // 관리자 다중 발신 — 학원/반/학생 골라 자유 알림 일괄 발송(원장 전용). admin-notify.html이 사용.
      //   ids[]는 클라이언트가 학원·반 필터로 펼친 최종 학생 id 목록. 각 학생에 manual 알림 1건 + 대상 폰 푸시.
      //   ⚠️ 학생 식별은 이름이 아니라 id로 — 동명이인 안전(D1 이주 때 정한 계약. admin 승인/수정/삭제도 문자열 id).
      if (action === 'create_bulk') {
        if (!isAdmin) return Response.json({ error: '권한이 없습니다.' }, { status: 403 });
        // 자유 알림은 원장만(조교는 정형 알림만). staffScopeAcademy 가 null 이어야 원장.
        if ((await staffScopeAcademy(env, request)) !== null)
          return Response.json({ error: '자유 알림은 원장만 보낼 수 있어요.' }, { status: 403 });

        const ids = Array.isArray(body.ids)
          ? [...new Set(body.ids.map(n => String(n == null ? '' : n).trim()).filter(Boolean))]
          : [];
        if (!ids.length) return Response.json({ error: '받을 학생을 선택해주세요.' }, { status: 400 });

        const title = (body.title || '').trim() || '📢 알림';
        const bodyText = (body.body || '').trim();
        if (!bodyText) return Response.json({ error: '알림 내용을 입력해주세요.' }, { status: 400 });
        const urlPath = body.url ? String(body.url) : '/portal';
        // 받는 사람: parent(학부모)·student(학생)·all(둘 다). 기본 all.
        const audience = ['parent', 'student', 'all'].includes((body.audience || '').trim()) ? (body.audience || '').trim() : 'all';

        let sent = 0; const misses = []; const pushPhones = new Set(); const nightSilentPhones = new Set();
        const 발송상세 = [];   // 누구에게 갔는지 — 학원/반까지 남겨야 '엉뚱한 학원' 오배송을 되짚을 수 있다
        for (const id of ids) {
          const st = await getStudentById(env, id);
          if (!st) { misses.push(id); continue; }
          const created = await createNotification(env, {
            studentId: st.id, type: 'manual', title, body: bodyText, url: urlPath, dedupKey: null, audience,
          });
          if (!created.ok) { misses.push(id); continue; }
          sent++;
          if (발송상세.length < 300) {
            발송상세.push({
              id: st.id, 이름: st.name || '', 학원: st.academy || '', 반: st.className || '',
              학부모폰: st.parentPhone || '', 학생폰: st.studentPhone || '', 알림id: created.id || null,
            });
          }
          const targets = audience === 'parent' ? [st.parentPhone]
                        : audience === 'student' ? [st.studentPhone]
                        : [st.parentPhone, st.studentPhone];
          // ⚠️ 하이픈형(010-1234-5678)으로 정규화해야 포털이 등록한 푸시 구독키와 일치(위 create 경로 주석 참조).
          for (const p of targets) { const d = normalizePhone(p); if (d) pushPhones.add(d); }
          // 학부모 번호만 밤(KST 23~7) 무음 대상 — 학생 대상(audience:student)이면 제외 안 함.
          if (audience !== 'student') { const pd = normalizePhone(st.parentPhone); if (pd) nightSilentPhones.add(pd); }
        }

        // 문구가 모두 같으니 푸시는 한 번에(모든 대상 폰). best-effort — 발송 흐름과 분리.
        if (pushPhones.size) {
          const pp = sendPushToUsers(env, [...pushPhones], { title, body: bodyText, url: urlPath, tag: 'kwmath-notif' }, nightSilentPhones.size ? { nightSilent: [...nightSilentPhones] } : {});
          if (context && typeof context.waitUntil === 'function') context.waitUntil(pp);
          else if (pp && typeof pp.catch === 'function') pp.catch(() => {});
        }
        // 📓 일괄 발송 1건 = 로그 1건. 대상 명단(이름·학원·반)을 통째로 남긴다.
        //    오배송 추적은 "누구한테 갔나"가 없으면 아예 불가능하다.
        await logAudit(env, request, {
          action: 'notification.send.bulk',
          target: 'students:' + ids.length,
          targetName: (발송상세[0] && 발송상세[0].이름) || '',
          summary: '일괄 알림 발송 ' + sent + '명 (요청 ' + ids.length + '명 · 실패 ' + misses.length + '명) — '
            + String(title).slice(0, 40),
          detail: {
            제목: title, 본문: String(bodyText).slice(0, 2000), 링크: urlPath, 받는사람: audience,
            요청수: ids.length, 성공: sent, 실패: misses,
            대상명단: 발송상세, 명단일부만저장: sent > 300,
            푸시대상폰: [...pushPhones].slice(0, 300),
            밤무음대상: [...nightSilentPhones].slice(0, 300),
          },
        });
        return Response.json({ ok: true, sent, misses });
      }

      // 학생/학부모: 읽음 처리 (자녀 소유 + 수신대상 알림만)
      const access = await requireStudentAccess(env, request);
      if (!access.ok) return access.response;
      const scope = scopeFromStudents(access.students);

      if (action === 'read') {
        const id = (body.id || '').toString().trim();
        if (!id) return Response.json({ error: 'id 필수' }, { status: 400 });
        const res = await markRead(env, id, scope);
        return Response.json(res);
      }
      if (action === 'read_all') {
        const res = await markAllRead(env, scope);
        return Response.json(res);
      }
      return Response.json({ error: '지원하지 않는 action 입니다.' }, { status: 400 });
    }

    // ── DELETE: 알림 회수(원장 전용) — 잘못 보낸 알림을 학부모/학생 알림함에서 삭제 ──
    //   body { ids: ['..'] } 또는 { id: '..' }. 알림함에서는 사라지지만,
    //   ⚠️ 이미 폰에 도착한 푸시 배너까지 되돌리진 못함(웹푸시 한계) — UI에도 같은 안내.
    if (request.method === 'DELETE') {
      if (!isAdmin) return Response.json({ error: '권한이 없습니다.' }, { status: 403 });
      const academy = await staffScopeAcademy(env, request);      // null=원장
      if (academy !== null) return Response.json({ error: '알림 회수는 원장만 할 수 있어요.' }, { status: 403 });
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
      if (!ids.length) return Response.json({ error: '회수할 알림을 선택해주세요.' }, { status: 400 });
      const res = await deleteNotifications(env, ids);
      if (!res.ok) return Response.json({ error: res.error || '회수에 실패했습니다.' }, { status: 500 });
      // ⚠️ 회수 = 영구 삭제. 이미 학부모 폰에 뜬 배너는 못 되돌리므로, "무슨 내용을 누구에게 보냈다가
      //    언제 거둬들였는지"가 남아야 문의에 답할 수 있다. 원문(제목·본문·대상)을 통째로 남긴다.
      const rows = res.before || [];
      await logAudit(env, request, {
        action: 'notification.recall',
        target: ids.slice(0, 20).join(','),
        targetName: (rows[0] && (rows[0].title || '')) || '',
        summary: '알림 회수(영구 삭제) ' + res.deleted + '건'
          + (rows[0] && rows[0].title ? ' — [' + String(rows[0].title).slice(0, 40) + ']' : '')
          + (rows.length > 1 ? ' 외 ' + (rows.length - 1) + '건' : ''),
        detail: {
          요청id: ids, 삭제건수: res.deleted,
          지워진알림: rows.slice(0, 100),
          일부만저장: rows.length > 100,
          주의: '이미 폰에 도착한 푸시 배너는 회수되지 않음(플랫폼 한계)',
        },
      });
      return Response.json({ ok: true, deleted: res.deleted });
    }

    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  } catch (e) {
    return safeError(e, env, { message: '알림 처리 중 오류가 발생했습니다.' });
  }
}
