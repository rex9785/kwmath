// /api/reviews — 수강 후기 (학생/학부모 작성, 관리자 승인 후 노출)
//
// GET  /api/reviews?public=1   퍼블릭. 승인+메인노출 후기 목록 (메인 홈피용)
// GET  /api/reviews?mine=1     토큰. 본인이 작성한 후기
// GET  /api/reviews            토큰. 승인된 모든 후기 (포털 후기 탭용)
// GET  /api/reviews?admin=1    admin. 승인 상태 무관 전체 (대기/승인/거절 다)
// POST /api/reviews            토큰. 새 후기 작성 (대기 상태로 들어감)
//   body: { authorType: '학생'|'학부모', authorName?: string, content: string }
// DELETE /api/reviews?id=...   토큰. 본인 후기 삭제 (대기 상태일 때만)
// PATCH  /api/reviews?id=...   admin. { status: '승인'|'거절'|'대기', mainShow?: boolean, memo?: string }

import { requireAuth, fetchStudentsByPhone, normalizePhone } from './_auth.js';

const REVIEWS_DB = 'cafcab7fffd746d7948daf7c206820bd';

function jsonOk(data, status = 200) { return Response.json(data, { status }); }
function jsonErr(msg, status = 400)  { return Response.json({ error: msg }, { status }); }

function notionHeaders(env) {
  return {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
}
const rtText = (rt) => (rt || []).map(t => t.plain_text || '').join('');
const ttText = (rt) => (rt || []).map(t => t.plain_text || '').join('');

function pageToReview(page) {
  const p = page.properties || {};
  return {
    id:         page.id,
    title:      ttText(p['제목']?.title),
    content:    rtText(p['내용']?.rich_text),
    authorName: rtText(p['작성자 이름']?.rich_text),
    authorType: p['작성자 유형']?.select?.name || '',
    authorPhone: rtText(p['작성자 휴대폰']?.rich_text),
    studentName: rtText(p['학생 이름']?.rich_text),
    className:  rtText(p['반']?.rich_text),
    status:     p['승인 상태']?.select?.name || '대기',
    mainShow:   p['메인 노출']?.checkbox === true,
    memo:       rtText(p['처리 메모']?.rich_text),
    createdAt:  p['작성일']?.created_time || '',
    updatedAt:  p['수정일']?.last_edited_time || '',
  };
}

async function queryReviews(env, filter, sorts) {
  const res = await fetch(`https://api.notion.com/v1/databases/${REVIEWS_DB}/query`, {
    method: 'POST', headers: notionHeaders(env),
    body: JSON.stringify({
      filter: filter || undefined,
      sorts: sorts || [{ property: '작성일', direction: 'descending' }],
      page_size: 100,
    }),
  });
  const data = await res.json();
  if (data.object === 'error') throw new Error(data.message || 'Notion 조회 실패');
  return (data.results || []).filter(p => !p.archived && !p.in_trash).map(pageToReview);
}

// 메인 홈피 노출용 이름 마스킹 (가운데 1글자만 O)
// 박지영 → 박O영, 이지민영 → 이지O영
function maskName(name) {
  const n = (name || '').toString().trim();
  if (!n) return '익명';
  if (n.length === 1) return n;
  if (n.length === 2) return n[0] + 'O';
  const mid = Math.floor(n.length / 2);
  return n.slice(0, mid) + 'O' + n.slice(mid + 1);
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;

  try {
    // ────────────────────────────  GET  ────────────────────────────
    if (method === 'GET') {
      // 1) 퍼블릭: 메인 페이지에서 호출 — 인증 불필요
      if (url.searchParams.get('public') === '1') {
        const list = await queryReviews(env, {
          and: [
// status 필터 제거 — 모든 후기 자동 승인
            { property: '메인 노출', checkbox: { equals: true } },
          ],
        });
        // 퍼블릭 응답: 휴대폰 제거 + 이름 마스킹
        // 학생: 본인 이름 마스킹 → "박O영 학생"
        // 학부모: 자녀 이름 마스킹 → "이O재 학부모님" (학부모 본인 이름 X)
        return jsonOk({
          reviews: list.map(r => {
            const sourceName = (r.authorType === '학부모')
              ? (r.studentName || r.authorName || '')   // 학부모 후기 → 자녀 이름
              : (r.authorName || r.studentName || '');  // 학생 후기 → 본인 이름
            return {
              id: r.id,
              content: r.content,
              authorName: maskName(sourceName),  // 마스킹된 이름
              authorType: r.authorType,
              className: r.className,
              createdAt: r.createdAt,
            };
          }),
        });
      }

      // 2) admin 전체 조회
      if (url.searchParams.get('admin') === '1') {
        if (!isAdmin) return jsonErr('관리자 인증이 필요합니다.', 401);
        const list = await queryReviews(env, null);
        return jsonOk({ reviews: list });
      }

      // 3) 본인 후기 또는 포털 후기 탭 (둘 다 토큰 필요)
      const auth = await requireAuth(env, request);
      if (!auth.ok) return auth.response;

      if (url.searchParams.get('mine') === '1') {
        const list = await queryReviews(env, {
          property: '작성자 휴대폰', rich_text: { equals: auth.phone },
        });
        return jsonOk({ reviews: list });
      }
      // 포털 후기 탭: 승인된 것만
      const list = await queryReviews(env, {
// status 필터 제거
      });
      return jsonOk({
        reviews: list.map(r => ({
          id: r.id, content: r.content, authorName: r.authorName,
          authorType: r.authorType, className: r.className, createdAt: r.createdAt,
        })),
      });
    }

    // ────────────────────────────  POST  ────────────────────────────
    if (method === 'POST') {
      const auth = await requireAuth(env, request);
      if (!auth.ok) return auth.response;

      const body = await request.json().catch(() => ({}));
      const authorType = (body.authorType || '').trim();
      const content    = (body.content || '').trim();
      const inputName  = (body.authorName || '').trim();

      if (!['학생', '학부모'].includes(authorType)) {
        return jsonErr('작성자 유형은 학생 또는 학부모여야 합니다.');
      }
      if (!content) return jsonErr('후기 내용을 입력해주세요.');
      if (content.length > 2000) return jsonErr('후기는 2000자 이하로 작성해주세요.');

      // 휴대폰으로 학생 매칭 — 첫 학생 정보로 학생 이름/반 자동 채움
      const students = await fetchStudentsByPhone(env, auth.phone);
      const firstStudent = students[0] || null;
      const studentName  = firstStudent?.name || '';
      const className    = firstStudent?.className || '';

      // 작성자 이름 결정
      let authorName = inputName;
      if (!authorName) {
        authorName = authorType === '학생'
          ? (studentName || '학생')
          : (studentName ? `${studentName} 학부모` : '학부모');
      }
      if (authorName.length > 40) authorName = authorName.slice(0, 40);

      // 제목: 작성자 + 작성일
      const today = new Date().toISOString().slice(0, 10);
      const title = `${authorName} (${today})`;

      const createRes = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: notionHeaders(env),
        body: JSON.stringify({
          parent: { database_id: REVIEWS_DB },
          properties: {
            '제목':         { title:     [{ text: { content: title } }] },
            '내용':         { rich_text: [{ text: { content: content } }] },
            '작성자 이름':  { rich_text: [{ text: { content: authorName } }] },
            '작성자 유형':  { select:    { name: authorType } },
            '작성자 휴대폰': { rich_text: [{ text: { content: auth.phone } }] },
            '학생 이름':    { rich_text: [{ text: { content: studentName } }] },
            '반':           { rich_text: [{ text: { content: className } }] },
            '승인 상태':    { select:    { name: '승인' } },
            '메인 노출':    { checkbox:  false },
          },
        }),
      });
      const created = await createRes.json();
      if (created.object === 'error') return jsonErr(created.message || '후기 등록 실패', 500);

      return jsonOk({ ok: true, id: created.id, status: '대기' });
    }

    // ────────────────────────────  DELETE  ────────────────────────────
    if (method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return jsonErr('id가 필요합니다.');

      // admin이면 무조건 삭제 가능
      let allow = isAdmin;
      let phoneCheck = null;

      if (!allow) {
        const auth = await requireAuth(env, request);
        if (!auth.ok) return auth.response;
        phoneCheck = auth.phone;
      }

      // 페이지 정보 조회 — 본인 확인
      const pageRes = await fetch(`https://api.notion.com/v1/pages/${id}`, {
        method: 'GET', headers: notionHeaders(env),
      });
      const page = await pageRes.json();
      if (page.object === 'error') return jsonErr(page.message || '후기를 찾을 수 없습니다.', 404);

      const review = pageToReview(page);
      if (!allow) {
        // 본인이 작성한 후기는 언제든 삭제 가능 (자동 승인 정책 후 대기 상태 가드 제거)
        if (review.authorPhone !== phoneCheck) {
          return jsonErr('본인이 작성한 후기만 삭제할 수 있습니다.', 403);
        }
      }

      // archive
      const archRes = await fetch(`https://api.notion.com/v1/pages/${id}`, {
        method: 'PATCH', headers: notionHeaders(env),
        body: JSON.stringify({ archived: true }),
      });
      const archived = await archRes.json();
      if (archived.object === 'error') return jsonErr(archived.message || '삭제 실패', 500);

      return jsonOk({ ok: true });
    }

    // ────────────────────────────  PATCH  ────────────────────────────
    if (method === 'PATCH') {
      if (!isAdmin) return jsonErr('관리자 인증이 필요합니다.', 401);

      const id = url.searchParams.get('id');
      if (!id) return jsonErr('id가 필요합니다.');

      const body = await request.json().catch(() => ({}));
      const props = {};

      if (body.status) {
        if (!['대기', '승인', '거절'].includes(body.status)) {
          return jsonErr('승인 상태는 대기/승인/거절 중 하나여야 합니다.');
        }
        props['승인 상태'] = { select: { name: body.status } };
        // 거절/대기로 바꾸면 메인 노출 자동 off (안전망)
        if (body.status !== '승인' && body.mainShow === undefined) {
          props['메인 노출'] = { checkbox: false };
        }
      }
      if (body.mainShow !== undefined) {
        props['메인 노출'] = { checkbox: body.mainShow === true };
      }
      if (body.memo !== undefined) {
        props['처리 메모'] = { rich_text: [{ text: { content: String(body.memo).slice(0, 500) } }] };
      }

      if (!Object.keys(props).length) return jsonErr('변경할 내용이 없습니다.');

      const patchRes = await fetch(`https://api.notion.com/v1/pages/${id}`, {
        method: 'PATCH', headers: notionHeaders(env),
        body: JSON.stringify({ properties: props }),
      });
      const updated = await patchRes.json();
      if (updated.object === 'error') return jsonErr(updated.message || '수정 실패', 500);

      return jsonOk({ ok: true });
    }

    return jsonErr('지원하지 않는 메소드입니다.', 405);
  } catch (err) {
    return jsonErr('서버 오류: ' + (err.message || err), 500);
  }
}
