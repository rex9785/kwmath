import { fetchStudentsByPhone } from './_auth.js';

const DB = '6cf7a459bd3d4444bd4c9341f3ffe907';
const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';

function auth(request, env) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  return token === env.ADMIN_PASSWORD;
}

// 대상별 phone 리스트 추출 — 푸쉬 발송용
export async function collectTargetPhones(env, targetType, targetValue) {
  if (targetType === '전체' || !targetType) {
    // R2 push-subs/ 전체
    try {
      const listed = await env.BUCKET.list({ prefix: 'push-subs/', limit: 1000 });
      return (listed.objects || [])
        .map(obj => decodeURIComponent(obj.key.replace('push-subs/', '').replace('.json', '')))
        .filter(Boolean);
    } catch { return []; }
  }
  // 학원/반/개인 — Notion 학생 DB에서 필터
  let filter = null;
  if (targetType === '학원') {
    filter = { property: '학원', select: { equals: targetValue } };
  } else if (targetType === '반') {
    // targetValue 형식: "학원/반"
    const [acad, cls] = (targetValue || '').split('/');
    filter = { and: [
      { property: '학원', select: { equals: acad } },
      { property: '반',   select: { equals: cls } },
    ]};
  } else if (targetType === '개인') {
    filter = { property: '이름', title: { equals: targetValue } };
  }
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter, page_size: 100 }),
    });
    const data = await res.json();
    const rt = (p, k) => ((p[k]?.rich_text || [])[0]?.plain_text || '').trim();
    const phones = new Set();
    for (const page of (data.results || [])) {
      if (page.archived || page.in_trash) continue;
      const pp = rt(page.properties, '학부모 휴대폰');
      const sp = rt(page.properties, '학생 연락처');
      if (pp) phones.add(pp);
      if (sp) phones.add(sp);
    }
    return [...phones];
  } catch { return []; }
}

// 푸쉬 발송 + Notion 마킹 — notices-flush에서도 재사용
export async function dispatchNoticePush(env, originUrl, { pageId, title, badge, content, targetType, targetValue }) {
  let pushResult;
  try {
    const phones = await collectTargetPhones(env, targetType, targetValue);
    if (phones.length) {
      const pushRes = await fetch(new URL('/api/push-send', originUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: env.ADMIN_PASSWORD,
          userIds: phones,
          title: '📢 ' + (badge || '공지') + ' — ' + title,
          body: (content || '').slice(0, 100) || '새 공지사항이 등록됐어요',
          url: '/portal',
          tag: 'notice-' + Date.now(),
        }),
      });
      pushResult = await pushRes.json().catch(() => ({}));
      pushResult.targetCount = phones.length;
    } else {
      pushResult = { ok: true, sent: 0, note: '대상 phone 없음', targetCount: 0 };
    }
  } catch (e) {
    pushResult = { error: e.message };
  }
  // Notion 마킹
  if (pageId) {
    try {
      await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: {
          '푸쉬 발송됨': { checkbox: true },
          '푸쉬 결과': { rich_text: [{ text: { content: JSON.stringify(pushResult).slice(0, 1900) } }] },
        }}),
      });
    } catch (_) { /* 비치명적 */ }
  }
  return pushResult;
}

export async function onRequest({ request, env }) {
  if (!auth(request, env)) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  if (request.method === 'POST') {
    const body = await request.json();
    const { title, badge, content, targetType, targetValue, pushMode, scheduledAt } = body;
    // pushMode: 'none' | 'immediate' | 'scheduled'  (구버전 호환: sendPush=true → 'immediate')
    let mode = (pushMode || '').toString();
    if (!mode) mode = body.sendPush ? 'immediate' : 'none';

    if (!title) return Response.json({ error: '제목을 입력해주세요.' }, { status: 400 });
    if (mode === 'scheduled' && !scheduledAt) {
      return Response.json({ error: '예약 시각을 입력해주세요.' }, { status: 400 });
    }

    const today = new Date().toISOString().split('T')[0];
    const tt = (targetType || '전체').toString();
    const tv = (targetValue || '').toString();

    const properties = {
      '제목': { title: [{ text: { content: title } }] },
      '뱃지': { select: { name: badge || '공지' } },
      '날짜': { date: { start: today } },
      '내용': { rich_text: [{ text: { content: content || '' } }] },
      '공개': { checkbox: true },
      '대상 유형': { select: { name: tt } },
      '대상 값':   { rich_text: [{ text: { content: tv } }] },
      '푸쉬 발송됨': { checkbox: false },
    };
    if (mode === 'scheduled') {
      let iso;
      try { iso = new Date(scheduledAt).toISOString(); }
      catch { return Response.json({ error: '예약 시각 형식 오류' }, { status: 400 }); }
      properties['예약 발송 시각'] = { date: { start: iso } };
    }

    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: { database_id: DB }, properties }),
    });
    const data = await res.json();
    if (data.object === 'error') return Response.json({ error: data.message }, { status: 500 });

    // 즉시 발송이면 바로 dispatch
    let pushResult = null;
    if (mode === 'immediate') {
      pushResult = await dispatchNoticePush(env, request.url, {
        pageId: data.id, title, badge, content, targetType: tt, targetValue: tv,
      });
    }

    return Response.json({
      ok: true,
      id: data.id,
      pushMode: mode,
      scheduledAt: mode === 'scheduled' ? scheduledAt : null,
      push: pushResult,
    });
  }

  if (request.method === 'PATCH') {
    const body = await request.json();
    const { pageId, title, badge, content, targetType, targetValue } = body;
    if (!pageId) return Response.json({ error: 'pageId 필요' }, { status: 400 });
    const properties = {};
    if (typeof title       === 'string') properties['제목']      = { title:     [{ text: { content: title } }] };
    if (typeof badge       === 'string') properties['뱃지']      = { select:    { name: badge } };
    if (typeof content     === 'string') properties['내용']      = { rich_text: [{ text: { content } }] };
    if (typeof targetType  === 'string') properties['대상 유형'] = { select:    { name: targetType } };
    if (typeof targetValue === 'string') properties['대상 값']   = { rich_text: [{ text: { content: targetValue } }] };
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return Response.json({ error: err.message || 'Notion 수정 실패' }, { status: res.status });
    }
    return Response.json({ ok: true });
  }

  if (request.method === 'DELETE') {
    const body = await request.json();
    const { pageId } = body;
    if (!pageId) return Response.json({ error: 'pageId 필요' }, { status: 400 });
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return Response.json({ error: err.message || '삭제 실패' }, { status: res.status });
    }
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
