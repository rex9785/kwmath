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
import { requireStudentAccess } from './_auth.js';
import { getStudentByName, getStudentById, listStudents } from './_db.js';
import { staffScopeAcademy } from './_staff.js';
import { sendPushToUsers } from './_push.js';
import { safeError } from './_errors.js';
import {
  createNotification, listNotifications, countUnread,
  markRead, markAllRead, listNotificationsByStudentId,
} from './_notifications.js';

// 조교(X-Staff-Phone)면 "맡은 학원" 학생 이름 Set, 원장이면 null(제한 없음). (scores.js와 동일 패턴)
//   미배정 조교는 빈 Set → 아무 학생도 조회·발신 불가.
async function staffNameScope(env, request) {
  const academy = await staffScopeAcademy(env, request);
  if (academy === null) return null;                               // 원장 → 전체
  const roster = academy ? (await listStudents(env)).filter(s => (s.academy || '') === academy) : [];
  return new Set(roster.map(s => s.name));
}

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
        // 관리자: 특정 학생에게 나간 알림 조회 (조교는 자기 학원 학생만)
        const name = (url.searchParams.get('name') || '').trim();
        if (!name) return Response.json({ error: 'name 필수' }, { status: 400 });
        const allowedNames = await staffNameScope(env, request);
        if (allowedNames && !allowedNames.has(name)) {
          return Response.json({ error: '담당 학원 학생만 조회할 수 있어요.' }, { status: 403 });
        }
        const st = await getStudentByName(env, name);
        if (!st) return Response.json({ error: '학생을 찾을 수 없습니다.' }, { status: 404 });
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
        const name = (body.name || '').trim();
        if (!name) return Response.json({ error: 'name 필수' }, { status: 400 });
        const allowedNames = await staffNameScope(env, request);   // 조교면 Set, 원장이면 null
        if (allowedNames && !allowedNames.has(name)) {
          return Response.json({ error: '담당 학원 학생만 연락할 수 있어요.' }, { status: 403 });
        }
        const st = await getStudentByName(env, name);
        if (!st) return Response.json({ error: '학생을 찾을 수 없습니다.' }, { status: 404 });

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
          if (allowedNames !== null) return Response.json({ error: '자유 알림은 원장만 보낼 수 있어요.' }, { status: 403 });
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
          const phones = targets.map(p => String(p || '').replace(/\D/g, '')).filter(Boolean);
          if (phones.length) {
            const p = sendPushToUsers(env, phones, { title, body: bodyText, url: urlPath, tag: 'kwmath-notif' });
            if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
            else if (p && typeof p.catch === 'function') p.catch(() => {});
          }
        }
        return Response.json({ ok: true, created: created.created, id: created.id });
      }

      // 관리자 다중 발신 — 학원/반/학생 골라 자유 알림 일괄 발송(원장 전용). admin-notify.html이 사용.
      //   ids[]는 클라이언트가 학원·반 필터로 펼친 최종 학생 id 목록. 각 학생에 manual 알림 1건 + 대상 폰 푸시.
      //   ⚠️ 학생 식별은 이름이 아니라 id로 — 동명이인 안전(D1 이주 때 정한 계약. admin 승인/수정/삭제도 문자열 id).
      if (action === 'create_bulk') {
        if (!isAdmin) return Response.json({ error: '권한이 없습니다.' }, { status: 403 });
        // 자유 알림은 원장만(조교는 정형 알림만). staffNameScope가 null이어야 원장.
        const allowedNames = await staffNameScope(env, request);
        if (allowedNames !== null) return Response.json({ error: '자유 알림은 원장만 보낼 수 있어요.' }, { status: 403 });

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

        let sent = 0; const misses = []; const pushPhones = new Set();
        for (const id of ids) {
          const st = await getStudentById(env, id);
          if (!st) { misses.push(id); continue; }
          const created = await createNotification(env, {
            studentId: st.id, type: 'manual', title, body: bodyText, url: urlPath, dedupKey: null, audience,
          });
          if (!created.ok) { misses.push(id); continue; }
          sent++;
          const targets = audience === 'parent' ? [st.parentPhone]
                        : audience === 'student' ? [st.studentPhone]
                        : [st.parentPhone, st.studentPhone];
          for (const p of targets) { const d = String(p || '').replace(/\D/g, ''); if (d) pushPhones.add(d); }
        }

        // 문구가 모두 같으니 푸시는 한 번에(모든 대상 폰). best-effort — 발송 흐름과 분리.
        if (pushPhones.size) {
          const pp = sendPushToUsers(env, [...pushPhones], { title, body: bodyText, url: urlPath, tag: 'kwmath-notif' });
          if (context && typeof context.waitUntil === 'function') context.waitUntil(pp);
          else if (pp && typeof pp.catch === 'function') pp.catch(() => {});
        }
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

    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  } catch (e) {
    return safeError(e, env, { message: '알림 처리 중 오류가 발생했습니다.' });
  }
}
