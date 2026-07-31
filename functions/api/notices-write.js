import { safeError } from './_errors.js';
import { fetchStudentsByPhone } from './_auth.js';
import { sendPushToUsers } from './_push.js';   // 🔔 2026-07-30 — 웹푸시+FCM 병행 (push-send 경유 시 FCM 미발송 버그 수정)
import { logAudit, diffFields } from './_auditlog.js';

const DB = '6cf7a459bd3d4444bd4c9341f3ffe907';
const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';

// ── 노션 공지 한 장을 사람이 읽는 형태로 읽어온다 (수정·삭제 전 "전" 값 확보용) ──
//   🔎 2026-07-31 — 공지 본문은 노션에 있어서 여기 코드만 봐서는 뭘 덮어썼는지 알 길이 없었다.
//   수정/삭제 직전에 한 번 읽어 로그에 박아둔다(공지는 하루 몇 건이라 호출 비용 문제 없음).
//   실패해도 null 만 돌려주고 원래 동작(수정/삭제)은 절대 막지 않는다.
async function readNoticeSnapshot(env, pageId) {
  try {
    const r = await fetch('https://api.notion.com/v1/pages/' + pageId, {
      headers: { Authorization: 'Bearer ' + env.NOTION_TOKEN, 'Notion-Version': '2022-06-28' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    const p = d.properties || {};
    const txt = (v) => (((v || {}).rich_text || [])[0] || {}).plain_text || '';
    const ttl = (v) => (((v || {}).title || [])[0] || {}).plain_text || '';
    return {
      제목: ttl(p['제목']),
      뱃지: ((p['뱃지'] || {}).select || {}).name || '',
      내용: txt(p['내용']),
      대상유형: ((p['대상 유형'] || {}).select || {}).name || '',
      대상값: txt(p['대상 값']),
      이미지: txt(p['이미지']),
      공개: !!(p['공개'] || {}).checkbox,
      날짜: ((p['날짜'] || {}).date || {}).start || '',
      예약발송시각: ((p['예약 발송 시각'] || {}).date || {}).start || '',
      푸쉬발송됨: !!(p['푸쉬 발송됨'] || {}).checkbox,
      보관됨: !!d.archived,
    };
  } catch (_) { return null; }
}

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
  // 학원/반/개인 — D1 students에서 추출
  let sql = '', binds = [];
  if (targetType === '학원') {
    sql = 'SELECT parent_phone, student_phone FROM students WHERE academy = ?';
    binds = [targetValue];
  } else if (targetType === '반') {
    const parts = (targetValue || '').split('/');
    sql = 'SELECT parent_phone, student_phone FROM students WHERE academy = ? AND class_name = ?';
    binds = [parts[0] || '', parts[1] || ''];
  } else if (targetType === '개인') {
    // 🆔 2026-07-30 — 신형 "id|이름" 값이면 id로 조회(동명이인 안전), 구형(이름만) 공지는 name 폴백
    const m = /^(\d+)\|/.exec(targetValue || '');
    if (m) {
      sql = 'SELECT parent_phone, student_phone FROM students WHERE id = ?';
      binds = [Number(m[1])];
    } else {
      sql = 'SELECT parent_phone, student_phone FROM students WHERE name = ?';
      binds = [targetValue];
    }
  } else {
    return [];
  }
  try {
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    const phones = new Set();
    for (const r of (results || [])) {
      if (r.parent_phone) phones.add(r.parent_phone);
      if (r.student_phone) phones.add(r.student_phone);
    }
    return [...phones];
  } catch { return []; }
}

// 푸쉬 발송 + Notion 마킹 — notices-flush에서도 재사용
//   🔔 2026-07-30 — /api/push-send(웹푸시 전용) 경유를 sendPushToUsers(웹+FCM 병행)로 교체.
//     앱(WebView) 학부모는 FCM만 등록돼 있어 기존 경로로는 공지 푸시를 못 받았다.
//     originUrl 파라미터는 호출부 호환을 위해 유지(더 이상 사용 안 함).
export async function dispatchNoticePush(env, originUrl, { pageId, title, badge, content, targetType, targetValue }) {
  let pushResult;
  try {
    const phones = await collectTargetPhones(env, targetType, targetValue);
    if (phones.length) {
      pushResult = await sendPushToUsers(env, phones, {
        title: '📢 ' + (badge || '공지') + ' — ' + title,
        body: (content || '').slice(0, 100) || '새 공지사항이 등록됐어요',
        url: '/portal',
        tag: 'notice-' + Date.now(),
      });
      pushResult.targetCount = phones.length;
      // 📓 "누구에게 갔나"를 호출부가 로그로 남길 수 있게 명단을 돌려준다(최대 300개).
      //   과거 「세정학원 공지가 다른 학원에도 갔다」 같은 사고를 사후에 증명할 유일한 근거.
      pushResult.phones = phones.slice(0, 300);
      pushResult.phonesTruncated = phones.length > 300;
    } else {
      pushResult = { ok: true, sent: 0, note: '대상 phone 없음', targetCount: 0, phones: [], phonesTruncated: false };
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
    const { title, badge, content, targetType, targetValue, pushMode, scheduledAt, images } = body;
    const imgList = Array.isArray(images)
      ? images.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim())
      : [];
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
    if (imgList.length) {
      properties['이미지'] = { rich_text: [{ text: { content: imgList.join(',').slice(0, 1900) } }] };
    }
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
    if (data.object === 'error') return safeError(data, null, { message: '공지 저장에 실패했습니다.' });

    // 즉시 발송이면 바로 dispatch
    let pushResult = null;
    if (mode === 'immediate') {
      pushResult = await dispatchNoticePush(env, request.url, {
        pageId: data.id, title, badge, content, targetType: tt, targetValue: tv,
      });
    }

    // 📓 공지 작성 — 무엇을·누구에게·언제 보냈는지 전부 남긴다.
    await logAudit(env, request, {
      action: 'notice.create',
      target: String(data.id || ''), targetName: title,
      summary: '공지 작성 [' + (badge || '공지') + '] ' + title + ' · 대상 ' + tt + (tv ? '(' + tv + ')' : '')
        + ' · ' + (mode === 'immediate' ? '즉시 발송' : mode === 'scheduled' ? ('예약 ' + scheduledAt) : '푸시 안 함'),
      detail: {
        노션페이지id: data.id || '',
        제목: title, 뱃지: badge || '공지', 내용: content || '',
        대상유형: tt, 대상값: tv,
        이미지수: imgList.length, 이미지: imgList.slice(0, 20),
        푸시모드: mode, 예약시각: mode === 'scheduled' ? scheduledAt : '',
        푸시결과: pushResult ? {
          보낸수: pushResult.sent, 대상수: pushResult.targetCount,
          받는사람: pushResult.phones || [], 명단잘림: !!pushResult.phonesTruncated,
          오류: pushResult.error || '',
        } : '(발송 안 함)',
      },
    });

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
    const { pageId, title, badge, content, targetType, targetValue, images } = body;
    if (!pageId) return Response.json({ error: 'pageId 필요' }, { status: 400 });
    // 🔎 덮어쓰기 전에 원본을 읽어 둔다 — 안 하면 "전" 값이 영영 사라진다.
    const before = await readNoticeSnapshot(env, pageId);
    const properties = {};
    if (typeof title       === 'string') properties['제목']      = { title:     [{ text: { content: title } }] };
    if (typeof badge       === 'string') properties['뱃지']      = { select:    { name: badge } };
    if (typeof content     === 'string') properties['내용']      = { rich_text: [{ text: { content } }] };
    if (Array.isArray(images)) {
      const il = images.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
      properties['이미지'] = { rich_text: [{ text: { content: il.join(',').slice(0, 1900) } }] };
    }
    if (typeof targetType  === 'string') properties['대상 유형'] = { select:    { name: targetType } };
    if (typeof targetValue === 'string') properties['대상 값']   = { rich_text: [{ text: { content: targetValue } }] };
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return safeError(err, null, { message: '공지 수정에 실패했습니다.' });
    }

    // 📓 칸별 전/후. 원본을 못 읽었으면(노션 오류) 그 사실도 그대로 남긴다 — 조용히 넘기지 않는다.
    const after = before ? { ...before } : null;
    if (after) {
      if (typeof title === 'string') after.제목 = title;
      if (typeof badge === 'string') after.뱃지 = badge;
      if (typeof content === 'string') after.내용 = content;
      if (typeof targetType === 'string') after.대상유형 = targetType;
      if (typeof targetValue === 'string') after.대상값 = targetValue;
      if (Array.isArray(images)) {
        after.이미지 = images.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()).join(',').slice(0, 1900);
      }
    }
    const d = after ? diffFields(before, after, ['제목', '뱃지', '내용', '대상유형', '대상값', '이미지']) : null;
    await logAudit(env, request, {
      action: 'notice.update',
      target: String(pageId), targetName: (before && before.제목) || (typeof title === 'string' ? title : ''),
      summary: '공지 수정 [' + ((before && before.제목) || pageId) + '] — ' + (d ? (d.요약 || '변경 없음') : '수정 전 원본을 못 읽음'),
      detail: {
        노션페이지id: pageId,
        수정전: before || '(노션에서 원본을 못 읽음 — 전 값 확보 실패)',
        바뀐칸: d ? d.바뀐칸 : [],
        변경: d ? d.변경 : {},
        보낸값: {
          제목: typeof title === 'string' ? title : '(안 보냄)',
          뱃지: typeof badge === 'string' ? badge : '(안 보냄)',
          내용: typeof content === 'string' ? content : '(안 보냄)',
          대상유형: typeof targetType === 'string' ? targetType : '(안 보냄)',
          대상값: typeof targetValue === 'string' ? targetValue : '(안 보냄)',
          이미지: Array.isArray(images) ? images.length + '장' : '(안 보냄)',
        },
        대상바뀜: !!(d && d.바뀐칸 && (d.바뀐칸.includes('대상유형') || d.바뀐칸.includes('대상값'))),
      },
    });
    return Response.json({ ok: true });
  }

  if (request.method === 'DELETE') {
    const body = await request.json();
    const { pageId } = body;
    if (!pageId) return Response.json({ error: 'pageId 필요' }, { status: 400 });
    // 🔎 삭제(노션 보관) 전에 내용을 통째로 읽어 로그에 박는다.
    //    노션 휴지통에서 복원은 가능하지만 기한이 있고, 무엇을 지웠는지는 여기 로그가 유일한 즉시 근거.
    const gone = await readNoticeSnapshot(env, pageId);
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return safeError(err, null, { message: '공지 삭제에 실패했습니다.' });
    }

    await logAudit(env, request, {
      action: 'notice.delete',
      target: String(pageId), targetName: (gone && gone.제목) || '',
      summary: '공지 삭제 [' + ((gone && gone.제목) || pageId) + ']'
        + (gone ? ' · 대상 ' + (gone.대상유형 || '?') + (gone.대상값 ? '(' + gone.대상값 + ')' : '') : '')
        + (gone && gone.푸쉬발송됨 ? ' · ⚠️ 이미 푸시 나간 공지' : ''),
      detail: {
        노션페이지id: pageId,
        지워진공지: gone || '(노션에서 원본을 못 읽음)',
        이미푸시나감: !!(gone && gone.푸쉬발송됨),
        비고: '노션 archived=true 처리 — 노션 휴지통에서 일정 기간 복원 가능. 앱 화면에서는 즉시 사라짐.',
      },
    });
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
