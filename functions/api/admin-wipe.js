// POST /api/admin-wipe
// ⚠️ 모든 학원 운영 데이터 초기화 (학생/리포트/계정/영상/출석/공부/푸쉬/반자료/토큰)
// 유지: 공지사항 / 수강 후기 / 자료실(materials)
//
// 안전장치 3중:
//   1. Authorization: Bearer <ADMIN_PASSWORD>
//   2. body.confirm === "WIPE_ALL_DATA_2026"
//   3. body.dryRun === false (기본 true: 카운트만 미리보기)
//
// 응답: { ok, dryRun, plan: { notion: {db: count}, r2: {prefix: count} }, executed: {...}, errors: [...] }

const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';
const REPORTS_DB  = '82ef896dcf844c5b9c36f7e0ff0a97f2';
const ACCOUNTS_DB = '893a626479514059ae309a269b3661b5';

const NOTION_DBS_TO_WIPE = [
  { id: STUDENTS_DB,  label: '학생 DB' },
  { id: REPORTS_DB,   label: '리포트 DB' },
  { id: ACCOUNTS_DB,  label: '계정 DB' },
];

const R2_PREFIXES_TO_WIPE = [
  'video-codes/',
  'reports/',
  'test-results/',
  'attendance/',
  'study/',
  'push-subs/',
  'class/',
  'auth/tokens/',
];

export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });

  // 안전장치 1: admin 토큰
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}

  // 안전장치 2: 정확한 confirm 문자열
  if (body.confirm !== 'WIPE_ALL_DATA_2026') {
    return Response.json({
      error: 'confirm 필요',
      hint: 'body.confirm = "WIPE_ALL_DATA_2026"',
    }, { status: 400 });
  }

  // 안전장치 3: 기본 dryRun, 실제 삭제는 명시적 false 필요
  const dryRun = body.dryRun !== false;

  const plan = { notion: {}, r2: {} };
  const executed = { notion: {}, r2: {} };
  const errors = [];

  const notionHeaders = {
    Authorization:    `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  };

  // ── Notion DBs ──
  for (const db of NOTION_DBS_TO_WIPE) {
    let pages = [];
    try {
      // 전체 페이지 수집 (페이지네이션)
      let cursor = undefined;
      while (true) {
        const qbody = { page_size: 100 };
        if (cursor) qbody.start_cursor = cursor;
        const res = await fetch(`https://api.notion.com/v1/databases/${db.id}/query`, {
          method: 'POST', headers: notionHeaders, body: JSON.stringify(qbody),
        });
        const data = await res.json();
        if (data.object === 'error') {
          errors.push(`${db.label} 쿼리 실패: ${data.message}`);
          break;
        }
        pages = pages.concat((data.results || []).filter(p => !p.archived && !p.in_trash));
        if (!data.has_more) break;
        cursor = data.next_cursor;
      }
    } catch (e) {
      errors.push(`${db.label} 쿼리 예외: ${e.message}`);
    }
    plan.notion[db.label] = pages.length;

    if (!dryRun) {
      let archived = 0;
      for (const page of pages) {
        try {
          const r = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
            method: 'PATCH', headers: notionHeaders,
            body: JSON.stringify({ archived: true }),
          });
          if (r.ok) {
            archived++;
          } else {
            const eb = await r.json().catch(() => ({}));
            const msg = (eb.message || '').toLowerCase();
            // 이미 archived 메시지는 success로 카운트
            if (msg.includes('archived') || msg.includes('trash')) archived++;
            else errors.push(`${db.label} page ${page.id}: ${r.status} ${eb.message || ''}`);
          }
        } catch (e) {
          errors.push(`${db.label} page ${page.id} 예외: ${e.message}`);
        }
      }
      executed.notion[db.label] = archived;
    }
  }

  // ── R2 prefixes ──
  for (const prefix of R2_PREFIXES_TO_WIPE) {
    let keys = [];
    try {
      let cursor = undefined;
      while (true) {
        const opts = { prefix, limit: 1000 };
        if (cursor) opts.cursor = cursor;
        const listed = await env.BUCKET.list(opts);
        keys = keys.concat((listed.objects || []).map(o => o.key));
        if (!listed.truncated) break;
        cursor = listed.cursor;
      }
    } catch (e) {
      errors.push(`R2 ${prefix} list 예외: ${e.message}`);
    }
    plan.r2[prefix] = keys.length;

    if (!dryRun) {
      let deleted = 0;
      // R2 delete는 한 번에 1000개까지 배치 가능
      const batchSize = 200;
      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        try {
          await env.BUCKET.delete(batch);
          deleted += batch.length;
        } catch (e) {
          errors.push(`R2 ${prefix} batch delete 실패 (${batch.length}개): ${e.message}`);
        }
      }
      executed.r2[prefix] = deleted;
    }
  }

  return Response.json({
    ok: true,
    dryRun,
    plan,
    executed: dryRun ? null : executed,
    errors,
    message: dryRun
      ? '미리보기 (plan만 계산). 실제 삭제하려면 body.dryRun=false 추가.'
      : '삭제 완료. executed 카운트 확인.',
    keepingNotion: ['공지사항 DB', '수강 후기 DB'],
    keepingR2: ['materials/'],
  });
}
