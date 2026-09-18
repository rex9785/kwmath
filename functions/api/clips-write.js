// /api/clips-write — 홈 화면 「릴스 클립」 카드의 쓰기 API (관리자 전용)
// ═══════════════════════════════════════════════════════════════════════════
// 왜 만들었나 (2026-09-18, 관우T 결정)
//   클립은 읽기 API(clips.js)만 있었다. 제목 한 줄을 고치려 해도 노션 앱을 열어야 했고,
//   그게 「계속 노션을 쓰는 게 맞냐」는 질문의 진짜 이유였다.
//   → 저장소(노션 DB)는 그대로 두고 **편집 화면만** kwmath admin 안으로 들여온다.
//     노션을 걷어내면 클립을 고칠 방법 자체가 사라지므로 걷어내는 쪽이 오히려 손해였다.
//
// clips.js(공개용)와 무엇이 다른가
//   clips.js : 공개=true 인 행만 · 인증 없음 · 홈 화면이 부른다.
//   여기 GET : 공개 여부와 무관하게 **전 행** · 관리자 인증 필수 · admin 편집 화면이 부른다.
//     ⚠️ 비공개 행까지 보여줘야 하는 이유 — 안 그러면 한 번 내린 클립을 화면에서
//        다시 올릴 방법이 영영 없어진다(내리는 순간 목록에서 사라져 버림).
//
// 속성 이름은 노션 DB와 글자 단위로 같아야 한다 (2026-09-18 실물 확인):
//   제목(title) · 인스타 릴스 ID(rich_text) · 썸네일 설명(rich_text)
//   · 주제 태그(multi_select) · 순서(number) · 공개(checkbox)

import { safeError } from './_errors.js';
import { logAudit, diffFields } from './_auditlog.js';

const DB = '9784fd34c91543c7b2c4cca4db1911aa';
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
//   _middleware.js 의 STAFF_GET_BLOCK 이 '/api/clips-write'를 막지만, 미들웨어 한 겹만 믿지 않는다.
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
  const ord = (p['순서'] || {}).number;
  return {
    id: page.id,
    title: ttl(p['제목']),
    reelId: txt(p['인스타 릴스 ID']),
    desc: txt(p['썸네일 설명']),
    tags: ((p['주제 태그'] || {}).multi_select || []).map((t) => t.name),
    order: ord == null ? 0 : ord,
    open: !!(p['공개'] || {}).checkbox,
  };
}

// 수정·삭제 전 「전」 값 확보. 실패해도 null 만 돌려주고 본 작업(수정·삭제)은 절대 막지 않는다.
async function snapshot(env, pageId) {
  try {
    const r = await fetch(NOTION + '/pages/' + pageId, { headers: nh(env) });
    if (!r.ok) return null;
    const d = await r.json();
    const row = rowOf(d);
    return {
      제목: row.title,
      릴스ID: row.reelId,
      설명: row.desc,
      태그: row.tags.join(', '),
      순서: row.order,
      공개: row.open,
      보관됨: !!d.archived,
    };
  } catch (_) { return null; }
}

// 들어온 칸만 노션 속성으로 바꾼다. undefined 는 「안 건드림」이다(빈 문자열 ''는 진짜 비우기).
function buildProps(body) {
  const props = {};
  if (typeof body.title === 'string') {
    props['제목'] = { title: [{ text: { content: body.title.slice(0, 200) } }] };
  }
  if (typeof body.reelId === 'string') {
    props['인스타 릴스 ID'] = { rich_text: [{ text: { content: body.reelId.trim().slice(0, 200) } }] };
  }
  if (typeof body.desc === 'string') {
    props['썸네일 설명'] = { rich_text: [{ text: { content: body.desc.slice(0, 1900) } }] };
  }
  if (Array.isArray(body.tags)) {
    // ⚠️ 노션 multi_select 옵션 이름에는 쉼표를 못 넣는다(넣으면 400). 공백으로 바꿔 통과시킨다.
    const list = body.tags
      .filter((t) => typeof t === 'string' && t.trim())
      .map((t) => ({ name: t.trim().replace(/,/g, ' ').slice(0, 100) }))
      .slice(0, 10);
    props['주제 태그'] = { multi_select: list };
  }
  if (body.order !== undefined && body.order !== null && body.order !== '') {
    const n = Number(body.order);
    if (Number.isFinite(n)) props['순서'] = { number: n };
  }
  if (typeof body.open === 'boolean') {
    props['공개'] = { checkbox: body.open };
  }
  return props;
}

// 새 행의 기본 순서 = 지금 있는 것 중 가장 큰 값 + 1.
//   안 하면 새 행이 전부 0 이 되어 홈 화면 배열이 뒤죽박죽이 된다.
async function nextOrder(env) {
  try {
    const r = await fetch(NOTION + '/databases/' + DB + '/query', {
      method: 'POST',
      headers: nh(env),
      body: JSON.stringify({ sorts: [{ property: '순서', direction: 'descending' }], page_size: 1 }),
    });
    if (!r.ok) return 1;
    const d = await r.json();
    const top = (d.results || [])[0];
    if (!top) return 1;
    const n = ((top.properties || {})['순서'] || {}).number;
    return Number.isFinite(n) ? n + 1 : 1;
  } catch (_) { return 1; }
}

export async function onRequest({ request, env }) {
  if (!auth(request, env)) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  try {
    // ── 목록 (비공개 포함 전 행) ──────────────────────────────────────────
    if (request.method === 'GET') {
      const r = await fetch(NOTION + '/databases/' + DB + '/query', {
        method: 'POST',
        headers: nh(env),
        body: JSON.stringify({ sorts: [{ property: '순서', direction: 'ascending' }], page_size: 100 }),
      });
      const d = await r.json();
      if (!r.ok || d.object === 'error') {
        return safeError(d, null, { message: '클립 목록을 불러오지 못했습니다.' });
      }
      return Response.json({ ok: true, clips: (d.results || []).map(rowOf) });
    }

    // ── 새 클립 ──────────────────────────────────────────────────────────
    if (request.method === 'POST') {
      const body = await request.json();
      if (!body || typeof body.title !== 'string' || !body.title.trim()) {
        return Response.json({ error: '제목을 입력해주세요.' }, { status: 400 });
      }
      const props = buildProps(body);
      if (!props['공개']) props['공개'] = { checkbox: false };   // 반쯤 채운 행이 실수로 홈에 뜨지 않게
      if (!props['순서']) props['순서'] = { number: await nextOrder(env) };

      const r = await fetch(NOTION + '/pages', {
        method: 'POST',
        headers: nh(env),
        body: JSON.stringify({ parent: { database_id: DB }, properties: props }),
      });
      const d = await r.json();
      if (!r.ok || d.object === 'error') {
        return safeError(d, null, { message: '클립 저장에 실패했습니다.' });
      }

      await logAudit(env, request, {
        action: 'clip.create',
        target: String(d.id || ''), targetName: body.title,
        summary: '홈 클립 추가 [' + body.title + ']'
          + (body.reelId ? ' · 릴스 ' + body.reelId : ' · ⚠️ 릴스 ID 없음')
          + ' · ' + (props['공개'].checkbox ? '공개' : '비공개'),
        detail: {
          노션페이지id: d.id || '',
          제목: body.title,
          릴스ID: typeof body.reelId === 'string' ? body.reelId : '',
          설명: typeof body.desc === 'string' ? body.desc : '',
          태그: Array.isArray(body.tags) ? body.tags : [],
          순서: props['순서'].number,
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
        return safeError(err, null, { message: '클립 수정에 실패했습니다.' });
      }

      // 📓 칸별 전/후. 원본을 못 읽었으면 그 사실도 그대로 남긴다 — 조용히 넘기지 않는다.
      const after = before ? { ...before } : null;
      if (after) {
        if (typeof body.title === 'string') after.제목 = body.title;
        if (typeof body.reelId === 'string') after.릴스ID = body.reelId.trim();
        if (typeof body.desc === 'string') after.설명 = body.desc;
        if (Array.isArray(body.tags)) {
          after.태그 = body.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()).join(', ');
        }
        if (props['순서']) after.순서 = props['순서'].number;
        if (props['공개']) after.공개 = props['공개'].checkbox;
      }
      const df = after ? diffFields(before, after, ['제목', '릴스ID', '설명', '태그', '순서', '공개']) : null;

      await logAudit(env, request, {
        action: 'clip.update',
        target: String(pageId),
        targetName: (before && before.제목) || (typeof body.title === 'string' ? body.title : ''),
        summary: '홈 클립 수정 [' + ((before && before.제목) || pageId) + '] — '
          + (df ? (df.요약 || '변경 없음') : '수정 전 원본을 못 읽음'),
        detail: {
          노션페이지id: pageId,
          수정전: before || '(노션에서 원본을 못 읽음 — 전 값 확보 실패)',
          바뀐칸: df ? df.바뀐칸 : [],
          변경: df ? df.변경 : {},
          보낸값: {
            제목: typeof body.title === 'string' ? body.title : '(안 보냄)',
            릴스ID: typeof body.reelId === 'string' ? body.reelId : '(안 보냄)',
            설명: typeof body.desc === 'string' ? body.desc : '(안 보냄)',
            태그: Array.isArray(body.tags) ? body.tags.join(', ') : '(안 보냄)',
            순서: props['순서'] ? props['순서'].number : '(안 보냄)',
            공개: props['공개'] ? props['공개'].checkbox : '(안 보냄)',
          },
          릴스ID바뀜: !!(df && df.바뀐칸 && df.바뀐칸.includes('릴스ID')),
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
        return safeError(err, null, { message: '클립 삭제에 실패했습니다.' });
      }

      await logAudit(env, request, {
        action: 'clip.delete',
        target: String(pageId), targetName: (gone && gone.제목) || '',
        summary: '홈 클립 삭제 [' + ((gone && gone.제목) || pageId) + ']'
          + (gone && gone.릴스ID ? ' · 릴스 ' + gone.릴스ID : ''),
        detail: {
          노션페이지id: pageId,
          지워진클립: gone || '(노션에서 원본을 못 읽음)',
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
