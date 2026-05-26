import { fetchStudentsByPhone } from './_auth.js';

const DB = '6cf7a459bd3d4444bd4c9341f3ffe907';
const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';

function auth(request, env) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  return token === env.ADMIN_PASSWORD;
}

// 대상별 phone 리스트 추출 — 푸쉬 발송용
async function collectTargetPhones(env, targetType, targetValue) {
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

export async function onRequest({ request, env }) {
  if (!auth(request, env)) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  if (request.method === 'POST') {
    const body = await request.json();
    const { title, badge, content, targetType, targetValue, sendPush } = body;
    if (!title) return Response.json({ error: '제목을 입력해주세요.' }, { status: 400 });
    const today = new Date().toISOString().split('T')[0];
    const tt = (targetType || '전체').toString();
    const tv = (targetValue || '').toString();

    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: { database_id: DB }, properties: {
        '제목': { title: [{ text: { content: title } }] },
        '뱃지': { select: { name: badge || '공지' } },
        '날짜': { date: { start: today } },
        '내용': { rich_text: [{ text: { content: content || '' } }] },
        '공개': { checkbox: true },
        '대상 유형': { select: { name: tt } },
        '대상 값':   { rich_text: [{ text: { content: tv } }] },
      }}),
    });
    const data = await res.json();
    if (data.object === 'error') return Response.json({ error: data.message }, { status: 500 });

    // 푸쉬 발송 (옵션) — sendPush === true 일 때만
    let pushResult = null;
    if (sendPush) {
      try {
        const phones = await collectTargetPhones(env, tt, tv);
        if (phones.length) {
          const pushRes = await fetch(new URL('/api/push-send', request.url), {
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
        } else {
          pushResult = { ok: true, sent: 0, note: '대상 phone 없음' };
        }
      } catch (e) { pushResult = { error: e.message }; }
    }

    return Response.json({ ok: true, id: data.id, push: pushResult });
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
