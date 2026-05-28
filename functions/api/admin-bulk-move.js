// POST /api/admin-bulk-move  (admin only)
// 여러 학생을 한 번에 새 학원/반으로 이동 — 시즌 전환용
//
// body:
//   {
//     moves: [{ sourceStudentId, targetAcademy, targetClassName }],
//     mode: 'transition' | 'add-only'
//   }
//   - transition: 새 enrollment 생성 + 옛 enrollment 퇴원 (enrollment-only 모드, 리포트/계정 안 건드림)
//   - add-only:   새 enrollment 생성만 (옛 enrollment 유지)
//
// 응답:
//   {
//     ok: true,
//     total: N,
//     succeeded: M,
//     failed: F,
//     results: [{ sourceStudentId, name, ok, newEnrollmentId, error }]
//   }

const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = 'KW';
  for (let i = 0; i < 6; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

function isAdmin(request, env) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  return !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
}

// 원본 학생 페이지를 복사해서 새 enrollment 생성 (admin-add-enrollment.js와 동일 로직)
async function copyEnrollment(env, headers, sourceId, academy, className) {
  // 원본 가져오기
  const srcRes = await fetch(`https://api.notion.com/v1/pages/${sourceId}`, { headers });
  const src = await srcRes.json();
  if (src.object === 'error' || !src.properties) {
    return { ok: false, error: '원본 학생을 찾을 수 없음: ' + (src.message || '') };
  }
  const sp = src.properties;
  const rt   = (k) => ((sp[k]?.rich_text || [])[0]?.plain_text || '');
  const ttl  = (k) => ((sp[k]?.title || [])[0]?.plain_text || '');
  const sel  = (k) => sp[k]?.select?.name || '';
  const ms   = (k) => (sp[k]?.multi_select || []).map(o => o.name);
  const num  = (k) => (typeof sp[k]?.number === 'number') ? sp[k].number : null;

  const name = ttl('이름');
  if (!name) return { ok: false, error: '원본 학생 이름 없음' };

  // 중복 검증
  const dupRes = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({
      filter: { and: [
        { property: '이름', title: { equals: name } },
        { property: '학원', select: { equals: academy } },
        { property: '반',   select: { equals: className } },
      ]},
      page_size: 5,
    }),
  });
  const dupData = await dupRes.json();
  const existingActive = (dupData.results || []).find(p => !p.archived && !p.in_trash);
  if (existingActive) {
    return { ok: false, error: `이미 [${academy} · ${className}]에 등록`, existingId: existingActive.id };
  }

  // 새 페이지 생성
  const newKey = generateKey();
  const properties = {
    '이름':              { title: [{ text: { content: name } }] },
    '학교':              { rich_text: [{ text: { content: rt('학교') } }] },
    '학부모 연락처 끝4자리': { rich_text: [{ text: { content: rt('학부모 연락처 끝4자리') } }] },
    '학생 연락처':       { rich_text: [{ text: { content: rt('학생 연락처') } }] },
    '학부모 휴대폰':     { rich_text: [{ text: { content: rt('학부모 휴대폰') } }] },
    '수강 목적':         { multi_select: ms('수강 목적').map(n => ({ name: n })) },
    '학원':              { select: { name: academy } },
    '반':                { select: { name: className } },
    '특이사항':          { rich_text: [{ text: { content: (rt('특이사항') || '') } }] },
    '개인키':            { rich_text: [{ text: { content: newKey } }] },
    '취약 단원':         { rich_text: [{ text: { content: rt('취약 단원') } }] },
    '희망 대학/계열':    { rich_text: [{ text: { content: rt('희망 대학/계열') } }] },
    '등원 가능 요일':    { multi_select: ms('등원 가능 요일').map(n => ({ name: n })) },
  };
  if (sel('학년'))             properties['학년']            = { select: { name: sel('학년') } };
  if (sel('현재 수학 등급'))   properties['현재 수학 등급']  = { select: { name: sel('현재 수학 등급') } };
  if (sel('학부모 관계'))      properties['학부모 관계']     = { select: { name: sel('학부모 관계') } };
  if (sel('모의고사 수학 등급')) properties['모의고사 수학 등급'] = { select: { name: sel('모의고사 수학 등급') } };
  if (sel('모의고사 국어 등급')) properties['모의고사 국어 등급'] = { select: { name: sel('모의고사 국어 등급') } };
  if (sel('모의고사 영어 등급')) properties['모의고사 영어 등급'] = { select: { name: sel('모의고사 영어 등급') } };
  if (sel('내신 수학 등급'))    properties['내신 수학 등급']  = { select: { name: sel('내신 수학 등급') } };
  if (sel('선행 진도'))         properties['선행 진도']       = { select: { name: sel('선행 진도') } };
  if (num('모의고사 수학 원점수') !== null) properties['모의고사 수학 원점수'] = { number: num('모의고사 수학 원점수') };

  const createRes = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST', headers,
    body: JSON.stringify({ parent: { database_id: STUDENTS_DB }, properties }),
  });
  const created = await createRes.json();
  if (created.object === 'error') {
    return { ok: false, error: created.message || '생성 실패' };
  }
  return { ok: true, newEnrollmentId: created.id, name };
}

async function archiveEnrollment(headers, studentId) {
  const ar = await fetch(`https://api.notion.com/v1/pages/${studentId}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ archived: true }),
  });
  if (!ar.ok) {
    const err = await ar.json().catch(() => ({}));
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('archived') || msg.includes('trash')) return { ok: true };
    return { ok: false, error: err.message || ('status ' + ar.status) };
  }
  return { ok: true };
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST')
    return Response.json({ error: 'POST만 허용' }, { status: 405 });
  if (!isAdmin(request, env))
    return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const moves = Array.isArray(body.moves) ? body.moves : [];
  const mode  = (body.mode || 'transition').toString();
  if (!['transition', 'add-only'].includes(mode))
    return Response.json({ error: 'mode는 transition 또는 add-only' }, { status: 400 });
  if (!moves.length)
    return Response.json({ error: 'moves 비어있음' }, { status: 400 });

  const headers = {
    Authorization:    `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  };

  const results = [];
  let succeeded = 0, failed = 0;

  for (const m of moves) {
    const src = (m.sourceStudentId || '').trim();
    const acad = (m.targetAcademy || '').trim();
    const cls  = (m.targetClassName || '').trim();
    if (!src || !acad || !cls) {
      results.push({ sourceStudentId: src, ok: false, error: '필수 값 누락' });
      failed++;
      continue;
    }

    // 1) 새 enrollment 생성
    const copyResult = await copyEnrollment(env, headers, src, acad, cls);
    if (!copyResult.ok) {
      results.push({ sourceStudentId: src, ok: false, error: copyResult.error });
      failed++;
      continue;
    }

    // 2) 옛 enrollment 퇴원 (transition 모드만)
    if (mode === 'transition') {
      const archiveResult = await archiveEnrollment(headers, src);
      if (!archiveResult.ok) {
        // 새 enrollment는 만들어졌지만 옛 enrollment 퇴원 실패 → 부분 성공으로 기록
        results.push({
          sourceStudentId: src, name: copyResult.name,
          ok: false, partial: true,
          newEnrollmentId: copyResult.newEnrollmentId,
          error: '새 enrollment 생성됐지만 옛 enrollment 퇴원 실패: ' + archiveResult.error,
        });
        failed++;
        continue;
      }
    }

    results.push({
      sourceStudentId: src, name: copyResult.name,
      ok: true, newEnrollmentId: copyResult.newEnrollmentId,
    });
    succeeded++;
  }

  return Response.json({
    ok: true,
    mode,
    total: moves.length,
    succeeded,
    failed,
    results,
  });
}
