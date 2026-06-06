// functions/api/admin-migrate-reports-d1.js
// ───────────────────────────────────────────────────────────
// 안전한 일회성 이관: Notion 리포트(82ef) → D1 reports 테이블
// 배경: D1 컷오버(2026-05-31) 이후 MathOS가 리포트를 옛 Notion DB(82ef)에 계속 써서
//       홈페이지(D1을 읽음)에 안 보였음. 그 리포트들을 D1로 복사해 보이게 한다.
//
// POST { dryRun?: true(기본) } + admin 토큰 (Authorization: Bearer ADMIN_PASSWORD)
//   dryRun=true  : D1에 쓰지 않고 분석만 (안전 미리보기)
//   dryRun=false : 실제 INSERT
//
// ✅ 안전장치:
//   - Notion은 읽기만. 안 건드림.
//   - wipe 없음.
//   - 같은 (학생 이름 + 수업 날짜) 리포트가 D1에 이미 있으면 건너뜀 → 재실행해도 중복 안 생김.
//   - 컷오버 때 이미 이관된 리포트도 위 중복검사로 자동 스킵됨.
// ───────────────────────────────────────────────────────────
import { safeError } from './_errors.js';

const REPORTS_DB = '82ef896dcf844c5b9c36f7e0ff0a97f2';

async function notionQueryAll(env, dbId) {
  const out = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const b = { page_size: 100 };
    if (cursor) b.start_cursor = cursor;
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    });
    const data = await res.json();
    if (data.object === 'error') throw new Error('Notion(' + dbId.slice(0, 6) + '): ' + data.message);
    for (const p of (data.results || [])) if (!p.archived && !p.in_trash) out.push(p);
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return out;
}

const rt  = (p, k) => (p[k] && p[k].rich_text || [])[0] && p[k].rich_text[0].plain_text || '';
const ttl = (p, k) => (p[k] && p[k].title || [])[0] && p[k].title[0].plain_text || '';
const sel = (p, k) => (p[k] && p[k].select && p[k].select.name) || '';
const chk = (p, k) => !!(p[k] && p[k].checkbox === true);
const dat = (p, k) => (p[k] && p[k].date && p[k].date.start) || '';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) return Response.json({ error: '인증 필요' }, { status: 401 });
  if (!env.DB) return Response.json({ error: 'D1 바인딩(DB) 없음 — wrangler.toml + 배포 확인' }, { status: 500 });
  if (!env.NOTION_TOKEN) return Response.json({ error: 'NOTION_TOKEN 없음' }, { status: 500 });

  let body = {};
  try { body = await request.json(); } catch (_) {}
  const dryRun = body.dryRun !== false;

  const out = {
    ok: true, dryRun,
    notionTotal: 0, migrated: 0, skippedExisting: 0, invalid: 0,
    samples: [], errors: [],
  };

  try {
    const reps = await notionQueryAll(env, REPORTS_DB);
    out.notionTotal = reps.length;

    for (const r of reps) {
      const p = r.properties || {};
      const name = rt(p, '학생 이름');
      const date = dat(p, '수업 날짜');
      if (!name || !date) { out.invalid++; continue; }

      // 중복 검사: 같은 학생 이름 + 같은 수업 날짜가 D1에 이미 있으면 스킵
      let exists = null;
      try {
        exists = await env.DB.prepare('SELECT id FROM reports WHERE student_name = ? AND class_date = ? LIMIT 1')
          .bind(name, date).first();
      } catch (e) { out.errors.push('dedupe(' + name + '/' + date + '): ' + e.message); }
      if (exists) { out.skippedExisting++; continue; }

      const rec = {
        student_name: name,
        phone_last4:  rt(p, '전화번호 끝 4자리'),
        title:        ttl(p, '리포트 제목') || (name + ' - ' + date + ' 수업 리포트'),
        class_date:   date,
        content:      rt(p, '수업 내용'),
        homework:     rt(p, '숙제'),
        notes:        rt(p, '특이사항'),
        is_public:    chk(p, '공개') ? 1 : 0,
        academy:      sel(p, '학원'),
      };
      if (out.samples.length < 10) out.samples.push({ name, date, title: rec.title, public: rec.is_public });

      if (!dryRun) {
        try {
          await env.DB.prepare(
            'INSERT INTO reports (student_name, phone_last4, title, class_date, content, homework, notes, is_public, academy) VALUES (?,?,?,?,?,?,?,?,?)'
          ).bind(rec.student_name, rec.phone_last4, rec.title, rec.class_date, rec.content, rec.homework, rec.notes, rec.is_public, rec.academy).run();
        } catch (e) { out.errors.push(name + '/' + date + ': ' + e.message); continue; }
      }
      out.migrated++;
    }

    return Response.json(out);
  } catch (e) {
    out.ok = false;
    return safeError(e, env, { message: '리포트 이관 중 오류가 발생했습니다.' });
  }
}
