// /api/class-options
//   GET  — 공개 (누구나 호출). R2의 학원/반 옵션 + 실제 학생 데이터에서 사용 중인 옵션 합집합 반환
//   POST — admin only. body: { action: 'add-class'|'delete-class'|'add-academy'|'delete-academy', academy, className? }
//
// 저장 위치: R2 key `auth/class-options.json`
// 형식: { academies: [...], classes: { [academy]: [class1, class2, ...] } }
// R2에 없으면 학생 데이터에서 시드(seed)

const STUDENTS_DB = '559465b73e2f4b76b7df441fd0058bfb';
const OPTIONS_KEY = 'auth/class-options.json';

const DEFAULT_OPTIONS = {
  academies: ['대치동 정규반', '세정학원'],
  classes: {
    '대치동 정규반': [],
    '세정학원': [],
  },
};

function isAdmin(request, env) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  return !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
}

async function loadOptions(env) {
  try {
    const obj = await env.BUCKET.get(OPTIONS_KEY);
    if (obj) {
      const data = await obj.json();
      if (data && typeof data === 'object' && Array.isArray(data.academies) && data.classes) {
        return data;
      }
    }
  } catch (_) {}
  return JSON.parse(JSON.stringify(DEFAULT_OPTIONS));
}

async function saveOptions(env, data) {
  await env.BUCKET.put(OPTIONS_KEY, JSON.stringify(data), {
    httpMetadata: { contentType: 'application/json' },
  });
}

// 학생 데이터에서 실제 사용 중인 학원/반 추출 (active만)
async function getUsedFromStudents(env) {
  const used = { academies: new Set(), classes: {}, counts: {} }; // counts: "학원/반" → 학생 수
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${STUDENTS_DB}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_size: 100 }),
    });
    const data = await res.json();
    for (const page of (data.results || [])) {
      if (page.archived || page.in_trash) continue;
      const acad = page.properties?.['학원']?.select?.name || '';
      const cls  = page.properties?.['반']?.select?.name || '';
      if (acad) {
        used.academies.add(acad);
        if (!used.classes[acad]) used.classes[acad] = new Set();
        if (cls) {
          used.classes[acad].add(cls);
          const key = acad + '/' + cls;
          used.counts[key] = (used.counts[key] || 0) + 1;
        }
      }
    }
  } catch (_) {}
  return used;
}

// 저장된 옵션 + 학생 데이터에서 사용 중인 옵션 합집합
function mergeOptions(saved, used) {
  const result = { academies: [], classes: {}, counts: {} };
  const allAcademies = new Set([...(saved.academies || []), ...used.academies]);
  for (const acad of allAcademies) {
    const savedCls = new Set(saved.classes?.[acad] || []);
    const usedCls = used.classes[acad] || new Set();
    const allCls = new Set([...savedCls, ...usedCls]);
    result.classes[acad] = Array.from(allCls).sort();
  }
  result.academies = Array.from(allAcademies).sort();
  result.counts = used.counts;
  return result;
}

// saved + used에서 새로 추가된 학원/반이 있으면 saved에 흡수해서 R2 저장
async function syncStudentClassesToSaved(env, saved, used) {
  let changed = false;
  for (const acad of used.academies) {
    if (!saved.academies.includes(acad)) {
      saved.academies.push(acad);
      changed = true;
    }
    if (!saved.classes[acad]) saved.classes[acad] = [];
    for (const cls of (used.classes[acad] || new Set())) {
      if (!saved.classes[acad].includes(cls)) {
        saved.classes[acad].push(cls);
        changed = true;
      }
    }
  }
  if (changed) {
    await saveOptions(env, saved);
  }
  return changed;
}

export async function onRequest({ request, env }) {
  if (request.method === 'GET') {
    const saved = await loadOptions(env);
    const used  = await getUsedFromStudents(env);
    // 학생 데이터에서 사용 중인 학원/반을 R2 saved에 자동 흡수 (한 번 등록되면 학생 0명이 돼도 남음)
    await syncStudentClassesToSaved(env, saved, used);
    const merged = mergeOptions(saved, used);
    return Response.json(merged);
  }

  if (request.method === 'POST') {
    if (!isAdmin(request, env)) return Response.json({ error: '인증 실패' }, { status: 401 });

    let body = {};
    try { body = await request.json(); } catch {}
    const action = (body.action || '').toString();
    const academy = (body.academy || '').trim();
    const className = (body.className || '').trim();

    const saved = await loadOptions(env);
    saved.classes = saved.classes || {};

    if (action === 'add-academy') {
      if (!academy) return Response.json({ error: 'academy 필요' }, { status: 400 });
      if (!saved.academies.includes(academy)) saved.academies.push(academy);
      if (!saved.classes[academy]) saved.classes[academy] = [];
      await saveOptions(env, saved);
      return Response.json({ ok: true, action, academy });
    }

    if (action === 'delete-academy') {
      if (!academy) return Response.json({ error: 'academy 필요' }, { status: 400 });
      const used = await getUsedFromStudents(env);
      if (used.academies.has(academy)) {
        return Response.json({ error: `학원 [${academy}]에 학생이 있어서 삭제할 수 없습니다.` }, { status: 409 });
      }
      saved.academies = saved.academies.filter(a => a !== academy);
      delete saved.classes[academy];
      await saveOptions(env, saved);
      return Response.json({ ok: true, action, academy });
    }

    if (action === 'add-class') {
      if (!academy || !className) return Response.json({ error: 'academy, className 둘 다 필요' }, { status: 400 });
      if (!saved.academies.includes(academy)) saved.academies.push(academy);
      if (!saved.classes[academy]) saved.classes[academy] = [];
      if (!saved.classes[academy].includes(className)) saved.classes[academy].push(className);
      await saveOptions(env, saved);
      return Response.json({ ok: true, action, academy, className });
    }

    if (action === 'delete-class') {
      if (!academy || !className) return Response.json({ error: 'academy, className 둘 다 필요' }, { status: 400 });
      const used = await getUsedFromStudents(env);
      const key = academy + '/' + className;
      const count = used.counts[key] || 0;
      if (count > 0) {
        return Response.json({ error: `[${academy} · ${className}]에 학생 ${count}명이 있어서 삭제할 수 없습니다. (먼저 이동하거나 퇴원 처리)` }, { status: 409 });
      }
      saved.classes[academy] = (saved.classes[academy] || []).filter(c => c !== className);
      await saveOptions(env, saved);
      return Response.json({ ok: true, action, academy, className });
    }

    return Response.json({ error: 'action: add-class | delete-class | add-academy | delete-academy' }, { status: 400 });
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
