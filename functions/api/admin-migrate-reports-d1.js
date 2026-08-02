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
import { logAudit } from './_auditlog.js';

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
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) {
    // 거부도 남긴다 — "리포트가 갑자기 늘었다/안 늘었다"를 추적할 때 누가 두드렸는지가 단서가 된다.
    await logAudit(env, request, {
      action: 'admin.migrate.reports.denied',
      target: 'D1 reports 표',
      summary: '리포트 이관(노션→D1) 인증 실패 — 거부(401)',
      detail: {
        결과: '거부(401). D1에 어떤 변경도 일어나지 않았다.',
        사유: env.ADMIN_PASSWORD ? '관리자 비밀번호 불일치' : '서버에 ADMIN_PASSWORD 미설정',
        효과: '없음.',
        비고: '입력된 토큰 원문은 기록하지 않는다.',
      },
    });
    return Response.json({ error: '인증 필요' }, { status: 401 });
  }
  if (!env.DB) return Response.json({ error: 'D1 바인딩(DB) 없음 — wrangler.toml + 배포 확인' }, { status: 500 });
  if (!env.NOTION_TOKEN) return Response.json({ error: 'NOTION_TOKEN 없음' }, { status: 500 });

  let body = {};
  try { body = await request.json(); } catch (_) {}
  const dryRun = body.dryRun !== false;

  const out = {
    ok: true, dryRun,
    notionTotal: 0, migrated: 0, skippedExisting: 0, invalid: 0,
    // 👥 이름·날짜는 같은데 전화 끝 4자리로도 같은 리포트인지 다른 학생 것인지 못 가른 건수
    skippedAmbiguous: 0, ambiguousSamples: [],
    samples: [], errors: [],
  };

  // 📓 감사로그용 — 실행 1회 = 로그 1건. 응답(out.samples 10건)과 별개로 앞 30건까지 모아 둔다.
  const 시작 = Date.now();
  const 표본 = [];

  try {
    const reps = await notionQueryAll(env, REPORTS_DB);
    out.notionTotal = reps.length;

    for (const r of reps) {
      const p = r.properties || {};
      const name = rt(p, '학생 이름');
      const date = dat(p, '수업 날짜');
      if (!name || !date) { out.invalid++; continue; }

      const phone4 = rt(p, '전화번호 끝 4자리');

      // 중복 검사: 같은 학생 이름 + 같은 수업 날짜.
      //   👥 2026-07-31 — 예전엔 (이름 + 날짜) LIMIT 1 이 잡히면 무조건 "이미 있음"으로 건너뛰었다.
      //     같은 이름 학생이 두 명이면 **같은 날 수업 리포트가 한 명 것만 옮겨지고 나머지는 조용히 사라진다**.
      //     reports 표에는 student_id 칸이 없어 이름이 곧 신원이므로, 전화 끝 4자리로 한 번 더 갈라 본다.
      //     끝 4자리까지 같거나 어느 한쪽이 비어 있으면 구분할 방법이 없다 → 그때는 넣지 않고(중복 위험)
      //     「확인필요」로 세어 둔다. 노션 원본은 그대로 있으니 나중에 손으로 정리할 수 있다.
      let 기존 = [];
      try {
        const { results } = await env.DB.prepare(
          'SELECT id, phone_last4 FROM reports WHERE student_name = ? AND class_date = ?'
        ).bind(name, date).all();
        기존 = results || [];
      } catch (e) { out.errors.push('dedupe(' + name + '/' + date + '): ' + e.message); }
      if (기존.length) {
        const 같은번호 = 기존.some((x) => (x.phone_last4 || '') === phone4);
        const 판별불가 = !phone4 || 기존.some((x) => !x.phone_last4);
        if (같은번호) { out.skippedExisting++; continue; }
        if (판별불가) {
          out.skippedAmbiguous++;
          if (out.ambiguousSamples.length < 20) out.ambiguousSamples.push({ name, date, phone4: phone4 || '(없음)' });
          continue;
        }
        // 여기까지 왔으면 이름·날짜만 같고 전화 끝 4자리가 다르다 = 다른 학생 = 그대로 넣는다.
      }

      const rec = {
        student_name: name,
        phone_last4:  phone4,
        title:        ttl(p, '리포트 제목') || (name + ' - ' + date + ' 수업 리포트'),
        class_date:   date,
        content:      rt(p, '수업 내용'),
        homework:     rt(p, '숙제'),
        notes:        rt(p, '특이사항'),
        is_public:    chk(p, '공개') ? 1 : 0,
        academy:      sel(p, '학원'),
      };
      if (out.samples.length < 10) out.samples.push({ name, date, title: rec.title, public: rec.is_public });
      if (표본.length < 30) 표본.push({ 학생: name, 수업날짜: date, 제목: rec.title, 공개: rec.is_public === 1 });

      if (!dryRun) {
        try {
          await env.DB.prepare(
            'INSERT INTO reports (student_name, phone_last4, title, class_date, content, homework, notes, is_public, academy) VALUES (?,?,?,?,?,?,?,?,?)'
          ).bind(rec.student_name, rec.phone_last4, rec.title, rec.class_date, rec.content, rec.homework, rec.notes, rec.is_public, rec.academy).run();
        } catch (e) { out.errors.push(name + '/' + date + ': ' + e.message); continue; }
      }
      out.migrated++;
    }

    // 🔴 실행 1회 = 로그 1건. 수백 건을 건별로 남기지 않는다(로그·detail 상한이 터진다).
    await logAudit(env, request, {
      action: dryRun ? 'admin.migrate.reports.dryrun' : 'admin.migrate.reports',
      target: 'D1 reports 표',
      summary: (dryRun ? '[미리보기] ' : '') + '노션 리포트→D1 이관 — 노션 ' + out.notionTotal
        + '건 중 ' + out.migrated + '건 넣음 · 중복스킵 ' + out.skippedExisting + '건 · 형식오류 ' + out.invalid + '건'
        + (out.skippedAmbiguous ? ' · 동명이인확인필요 ' + out.skippedAmbiguous + '건' : ''),
      detail: {
        모드: dryRun ? '미리보기(dryRun) — D1에 쓰지 않음' : '실제 반영(dryRun=false)',
        노션전체: out.notionTotal,
        건수: { 넣음: out.migrated, 중복스킵: out.skippedExisting, 형식오류_이름이나날짜없음: out.invalid,
          동명이인_확인필요: out.skippedAmbiguous },
        동명이인_확인필요_표본: out.ambiguousSamples,
        표본_앞30건: 표본,
        표본잘림: out.migrated > 30,
        걸린시간초: Math.round((Date.now() - 시작) / 100) / 10,
        오류: out.errors.slice(0, 50),
        효과: dryRun
          ? '아무것도 바뀌지 않았다. 몇 건이 들어갈지 세어 본 결과다.'
          : '이 리포트들이 학부모·학생 포털에 즉시 보이게 된다(공개=1인 것). 노션 원본은 그대로 남는다.',
        비고: '같은 (학생 이름 + 수업 날짜 + 전화 끝 4자리)가 D1에 이미 있으면 건너뛰므로 재실행해도 중복이 생기지 않는다.'
          + (out.skippedAmbiguous
              ? ' ⚠️ 이름·날짜는 같은데 전화 끝 4자리가 비어 있어 가르지 못한 ' + out.skippedAmbiguous
                + '건은 넣지 않았다. 노션 원본은 그대로 있으니, 해당 학생의 전화 끝 4자리를 채운 뒤 다시 돌리면 들어간다.'
              : ''),
      },
    });
    return Response.json(out);
  } catch (e) {
    out.ok = false;
    // 중간에 터지면 일부만 들어간 상태다 — 어디까지 갔는지를 남긴다.
    await logAudit(env, request, {
      action: 'admin.migrate.reports.fail',
      target: 'D1 reports 표',
      summary: '노션 리포트→D1 이관 중단(오류) — ' + String((e && e.message) || e).slice(0, 120),
      detail: {
        모드: dryRun ? '미리보기(dryRun)' : '실제 반영',
        오류: String((e && e.message) || e),
        중단시점까지: { 넣음: out.migrated, 중복스킵: out.skippedExisting, 동명이인_확인필요: out.skippedAmbiguous,
          형식오류: out.invalid, 노션읽음: out.notionTotal },
        걸린시간초: Math.round((Date.now() - 시작) / 100) / 10,
        효과: dryRun ? '아무것도 바뀌지 않았다.' : '⚠️ 위 「넣음」 건수까지만 D1에 반영된 상태일 수 있다. 다시 돌리면 중복검사로 나머지만 들어간다.',
      },
    });
    return safeError(e, env, { message: '리포트 이관 중 오류가 발생했습니다.' });
  }
}
