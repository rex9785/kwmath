// GET /api/list-files?folder=...&name=...
// - admin: Authorization: Bearer <ADMIN_PASSWORD>
// - 사용자(학부모/학생): Authorization: Bearer <userToken>
//   - reports/{학생이름}/, class/{학원}_{반}/, test-results/{학생이름}/ 폴더만 접근 가능
//   - 토큰 검증 + 학생 이름/학원/반 일치 확인
//
// 폴더별 특수 처리:
// - reports/{이름}/   → '원클릭보고서_*.pdf' 는 학습 진단 보고서로 분류되어 제외
// - test-results/{이름}/ → 본 폴더 + 호환을 위해 reports/{이름}/원클릭보고서_*.pdf 도 포함

import { requireAuth, resolveStudent } from './_auth.js';

const ONECLICK_PREFIX = '원클릭보고서_';

function isOneClickReport(key) {
  const fname = (key || '').split('/').pop() || '';
  return fname.startsWith(ONECLICK_PREFIX);
}

function toFileEntry(obj) {
  return {
    key: obj.key,
    name: obj.key.split('/').pop().replace(/^\d+_/, ''),
    displayName: obj.key.split('/').pop().replace(/^\d+_/, ''),
    size: obj.size,
    sizeLabel: obj.size > 1024 * 1024
      ? (obj.size / (1024 * 1024)).toFixed(1) + 'MB'
      : Math.round(obj.size / 1024) + 'KB',
    lastModified: obj.uploaded,
  };
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const folder = url.searchParams.get('folder') || 'materials';

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;

  if (!isAdmin) {
    const auth = await requireAuth(env, request);
    if (!auth.ok) return auth.response;

    const queryName = (url.searchParams.get('name') || '').trim();
    const resolved = await resolveStudent(env, auth.phone, queryName);
    if (!resolved.ok) return Response.json({ error: resolved.error || '권한 없음' }, { status: 403 });
    const student = resolved.student;

    if (folder.startsWith('reports/')) {
      const folderName = folder.slice('reports/'.length).split('/')[0];
      if (folderName !== student.name) {
        return Response.json({ error: '다른 학생의 자료에 접근할 수 없습니다.' }, { status: 403 });
      }
    } else if (folder.startsWith('test-results/')) {
      const folderName = folder.slice('test-results/'.length).split('/')[0];
      if (folderName !== student.name) {
        return Response.json({ error: '다른 학생의 학습 진단 결과에 접근할 수 없습니다.' }, { status: 403 });
      }
    } else if (folder.startsWith('class/')) {
      const classKey = folder.slice('class/'.length).split('/')[0];
      const expected = (student.school || '') + '_' + (student.className || '');
      if (classKey !== expected) {
        return Response.json({ error: '다른 반의 자료에 접근할 수 없습니다.' }, { status: 403 });
      }
    } else {
      return Response.json({ error: '사용자가 접근할 수 없는 폴더입니다.' }, { status: 403 });
    }
  }

  const listed = await env.BUCKET.list({ prefix: folder + '/', limit: 200 });
  let entries = (listed.objects || [])
    .map(toFileEntry)
    .filter(f => f.displayName);

  if (folder.startsWith('reports/')) {
    // 수업 리포트에서는 원클릭보고서_ 제외 (학습 진단으로 분류)
    entries = entries.filter(f => !isOneClickReport(f.key));
  } else if (folder.startsWith('test-results/')) {
    // 학습 진단 결과 페이지에는 호환을 위해 reports/{이름}/원클릭보고서_*.pdf 도 포함
    const studentName = folder.slice('test-results/'.length).split('/')[0];
    if (studentName) {
      try {
        const legacyListed = await env.BUCKET.list({ prefix: 'reports/' + studentName + '/', limit: 200 });
        const legacyEntries = (legacyListed.objects || [])
          .filter(obj => isOneClickReport(obj.key))
          .map(toFileEntry);
        const seen = new Set(entries.map(f => f.key));
        for (const f of legacyEntries) {
          if (!seen.has(f.key)) entries.push(f);
        }
      } catch (e) {
        // legacy 스캔 실패 — main 결과만 반환
      }
    }
  }

  return Response.json(entries);
}
