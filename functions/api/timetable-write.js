// /api/timetable-write — 홈 화면 「수업 시간표」의 쓰기 API (관리자 전용)
// ═══════════════════════════════════════════════════════════════════════════
// 왜 만들었나 (2026-09-18, 관우T 결정) — clips-write.js 와 같은 이유.
//   시간표도 읽기 API(timetable.js)만 있어서, 반 하나를 열거나 닫으려면 노션 앱을 열어야 했다.
//   저장소는 노션 그대로 두고 편집 화면만 admin 으로 들여온다.
//
// timetable.js(공개용)와 무엇이 다른가
//   timetable.js : 공개=true 인 행만 · 인증 없음 · 홈 화면이 부른다.
//   여기 GET     : 공개 여부와 무관하게 **전 행** · 관리자 인증 필수.
//     ⚠️ 비공개 행까지 보여줘야 하는 이유 — 「세정학원 7월 오픈」처럼 미리 만들어 두고
//        때가 되면 공개로 올리는 행이 실제로 있다. 공개 행만 보이면 그 행을 다시 못 찾는다.
//
// 속성 이름은 노션 DB와 글자 단위로 같아야 한다 (2026-09-18 실물 확인):
//   반 이름(title) · 학원(select) · 요일(multi_select) · 시간(rich_text)
//   · 대상(rich_text) · 메모(rich_text) · 공개(checkbox)

import { safeError } from './_errors.js';
import { logAudit, diffFields } from './_auditlog.js';

const DB = 'e06ead6fdd61424688f15bbb35003c97';
const NOTION = 'https://api.notion.com/v1';

function nh(env) {
  return {
    Authorization: 'Bearer ' + env.NOTION_TOKEN,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
}

// 🔒 원장 전용 — 이중 잠금 (2026-09-18)
//   관우T 지시: "조교계정이 홈 홍보문구 홈클립 이런걸 볼 수 있으면 안 되지".
//   _middleware.js 의 STAFF_GET_BLOCK 이 '/api/timetable-write'를 막지만, 미들웨어 한 겹만 믿지 않는다.
//   ⚠️ 미들웨어는 조교(ast_) 토큰을 **Bearer ADMIN_PASSWORD 로 번역해서** 내려보낸다.
//      그래서 아래 token 비교만으로는 원장과 조교를 구분할 수 없다 — 역할은 헤더로 본다.
//      X-Kw-Actor-Role / X-Staff-Phone 은 미들웨어가 요청이 들어오는 즉시 지우고 검증된 값만 다시
//      붙이므로 외부에서 위조해 넣을 수 없다. audit-log.js·undo-upload.js 와 같은 방식이다.
function auth(request, env) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) return false;
  if ((request.headers.get('X-Kw-Actor-Role') || '') === 'staff') return false;
  if (request.headers.get('X-Staff-Phone')) return false;
  return true;
}

// 노션 rich_text/title 은 조각이 여러 개로 쪼개질 수 있다 — [0] 만 읽으면 뒷부분이 조용히 잘린다.
const txt = (v) => (((v || {}).rich_text) || []).map((t) => t.plain_text).join('');
const ttl = (v) => (((v || {}).title) || []).map((t) => t.plain_text).join('');

function rowOf(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    name: ttl(p['반 이름']),
    school: ((p['학원'] || {}).select || {}).name || '',
    days: ((p['요일'] || {}).multi_select || []).map((d) => d.name),
    time: txt(p['시간']),
    target: txt(p['대상']),
    memo: txt(p['메모']),
    open: !!(p['공개'] || {}).checkbox,
  };
}

// 수정·삭제 전 「전」 값 확보. 실패해도 null 만 돌려주고 본 작업은 절대 막지 않는다.
async function snapshot(env, pageId) {
  try {
    const r = await fetch(NOTION + '/pages/' + pageId, { headers: nh(env) });
    if (!r.ok) return null;
    const d = await r.json();
    const row = rowOf(d);
    return {
      반이름: row.name,
      학원: row.school,
      요일: row.days.join(', '),
      시간: row.time,
      대상: row.target,
      메모: row.memo,
      공개: row.open,
      보관됨: !!d.archived,
    };
  } catch (_) { return null; }
}

// 요일은 순서가 뒤섞이면 화면이 「수·월·금」처럼 읽힌다 — 저장할 때 한 번 정렬해 둔다.
const DAY_ORDER = ['월', '화', '수', '목', '금', '토', '일'];
function sortDays(list) {
  return list.slice().sort((a, b) => {
    const ia = DAY_ORDER.indexOf(a), ib = DAY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

// 들어온 칸만 노션 속성으로 바꾼다. undefined 는 「안 건드림」이다(빈 문자열 ''는 진짜 비우기).
function buildProps(body) {
  const props = {};
  if (typeof body.name === 'string') {
    props['반 이름'] = { title: [{ text: { content: body.name.slice(0, 200) } }] };
  }
  if (typeof body.school === 'string') {
    // 빈 값이면 select 를 비운다(노션은 null 로 비움). ''를 이름으로 넣으면 400 이 난다.
    const s = body.school.trim().replace(/,/g, ' ').slice(0, 100);
    props['학원'] = { select: s ? { name: s } : null };
  }
  if (Array.isArray(body.days)) {
    // ⚠️ 노션 multi_select 옵션 이름에는 쉼표를 못 넣는다(넣으면 400).
    const list = sortDays(body.days.filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim()))
      .map((d) => ({ name: d.replace(/,/g, ' ').slice(0, 100) }))
      .slice(0, 7);
    props['요일'] = { multi_select: list };
  }
  if (typeof body.time === 'string') {
    props['시간'] = { rich_text: [{ text: { content: body.time.slice(0, 500) } }] };
  }
  if (typeof body.target === 'string') {
    props['대상'] = { rich_text: [{ text: { content: body.target.slice(0, 500) } }] };
  }
  if (typeof body.memo === 'string') {
    props['메모'] = { rich_text: [{ text: { content: body.memo.slice(0, 1900) } }] };
  }
  if (typeof body.open === 'boolean') {
    props['공개'] = { checkbox: body.open };
  }
  return props;
}

export async function onRequest({ request, env }) {
  if (!auth(request, env)) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  try {
    // ── 목록 (비공개 포함 전 행) ──────────────────────────────────────────
    if (request.method === 'GET') {
      const r = await fetch(NOTION + '/databases/' + DB + '/query', {
        method: 'POST',
        headers: nh(env),
        body: JSON.stringify({ page_size: 100 }),
      });
      const d = await r.json();
      if (!r.ok || d.object === 'error') {
        return safeError(d, null, { message: '시간표를 불러오지 못했습니다.' });
      }
      return Response.json({ ok: true, classes: (d.results || []).map(rowOf) });
    }

    // ── 새 반 ────────────────────────────────────────────────────────────
    if (request.method === 'POST') {
      const body = await request.json();
      if (!body || typeof body.name !== 'string' || !body.name.trim()) {
        return Response.json({ error: '반 이름을 입력해주세요.' }, { status: 400 });
      }
      const props = buildProps(body);
      if (!props['공개']) props['공개'] = { checkbox: false };   // 반쯤 채운 행이 실수로 홈에 뜨지 않게

      const r = await fetch(NOTION + '/pages', {
        method: 'POST',
        headers: nh(env),
        body: JSON.stringify({ parent: { database_id: DB }, properties: props }),
      });
      const d = await r.json();
      if (!r.ok || d.object === 'error') {
        return safeError(d, null, { message: '시간표 저장에 실패했습니다.' });
      }

      await logAudit(env, request, {
        action: 'timetable.create',
        target: String(d.id || ''), targetName: body.name,
        summary: '시간표 반 추가 [' + body.name + ']'
          + (body.school ? ' · ' + body.school : '')
          + (Array.isArray(body.days) && body.days.length ? ' · ' + sortDays(body.days).join('') : '')
          + (body.time ? ' ' + body.time : '')
          + ' · ' + (props['공개'].checkbox ? '공개' : '비공개'),
        detail: {
          노션페이지id: d.id || '',
          반이름: body.name,
          학원: typeof body.school === 'string' ? body.school : '',
          요일: Array.isArray(body.days) ? sortDays(body.days) : [],
          시간: typeof body.time === 'string' ? body.time : '',
          대상: typeof body.target === 'string' ? body.target : '',
          메모: typeof body.memo === 'string' ? body.memo : '',
          공개: props['공개'].checkbox,
        },
      });
      return Response.json({ ok: true, id: d.id });
    }

    // ── 수정 ─────────────────────────────────────────────────────────────
    if (request.method === 'PATCH') {
      const body = await request.json();
      const pageId = body && body.pageId;
      if (!pageId) return Response.json({ error: 'pageId 필요' }, { status: 400 });

      const props = buildProps(body);
      if (!Object.keys(props).length) {
        return Response.json({ error: '바꿀 내용이 없습니다.' }, { status: 400 });
      }
      // 🔎 덮어쓰기 전에 원본을 읽어 둔다 — 안 하면 「전」 값이 영영 사라진다.
      const before = await snapshot(env, pageId);

      const r = await fetch(NOTION + '/pages/' + pageId, {
        method: 'PATCH',
        headers: nh(env),
        body: JSON.stringify({ properties: props }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        return safeError(err, null, { message: '시간표 수정에 실패했습니다.' });
      }

      // 📓 칸별 전/후. 원본을 못 읽었으면 그 사실도 그대로 남긴다 — 조용히 넘기지 않는다.
      const after = before ? { ...before } : null;
      if (after) {
        if (typeof body.name === 'string') after.반이름 = body.name;
        if (typeof body.school === 'string') after.학원 = body.school.trim();
        if (Array.isArray(body.days)) {
          after.요일 = sortDays(body.days.filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim())).join(', ');
        }
        if (typeof body.time === 'string') after.시간 = body.time;
        if (typeof body.target === 'string') after.대상 = body.target;
        if (typeof body.memo === 'string') after.메모 = body.memo;
        if (props['공개']) after.공개 = props['공개'].checkbox;
      }
      const df = after ? diffFields(before, after, ['반이름', '학원', '요일', '시간', '대상', '메모', '공개']) : null;

      await logAudit(env, request, {
        action: 'timetable.update',
        target: String(pageId),
        targetName: (before && before.반이름) || (typeof body.name === 'string' ? body.name : ''),
        summary: '시간표 수정 [' + ((before && before.반이름) || pageId) + '] — '
          + (df ? (df.요약 || '변경 없음') : '수정 전 원본을 못 읽음'),
        detail: {
          노션페이지id: pageId,
          수정전: before || '(노션에서 원본을 못 읽음 — 전 값 확보 실패)',
          바뀐칸: df ? df.바뀐칸 : [],
          변경: df ? df.변경 : {},
          보낸값: {
            반이름: typeof body.name === 'string' ? body.name : '(안 보냄)',
            학원: typeof body.school === 'string' ? body.school : '(안 보냄)',
            요일: Array.isArray(body.days) ? sortDays(body.days).join(', ') : '(안 보냄)',
            시간: typeof body.time === 'string' ? body.time : '(안 보냄)',
            대상: typeof body.target === 'string' ? body.target : '(안 보냄)',
            메모: typeof body.memo === 'string' ? body.memo : '(안 보냄)',
            공개: props['공개'] ? props['공개'].checkbox : '(안 보냄)',
          },
          공개바뀜: !!(df && df.바뀐칸 && df.바뀐칸.includes('공개')),
        },
      });
      return Response.json({ ok: true });
    }

    // ── 삭제(노션 보관) ──────────────────────────────────────────────────
    if (request.method === 'DELETE') {
      const body = await request.json();
      const pageId = body && body.pageId;
      if (!pageId) return Response.json({ error: 'pageId 필요' }, { status: 400 });

      // 지우기 전 값을 통째로 남긴다. 노션 휴지통 복원은 기한이 있어 이 로그가 즉시 근거다.
      const gone = await snapshot(env, pageId);
      const r = await fetch(NOTION + '/pages/' + pageId, {
        method: 'PATCH',
        headers: nh(env),
        body: JSON.stringify({ archived: true }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        return safeError(err, null, { message: '시간표 삭제에 실패했습니다.' });
      }

      await logAudit(env, request, {
        action: 'timetable.delete',
        target: String(pageId), targetName: (gone && gone.반이름) || '',
        summary: '시간표 반 삭제 [' + ((gone && gone.반이름) || pageId) + ']'
          + (gone && gone.학원 ? ' · ' + gone.학원 : '')
          + (gone && gone.공개 ? ' · ⚠️ 홈에 공개 중이던 반' : ''),
        detail: {
          노션페이지id: pageId,
          지워진반: gone || '(노션에서 원본을 못 읽음)',
          공개중이었음: !!(gone && gone.공개),
          비고: '노션 archived=true 처리 — 노션 휴지통에서 일정 기간 복원 가능. 홈 화면에서는 즉시 사라짐.',
        },
      });
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
