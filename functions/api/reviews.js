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
import { safeError, logError } from './_errors.js';
import { logAudit, diffFields } from './_auditlog.js';

const REVIEWS_DB = 'cafcab7fffd746d7948daf7c206820bd';

// 로그에 담을 때만 긴 본문을 자른다(저장된 원문은 그대로). detail은 JSON 2만자에서 잘려 깨지므로 미리 막는다.
function clip(s, n = 3000) {
  const v = s == null ? '' : String(s);
  return v.length > n ? v.slice(0, n) + '…(잘림)' : v;
}

// 후기 1건을 로그용 한글 표로. 승인상태·메인노출·처리메모는 PATCH가 통째로 덮어쓰는 칸이라 전/후 비교에 쓴다.
function reviewForLog(r) {
  if (!r) return null;
  return {
    승인상태: r.status || '',
    메인노출: r.mainShow ? '예' : '아니오',
    처리메모: clip(r.memo, 1000),
  };
}

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
            // 🔒 2026-08-02 — 「승인」된 후기만 메인에 나간다.
            //    이 줄이 빠져 있던 동안에는 「메인 노출」 체크만 보고 있어서,
            //    "거절"한 후기도 노출이 켜져 있으면 홈페이지에 그대로 공개됐다.
            { property: '승인 상태', select: { equals: '승인' } },
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
      // ⚠️ 2026-08-02 — 여기가 빈 객체 {} 였다. {}는 truthy라 queryReviews의
      //    `filter || undefined`를 통과해 노션에 filter:{} 로 그대로 나갔고,
      //    결과적으로 대기·거절 후기까지 전부 포털에 보였다.
      const list = await queryReviews(env, {
        property: '승인 상태', select: { equals: '승인' },
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
      if (!auth.ok) {
        await logAudit(env, request, {
          action: 'review.create.denied',
          summary: '후기 작성 거부(401) — 로그인 토큰 없음/만료',
          detail: { 결과: '아무것도 저장되지 않음', 비고: '토큰 원문은 로그에 담지 않는다' },
        });
        return auth.response;
      }

      const body = await request.json().catch(() => ({}));
      const authorType = (body.authorType || '').trim();
      const content    = (body.content || '').trim();
      const inputName  = (body.authorName || '').trim();

      // 반려(400)도 남긴다 — "후기를 썼는데 안 올라간다"가 검증 반려인지 앱 오류인지 구분할 근거가 된다.
      const rejectReview = async (msg) => {
        await logAudit(env, request, {
          action: 'review.create.reject',
          actor: auth.phone, actorRole: authorType === '학부모' ? 'parent' : 'student',
          summary: '후기 작성 반려(400) — ' + msg,
          detail: {
            작성자휴대폰: auth.phone, 보낸작성자유형: authorType || '(안 보냄)',
            내용길이: content.length, 사유: msg, 결과: '아무것도 저장되지 않음',
          },
        });
        return jsonErr(msg);
      };

      if (!['학생', '학부모'].includes(authorType)) {
        return await rejectReview('작성자 유형은 학생 또는 학부모여야 합니다.');
      }
      if (!content) return await rejectReview('후기 내용을 입력해주세요.');
      if (content.length > 2000) return await rejectReview('후기는 2000자 이하로 작성해주세요.');

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
      if (created.object === 'error') {
        logError(created);
        await logAudit(env, request, {
          action: 'review.create.fail',
          actor: auth.phone, actorRole: authorType === '학부모' ? 'parent' : 'student', actorName: authorName,
          targetName: studentName || authorName,
          summary: '후기 등록 실패(500) — 노션 저장 오류 [' + authorName + ']',
          detail: {
            작성자휴대폰: auth.phone, 작성자유형: authorType, 작성자이름: authorName,
            학생id: firstStudent ? String(firstStudent.id) : '(연결된 학생 없음)',
            학생이름: studentName || '', 반: className || '',
            내용길이: content.length, 내용: clip(content),
            노션오류: clip(created.message || created.code || '알 수 없는 오류', 300),
            결과: '후기가 저장되지 않음 — 작성자가 다시 써야 함',
          },
        });
        return jsonErr('후기 등록에 실패했습니다.', 500);
      }

      // 📓 2026-07-31 — 후기는 홈페이지 메인에 그대로 걸리는 글인데 작성 기록이 어디에도 안 남았다.
      //   나중에 "이 후기 누가 썼냐 / 언제 들어왔냐 / 원문이 뭐였냐"를 물으면
      //   노션 페이지가 지워진 뒤에는 답할 방법이 없다.
      await logAudit(env, request, {
        action: 'review.create',
        actor: auth.phone, actorRole: authorType === '학부모' ? 'parent' : 'student', actorName: authorName,
        target: String(created.id || ''), targetName: studentName || authorName,
        summary: '후기 작성 [' + authorName + ' · ' + authorType + '] — ' + clip(content, 80),
        detail: {
          후기id: String(created.id || ''),
          작성자휴대폰: auth.phone, 작성자유형: authorType, 작성자이름: authorName,
          학생id: firstStudent ? String(firstStudent.id) : '(연결된 학생 없음)',
          학생이름: studentName || '', 반: className || '',
          제목: title, 내용길이: content.length, 내용: clip(content),
          승인상태: '승인(현재 정책상 자동 승인 — 화면 응답만 "대기"로 나감)',
          메인노출: '아니오(원장이 켜야 홈페이지에 뜸)',
          지목방식: '작성자 휴대폰으로 찾은 **첫 학생**(students[0])을 학생 이름·반으로 붙임. '
            + '노션 후기에는 학생 id가 저장되지 않는다 — 자녀가 둘인 학부모면 엉뚱한 자녀가 붙을 수 있다(현 코드 그대로 둠).',
          효과: '이 후기는 포털 후기 탭에서 보이고, 원장이 「메인 노출」을 켜면 홈페이지 메인에 공개된다. '
            + '공개 시 이름은 마스킹되지만 반 이름은 그대로 나간다.',
        },
      });

      return jsonOk({ ok: true, id: created.id, status: '대기' });
    }

    // ────────────────────────────  DELETE  ────────────────────────────
    if (method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) {
        await logAudit(env, request, {
          action: 'review.delete.reject',
          summary: '후기 삭제 반려(400) — id가 없음',
          detail: { 결과: '아무것도 삭제되지 않음' },
        });
        return jsonErr('id가 필요합니다.');
      }

      // admin이면 무조건 삭제 가능
      let allow = isAdmin;
      let phoneCheck = null;

      if (!allow) {
        const auth = await requireAuth(env, request);
        if (!auth.ok) {
          await logAudit(env, request, {
            action: 'review.delete.denied',
            target: String(id),
            summary: '후기 삭제 거부(401) — 관리자도 아니고 로그인 토큰도 없음',
            detail: { 후기id: String(id), 결과: '아무것도 삭제되지 않음' },
          });
          return auth.response;
        }
        phoneCheck = auth.phone;
      }

      // 페이지 정보 조회 — 본인 확인
      const pageRes = await fetch(`https://api.notion.com/v1/pages/${id}`, {
        method: 'GET', headers: notionHeaders(env),
      });
      const page = await pageRes.json();
      if (page.object === 'error') {
        logError(page);
        await logAudit(env, request, {
          action: 'review.delete.miss',
          actor: phoneCheck || undefined, target: String(id),
          summary: '후기 삭제 실패(404) — 후기를 찾을 수 없음 (id ' + String(id).slice(0, 60) + ')',
          detail: {
            후기id: String(id), 요청자: isAdmin ? '관리자' : ('작성자 본인 확인 대상(' + (phoneCheck || '') + ')'),
            노션오류: clip(page.message || page.code || '알 수 없는 오류', 300),
            추정원인: '이미 지워졌거나 id가 틀림',
            결과: '아무것도 삭제되지 않음',
          },
        });
        return jsonErr('후기를 찾을 수 없습니다.', 404);
      }

      // ⚠️ 지우기 전 값 — 노션 페이지는 archive되면 화면에서 사라지므로 원문을 여기서 통째로 보관한다.
      const review = pageToReview(page);
      if (!allow) {
        // 본인이 작성한 후기는 언제든 삭제 가능 (자동 승인 정책 후 대기 상태 가드 제거)
        if (review.authorPhone !== phoneCheck) {
          // 🔴 남의 후기를 지우려 한 시도 — 원장이 알아야 할 사건이라 반드시 남긴다.
          await logAudit(env, request, {
            action: 'review.delete.denied',
            actor: phoneCheck, target: String(id), targetName: review.authorName || '',
            summary: '후기 삭제 거부(403) — 본인이 쓴 후기가 아님 (작성자 ' + (review.authorName || '?') + ')',
            detail: {
              후기id: String(id), 요청자휴대폰: phoneCheck || '',
              후기작성자: review.authorName || '', 후기작성자유형: review.authorType || '',
              내용앞부분: clip(review.content, 200),
              결과: '거부됨 — 후기는 그대로 남아 있음',
            },
          });
          return jsonErr('본인이 작성한 후기만 삭제할 수 있습니다.', 403);
        }
      }

      // archive
      const archRes = await fetch(`https://api.notion.com/v1/pages/${id}`, {
        method: 'PATCH', headers: notionHeaders(env),
        body: JSON.stringify({ archived: true }),
      });
      const archived = await archRes.json();
      if (archived.object === 'error') {
        logError(archived);
        await logAudit(env, request, {
          action: 'review.delete.fail',
          actor: phoneCheck || undefined, target: String(id), targetName: review.authorName || '',
          summary: '후기 삭제 실패(500) — 노션 archive 오류 [' + (review.authorName || id) + ']',
          detail: {
            후기id: String(id), 요청자: isAdmin ? '관리자' : ('작성자 본인(' + (phoneCheck || '') + ')'),
            후기작성자: review.authorName || '', 내용앞부분: clip(review.content, 200),
            노션오류: clip(archived.message || archived.code || '알 수 없는 오류', 300),
            결과: '후기는 그대로 남아 있음',
          },
        });
        return jsonErr('삭제에 실패했습니다.', 500);
      }

      // 🔴 후기 삭제는 되돌리기 어렵다(노션 archive). 지운 원문을 통째로 남겨야 복구·해명이 가능하다.
      await logAudit(env, request, {
        action: 'review.delete',
        actor: phoneCheck || undefined,
        actorRole: phoneCheck ? (review.authorType === '학부모' ? 'parent' : 'student') : undefined,
        target: String(id), targetName: review.authorName || '',
        summary: '후기 삭제 [' + (review.authorName || id) + ' · ' + (review.authorType || '') + '] — '
          + (isAdmin ? '관리자가 삭제' : '작성자 본인이 삭제') + ' · ' + clip(review.content, 60),
        detail: {
          후기id: String(id),
          지운사람: isAdmin ? '관리자(원장 또는 관리자 비밀번호)' : ('작성자 본인 ' + (phoneCheck || '')),
          후기작성자: review.authorName || '', 작성자유형: review.authorType || '',
          작성자휴대폰: review.authorPhone || '', 학생이름: review.studentName || '', 반: review.className || '',
          승인상태: review.status || '', 메인노출: review.mainShow ? '예' : '아니오',
          처리메모: clip(review.memo, 1000),
          작성일: review.createdAt || '', 내용: clip(review.content),
          효과: '노션에서 archive되어 포털 후기 탭·홈페이지 메인에서 즉시 사라진다. '
            + '위 「내용」이 원문 사본이다(노션 휴지통에서도 지워지면 이 로그가 유일한 기록).',
        },
      });

      return jsonOk({ ok: true });
    }

    // ────────────────────────────  PATCH  ────────────────────────────
    if (method === 'PATCH') {
      if (!isAdmin) {
        await logAudit(env, request, {
          action: 'review.update.denied',
          target: String(url.searchParams.get('id') || ''),
          summary: '후기 승인/노출 변경 거부(401) — 관리자 인증 없음',
          detail: { 후기id: String(url.searchParams.get('id') || ''), 결과: '아무것도 바뀌지 않음' },
        });
        return jsonErr('관리자 인증이 필요합니다.', 401);
      }

      const id = url.searchParams.get('id');
      if (!id) {
        await logAudit(env, request, {
          action: 'review.update.reject',
          summary: '후기 수정 반려(400) — id가 없음',
          detail: { 결과: '아무것도 바뀌지 않음' },
        });
        return jsonErr('id가 필요합니다.');
      }

      const body = await request.json().catch(() => ({}));
      const props = {};

      const rejectPatch = async (msg) => {
        await logAudit(env, request, {
          action: 'review.update.reject',
          target: String(id),
          summary: '후기 수정 반려(400) — ' + msg,
          detail: {
            후기id: String(id), 사유: msg,
            보낸값: {
              승인상태: body.status === undefined ? '(안 보냄)' : String(body.status).slice(0, 30),
              메인노출: body.mainShow === undefined ? '(안 보냄)' : (body.mainShow === true ? '예' : '아니오'),
              처리메모: body.memo === undefined ? '(안 보냄)' : clip(body.memo, 500),
            },
            결과: '아무것도 바뀌지 않음',
          },
        });
        return jsonErr(msg);
      };

      if (body.status) {
        if (!['대기', '승인', '거절'].includes(body.status)) {
          return await rejectPatch('승인 상태는 대기/승인/거절 중 하나여야 합니다.');
        }
        props['승인 상태'] = { select: { name: body.status } };
        // (메인 노출 자동 off 안전망은 아래 before 조회 뒤로 옮겼다 — 「🔒 2026-08-02 안전망」 참고.
        //  여기서 끄면 뒤따르는 body.mainShow 처리에 다시 덮어써졌다.)
      }
      if (body.mainShow !== undefined) {
        props['메인 노출'] = { checkbox: body.mainShow === true };
      }
      if (body.memo !== undefined) {
        props['처리 메모'] = { rich_text: [{ text: { content: String(body.memo).slice(0, 500) } }] };
      }

      if (!Object.keys(props).length) return await rejectPatch('변경할 내용이 없습니다.');

      // 🔎 덮어쓰기 전 값을 읽어 둔다 — 승인상태·메인노출·처리메모는 통째로 덮어써져서
      //    이 조회가 없으면 "원래 뭐였는지"가 영영 사라진다(노션은 예전 값을 안 돌려준다).
      //    ⚠️ 로그용 조회라 실패해도 본 작업은 그대로 진행한다.
      let before = null;
      try {
        const beforeRes = await fetch(`https://api.notion.com/v1/pages/${id}`, {
          method: 'GET', headers: notionHeaders(env),
        });
        const beforePage = await beforeRes.json();
        if (beforePage && beforePage.object !== 'error') before = pageToReview(beforePage);
      } catch (_) { /* 로그용 — 실패해도 무시 */ }

      // 🔒 2026-08-02 안전망 — 「승인」이 아닌 후기는 메인에 노출될 수 없다.
      //    예전 안전망은 `body.mainShow === undefined` 일 때만 껐기 때문에
      //    { status:'거절', mainShow:true } 를 같이 보내면 거절인데 노출 ON 으로 남았다.
      //    이제는 최종 승인 상태가 '승인'이 아니면 보낸 mainShow 를 무시하고 무조건 끈다.
      //    (현재 상태를 못 읽은 경우엔 건드리지 않는다 — 메모만 고치는 요청에서
      //     멀쩡한 노출이 꺼지는 부작용을 막기 위함.)
      const finalStatus = body.status || (before ? before.status : null);
      if (finalStatus && finalStatus !== '승인') {
        props['메인 노출'] = { checkbox: false };
      }

      const patchRes = await fetch(`https://api.notion.com/v1/pages/${id}`, {
        method: 'PATCH', headers: notionHeaders(env),
        body: JSON.stringify({ properties: props }),
      });
      const updated = await patchRes.json();
      if (updated.object === 'error') {
        logError(updated);
        await logAudit(env, request, {
          action: 'review.update.fail',
          target: String(id), targetName: (before && before.authorName) || '',
          summary: '후기 수정 실패(500) — 노션 저장 오류 [' + ((before && before.authorName) || id) + ']',
          detail: {
            후기id: String(id), 이전값: reviewForLog(before) || '(이전 값을 읽지 못함)',
            시도한값: {
              승인상태: body.status === undefined ? '(안 보냄)' : String(body.status).slice(0, 30),
              메인노출: body.mainShow === undefined ? '(안 보냄)' : (body.mainShow === true ? '예' : '아니오'),
              처리메모: body.memo === undefined ? '(안 보냄)' : clip(body.memo, 500),
            },
            노션오류: clip(updated.message || updated.code || '알 수 없는 오류', 300),
            결과: '후기 상태는 예전 값 그대로',
          },
        });
        return jsonErr('수정에 실패했습니다.', 500);
      }

      // 📓 2026-07-31 — 「메인 노출」을 켜면 그 후기가 홈페이지 메인에 즉시 걸린다. 끄면 즉시 내려간다.
      //   지금까지 누가 켰고 껐는지가 아무 데도 안 남아서, 학부모가 "내 후기가 왜 홈페이지에 있냐"고 물으면
      //   답할 근거가 없었다. 처리 메모도 통째로 덮어써지므로 전/후를 같이 남긴다.
      const after = pageToReview(updated);
      const d = diffFields(reviewForLog(before), reviewForLog(after), ['승인상태', '메인노출', '처리메모']);
      await logAudit(env, request, {
        action: 'review.update',
        target: String(id), targetName: after.authorName || (before && before.authorName) || '',
        summary: '후기 상태 변경 [' + (after.authorName || id) + '] — ' + (d.요약 || '값 동일'),
        detail: {
          후기id: String(id),
          작성자: after.authorName || '', 작성자유형: after.authorType || '',
          학생이름: after.studentName || '', 반: after.className || '',
          바뀐칸: d.바뀐칸, 변경: d.변경,
          이전값: reviewForLog(before) || '(이전 값을 읽지 못함 — 노션 조회 실패)',
          이후값: reviewForLog(after),
          보낸값: {
            승인상태: body.status === undefined ? '(안 보냄)' : String(body.status).slice(0, 30),
            메인노출: body.mainShow === undefined ? '(안 보냄)' : (body.mainShow === true ? '예' : '아니오'),
            처리메모: body.memo === undefined ? '(안 보냄)' : clip(body.memo, 500),
          },
          내용앞부분: clip(after.content, 200),
          효과: '「메인 노출」이 켜지면 이 후기가 홈페이지 메인에 즉시 공개된다(이름은 마스킹되지만 반 이름은 그대로 나감). '
            + '2026-08-02부터 퍼블릭 조회는 「승인 상태 = 승인」 + 「메인 노출 체크」 둘 다 만족해야 공개한다 — '
            + '대기·거절은 노출이 켜져 있어도 메인에 안 나가고, 승인이 아닌 상태로 바꾸면 메인 노출도 같이 꺼진다.',
          비고: '처리 메모는 500자에서 잘려 저장된다(현 코드). 이전 메모는 덮어써지므로 위 「이전값」이 유일한 사본이다.',
        },
      });

      return jsonOk({ ok: true });
    }

    return jsonErr('지원하지 않는 메소드입니다.', 405);
  } catch (err) {
    return safeError(err, env);
  }
}
