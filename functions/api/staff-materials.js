// /api/staff-materials  — 조교용 수업자료 열람(목록 + 다운로드)
// ─────────────────────────────────────────────────────────────
// 조교(ast_)/원장(adm_) 세션 전용. _middleware.js가 ast_/adm_ 토큰을
//   Bearer ADMIN_PASSWORD로 번역하고, 조교면 검증된 X-Staff-Phone을 실어준다.
//   → 여기선 token===ADMIN_PASSWORD 여부로 1차 게이트(학생/학부모 토큰은 번역이 안 되므로 401).
//
// 학원 스코프(staffScopeAcademy):
//   null      → 원장         : 모든 class/ 자료 + staff-shared/
//   ''        → 미배정 조교   : staff-shared/ 만
//   '학원명'  → 배정 조교     : class/{학원}_ 자료 + staff-shared/
//
//  GET (no key)   → 목록 { class:[...], shared:[...] }
//  GET ?key=...   → 그 파일 스트림 다운로드. key는 스코프 화이트리스트만 통과.
//
// ⚠️ 학생용 결석잠금(absence lock)은 적용하지 않음 — 조교/원장은 운영자.
// ⚠️ 학원 스코프를 서버에서 강제하므로, list-files/download-file의 광범위 admin
//    패스스루에 기대지 않는다("조교 담당 학원만" 규칙 — 관우T 결정 2026-07-23).
import { staffScopeAcademy } from './_staff.js';

const SHARED_PREFIX = 'staff-shared/';

function sizeLabel(size) {
  return size > 1024 * 1024
    ? (size / (1024 * 1024)).toFixed(1) + 'MB'
    : Math.round(size / 1024) + 'KB';
}

function baseName(key) {
  return (String(key).split('/').pop() || '').replace(/^\d+_/, '');
}

// class/{학원}_{반}/{MMDD}/{ts}_{파일명}  →  표시용 파싱(반·날짜)
function parseClassKey(key, knownAcademy) {
  const rest = String(key).slice('class/'.length);   // {학원}_{반}/{MMDD}/{ts}_{파일}
  const parts = rest.split('/');
  const classSeg = parts[0] || '';                   // {학원}_{반}
  let academy, className;
  if (knownAcademy && classSeg.startsWith(knownAcademy + '_')) {
    academy = knownAcademy;
    className = classSeg.slice(knownAcademy.length + 1);
  } else {
    const us = classSeg.indexOf('_');
    academy = us >= 0 ? classSeg.slice(0, us) : classSeg;
    className = us >= 0 ? classSeg.slice(us + 1) : '';
  }
  // 파일명 바로 앞 세그먼트가 MMDD(4자리)면 수업 날짜로 표시
  let date = '';
  if (parts.length >= 3 && /^\d{4}$/.test(parts[1])) {
    date = parts[1].slice(0, 2) + '/' + parts[1].slice(2);   // MM/DD
  }
  return { academy, className, date };
}

// R2 prefix 전체 나열(1000 초과분은 cursor로 이어받되 폭주 방지 상한).
async function listAll(env, prefix, cap = 2000) {
  const out = [];
  let cursor;
  do {
    const listed = await env.BUCKET.list({ prefix, limit: 1000, cursor });
    for (const o of (listed.objects || [])) out.push(o);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor && out.length < cap);
  return out;
}

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdminToken = !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  if (!isAdminToken) {
    return Response.json({ error: '권한이 없습니다.' }, { status: 401 });
  }

  const url = new URL(request.url);
  const academy = await staffScopeAcademy(env, request);   // null | '' | '학원명'
  const key = url.searchParams.get('key');

  // ── 다운로드 ──
  if (key) {
    const allowed =
      key.startsWith(SHARED_PREFIX) ||
      (academy === null && key.startsWith('class/')) ||                       // 원장: 모든 class 허용
      (typeof academy === 'string' && academy && key.startsWith('class/' + academy + '_'));
    if (!allowed) {
      return Response.json({ error: '이 자료에 접근할 수 없어요.' }, { status: 403 });
    }
    const object = await env.BUCKET.get(key);
    if (!object) return Response.json({ error: '파일을 찾을 수 없어요.' }, { status: 404 });
    const fileName = (key.split('/').pop() || 'file').replace(/[\r\n"]/g, '');
    const contentType = object.httpMetadata?.contentType
      || (fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
    const encodedName = encodeURIComponent(fileName);
    return new Response(object.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'private, max-age=0',
      },
    });
  }

  // ── 목록 ──
  const out = { class: [], shared: [] };

  // 1) 수업자료(class/) — 스코프 prefix만. 원장(null)=전체, 배정 조교=class/{학원}_, 미배정('')=스킵.
  let classPrefix = null;
  if (academy === null) classPrefix = 'class/';
  else if (academy) classPrefix = 'class/' + academy + '_';
  if (classPrefix) {
    try {
      for (const o of await listAll(env, classPrefix)) {
        const nm = baseName(o.key);
        if (!nm) continue;
        const p = parseClassKey(o.key, academy || null);
        out.class.push({
          key: o.key,
          name: nm,
          academy: p.academy,
          className: p.className,
          date: p.date,
          size: o.size,
          sizeLabel: sizeLabel(o.size),
          lastModified: o.uploaded,
        });
      }
    } catch (_) {}
  }

  // 2) 원장 전달 자료(staff-shared/) — 모든 조교 공용함.
  try {
    for (const o of await listAll(env, SHARED_PREFIX)) {
      const nm = baseName(o.key);
      if (!nm) continue;
      out.shared.push({
        key: o.key,
        name: nm,
        size: o.size,
        sizeLabel: sizeLabel(o.size),
        lastModified: o.uploaded,
      });
    }
  } catch (_) {}

  const byNewest = (a, b) => String(b.lastModified || '').localeCompare(String(a.lastModified || ''));
  out.class.sort(byNewest);
  out.shared.sort(byNewest);

  return Response.json(out);
}
