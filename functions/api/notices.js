import { safeError } from './_errors.js';
// GET /api/notices
// - 인증 없이 호출: 전체 대상 공지만 반환 (메인 홈피용)
// - Authorization: Bearer <userToken>: 그 학생/학부모에게 해당하는 공지만 (전체 + 학원 + 반 + 개인)
// - admin: 모든 공지 반환
//
// 부수효과: 5분 쿨다운으로 예약 푸쉬 자동 발송 (opportunistic cron)
//   누군가 포털을 열면 자동으로 예약된 공지가 발송됨. 외부 cron 불필요.

import { bearerFromRequest, verifyToken, fetchStudentsByPhone } from './_auth.js';
import { dispatchNoticePush } from './notices-write.js';
import { logAudit } from './_auditlog.js';

const DB = '6cf7a459bd3d4444bd4c9341f3ffe907';
const FLUSH_COOLDOWN_MS = 5 * 60 * 1000;
const FLUSH_LOCK_KEY = 'auth/notice-flush-last.json';

function isQuietHourKST() {
  const kstHour = (new Date().getUTCHours() + 9) % 24;
  return (kstHour >= 23) || (kstHour < 7);
}

async function maybeFlushScheduled(env, originUrl) {
  if (isQuietHourKST()) return;
  try {
    const lockObj = await env.BUCKET.get(FLUSH_LOCK_KEY);
    let lastAt = 0;
    if (lockObj) {
      try { lastAt = (await lockObj.json()).t || 0; } catch (_) {}
    }
    const now = Date.now();
    if (now - lastAt < FLUSH_COOLDOWN_MS) return;

    await env.BUCKET.put(FLUSH_LOCK_KEY, JSON.stringify({ t: now }), {
      httpMetadata: { contentType: 'application/json' },
    });

    const nowIso = new Date().toISOString();
    const queryRes = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: {
          and: [
            { property: '푸쉬 발송됨', checkbox: { equals: false } },
            { property: '예약 발송 시각', date: { is_not_empty: true } },
            { property: '예약 발송 시각', date: { on_or_before: nowIso } },
          ],
        },
        page_size: 20,
      }),
    });
    const data = await queryRes.json();
    if (data.object === 'error') return;

    const rt   = (p, k) => ((p[k]?.rich_text || [])[0]?.plain_text || '').trim();
    const ttl  = (p, k) => ((p[k]?.title || [])[0]?.plain_text || '').trim();
    const sel  = (p, k) => p[k]?.select?.name || '';

    for (const page of (data.results || [])) {
      if (page.archived || page.in_trash) continue;
      const pp = page.properties || {};
      const item = {
        pageId: page.id,
        title: ttl(pp, '제목'),
        badge: sel(pp, '뱃지'),
        content: rt(pp, '내용'),
        targetType: sel(pp, '대상 유형') || '전체',
        targetValue: rt(pp, '대상 값'),
      };
      const push = await dispatchNoticePush(env, originUrl, item);

      // 📓 2026-07-31 — 예약 공지는 **사람이 안 누르는데도** 발송된다.
      //   누가 보냈냐고 물으면 답이 없던 자리 → actor='system'(예약 발송)으로 못 박아 남긴다.
      //   request 가 없는 자리라 null 을 넘긴다(logAudit 이 허용).
      await logAudit(env, null, {
        action: 'notice.push.scheduled',
        actor: 'system', actorRole: 'system', actorName: '예약 발송(자동)',
        path: 'AUTO /api/notices (예약 플러시)',
        target: String(item.pageId || ''), targetName: item.title || '',
        summary: '예약 공지 자동 발송 [' + (item.badge || '공지') + '] ' + (item.title || '')
          + ' · 대상 ' + item.targetType + (item.targetValue ? '(' + item.targetValue + ')' : '')
          + ' · ' + ((push && push.targetCount) || 0) + '명',
        detail: {
          노션페이지id: item.pageId, 제목: item.title, 뱃지: item.badge, 내용: item.content,
          대상유형: item.targetType, 대상값: item.targetValue,
          받는사람: (push && push.phones) || [], 명단잘림: !!(push && push.phonesTruncated),
          보낸수: (push && push.sent) || 0, 대상수: (push && push.targetCount) || 0,
          오류: (push && push.error) || '',
          트리거: '포털/공지 조회가 5분 쿨다운을 지나 자동 플러시',
        },
      });
    }
  } catch (_) {}
}

export async function onRequest(context) {
  const { request, env } = context;

  if (context.waitUntil) {
    context.waitUntil(maybeFlushScheduled(env, request.url));
  } else {
    maybeFlushScheduled(env, request.url).catch(() => {});
  }

  const token = bearerFromRequest(request);
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  let userStudents = null;
  if (token && !isAdmin) {
    const payload = await verifyToken(env, token);
    if (payload && payload.phone) {
      userStudents = await fetchStudentsByPhone(env, payload.phone);
    }
  }

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: { property: '공개', checkbox: { equals: true } },
        sorts: [{ property: '날짜', direction: 'descending' }],
        page_size: 50,
      }),
    });
    const data = await res.json();
    const joinText = (rt) => (rt || []).map(t => t.plain_text).join('');

    const allNotices = (data.results || []).filter(p => !p.archived && !p.in_trash).map(p => ({
      id: p.id,
      title: (p.properties['제목']?.title || []).map(t => t.plain_text).join(''),
      date: p.properties['날짜']?.date?.start || '',
      badge: p.properties['뱃지']?.select?.name || '공지',
      content: joinText(p.properties['내용']?.rich_text),
      images: joinText(p.properties['이미지']?.rich_text).split(',').map(s => s.trim()).filter(Boolean),
      targetType: p.properties['대상 유형']?.select?.name || '전체',
      targetValue: joinText(p.properties['대상 값']?.rich_text),
      scheduledAt: p.properties['예약 발송 시각']?.date?.start || '',
      pushed: p.properties['푸쉬 발송됨']?.checkbox === true,
    }));

    if (isAdmin) {
      return Response.json(allNotices);
    }

    if (userStudents) {
      const myAcademies = new Set(userStudents.map(s => s.academy).filter(Boolean));
      const myClasses   = new Set(userStudents.map(s => (s.academy||'') + '/' + (s.className||'')).filter(v => v !== '/'));
      const myNames     = new Set(userStudents.map(s => s.name).filter(Boolean));
      const myIds       = new Set(userStudents.map(s => String(s.id)).filter(Boolean));   // 🆔 2026-07-30

      const filtered = allNotices.filter(n => {
        if (n.targetType === '전체' || !n.targetType) return true;
        if (n.targetType === '학원') return myAcademies.has(n.targetValue);
        if (n.targetType === '반') return myClasses.has(n.targetValue);
        if (n.targetType === '개인') {
          // 🆔 신형 "id|이름" 값이면 id 대조(동명이인 안전), 구형(이름만)은 name 폴백
          const m = /^(\d+)\|/.exec(n.targetValue || '');
          return m ? myIds.has(m[1]) : myNames.has(n.targetValue);
        }
        return false;
      });
      return Response.json(filtered);
    }

    return Response.json(allNotices.filter(n => n.targetType === '전체' || !n.targetType));
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
