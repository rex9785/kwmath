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
import { absenceLockContext, isLocked, sessionDateFromText } from './_makeup.js';
import { logAudit } from './_auditlog.js';

const ONECLICK_PREFIX = '원클릭보고서_';

// 📓 2026-08-03 (§11-11) — 여태 **원본 키의 파일명을 그대로** 봤다.
//   그런데 upload-file.js 는 모든 업로드 키에 `{시각}_` 를 붙인다(예외 없음).
//   그래서 앱을 거쳐 올라온 원클릭보고서는 `1700000000000_원클릭보고서_….pdf` 가 되고
//   이 판정에 **한 번도 걸리지 않았다** — 아래 두 특수처리가 통째로 죽어 있었다.
//     · reports/{이름}/ 에서 원클릭보고서 빼기        → 수업 리포트에 섞여 보였다
//     · test-results/{이름}/ 에 옛 원클릭보고서 합치기 → 학습 진단 결과에 안 보였다
//   ⚠️ toFileEntry 가 화면 이름을 만들 때 쓰는 것과 **같은 정규식**을 쓴다. 둘이 갈라지면
//     "화면엔 원클릭보고서로 보이는데 분류는 안 되는" 상태가 그대로 다시 생긴다.
//   ⚠️ R2 파일은 건드리지 않는다 — 어느 목록에 실리는지만 달라진다.
function isOneClickReport(key) {
  const fname = ((key || '').split('/').pop() || '').replace(/^\d+_/, '');
  return fname.startsWith(ONECLICK_PREFIX);
}

// ───────────────────────── R2 목록 전부 가져오기 ─────────────────────────
// 📓 2026-08-03 (§11-11) — 여태 `list({ prefix, limit: 200 })` 를 커서 없이 한 번만 불렀다.
//   R2 는 키를 **사전순**으로 돌려주는데, 업로드 키가 `폴더/시각_이름` 이라 사전순 = 오래된 순이다.
//   그래서 한 폴더가 200개를 넘는 순간 잘려나가는 쪽이 하필 **가장 최근에 올린 파일**이었다.
//   오류도 안 뜨고 그냥 없는 것처럼 보여서, 터져도 아무도 모른 채 지나간다.
//   reports/{이름}/ · test-results/{이름}/ 는 학생마다 계속 쌓이는 폴더라 언젠가 반드시 여기 걸린다.
//   ⚠️ 리포의 다른 R2 목록(homework · staff-materials · account-delete · save-video-code · _push)은
//     전부 커서를 돌리고 있었다. 이 파일만 빠져 있었다.
//   ⚠️ LIST_MAX_PAGES 는 무한루프 방지용 안전장치다. 여기에 걸리면(=2만 개 초과) truncated 로 알려서
//     "다 못 봤다"는 사실이 조용히 묻히지 않게 한다.
const LIST_PAGE = 1000;      // R2 list 1회 최대 (R2 상한이 1000)
const LIST_MAX_PAGES = 20;   // 최대 20,000개까지 훑는다

async function listAll(bucket, prefix) {
  const objects = [];
  let cursor;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const r = await bucket.list({ prefix, limit: LIST_PAGE, cursor });
    if (r && Array.isArray(r.objects)) {
      for (const o of r.objects) objects.push(o);   // push(...arr) 는 개수가 커지면 스택이 터질 수 있어 루프로
    }
    if (!r || !r.truncated) return { objects, truncated: false };
    cursor = r.cursor;
  }
  return { objects, truncated: true };
}

// ───────────────────────── 같은 이름 파일 구분하기 ─────────────────────────
// 📓 2026-08-03 (§11-11) — 업로드 키에 시각이 붙어서(upload-file.js) 같은 이름을 다시 올려도
//   덮이지 않고 나란히 쌓인다. 그런데 화면에 뿌릴 때는 앞의 시각을 떼기 때문에(toFileEntry)
//   학생 화면에 **똑같은 이름 두 줄**이 떴고, 어느 게 최신인지 알 방법이 전혀 없었다.
//   → 옛 파일로 공부하는 사고가 실제로 가능한 상태였다.
//   ⚠️ 파일을 지우지는 않는다. 자동 대체는 §11-9 에서 기록이 날아간 전례가 있다. **표시만** 구분한다.
//     정리는 admin.html 자료 목록의 삭제(delete-file.js)로 관우T가 직접 한다.
function ymdKst(v) {
  try {
    const d = v instanceof Date ? v : new Date(v);
    if (!d || isNaN(d.getTime())) return '';
    // R2 uploaded 는 UTC 다. 한국시간으로 하루가 밀려 보이지 않게 +9시간 하고 날짜만 취한다.
    return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  } catch (_) { return ''; }
}

function keyTimestamp(key) {
  const m = ((key || '').split('/').pop() || '').match(/^(\d+)_/);
  return m ? Number(m[1]) : 0;
}

// 표시 이름에 꼬리표를 단다.
//   ⚠️ 확장자 **앞**에 넣는다 — materials.html 의 파일 아이콘 판정이 split('.').pop() 으로
//     확장자를 보기 때문에, 뒤에 붙이면 아이콘이 전부 깨진다.
//   ⚠️ report.html 은 표시 이름의 **앞부분**(mmdd_)으로 그날 수업자료를 골라낸다 → 앞은 건드리지 않는다.
function withTag(name, tag) {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  if (dot <= 0) return s + ' (' + tag + ')';          // 확장자 없음 → 그냥 뒤에
  return s.slice(0, dot) + ' (' + tag + ')' + s.slice(dot);
}

function markDuplicates(entries) {
  const groups = new Map();
  for (const f of entries) {
    const k = f.displayName;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;                    // 안 겹치는 파일은 지금과 완전히 동일하게 둔다
    const sorted = group.slice().sort((a, b) => {
      const ta = new Date(a.lastModified || 0).getTime() || 0;
      const tb = new Date(b.lastModified || 0).getTime() || 0;
      return (tb - ta) || (keyTimestamp(b.key) - keyTimestamp(a.key));   // 업로드시각 같으면 키의 시각으로
    });
    sorted.forEach((f, i) => {
      const ymd = ymdKst(f.lastModified);
      f.duplicate = true;
      f.duplicateRank = i;                             // 0 = 최신
      f.displayName = withTag(f.displayName, i === 0 ? '최신' : (ymd ? ymd + ' 올림' : '이전본'));
    });
  }
  return entries;
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
  let gateStudent = null;   // 결석 잠금 판정용(학생 요청 시에만 세팅)

  if (!isAdmin) {
    const auth = await requireAuth(env, request);
    if (!auth.ok) return auth.response;

    const queryName = (url.searchParams.get('name') || '').trim();
    const resolved = await resolveStudent(env, auth.phone, queryName);
    if (!resolved.ok) return Response.json({ error: resolved.error || '권한 없음' }, { status: 403 });
    const student = resolved.student;
    gateStudent = student;

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
      // 업로드 폴더는 class/{학원}_{반}/ 구조 → 학원(academy)으로 비교 (학교 school 아님)
      const expected = (student.academy || '') + '_' + (student.className || '');
      if (classKey !== expected) {
        return Response.json({ error: '다른 반의 자료에 접근할 수 없습니다.' }, { status: 403 });
      }
    } else {
      return Response.json({ error: '사용자가 접근할 수 없는 폴더입니다.' }, { status: 403 });
    }
  }

  const listed = await listAll(env.BUCKET, folder + '/');
  if (listed.truncated) {
    // 여기 걸리면 파일이 2만 개를 넘었다는 뜻 — 사실상 안 오는 경우지만, 오면 반드시 남긴다.
    //   "목록이 이상하다"는 신고가 들어왔을 때 원인을 못 찾는 일이 없도록.
    await logAudit(env, request, {
      action: 'file.list.truncated',
      target: folder,
      summary: '자료 목록이 잘렸다 — ' + folder + ' 폴더가 ' + (LIST_PAGE * LIST_MAX_PAGES) + '개를 넘었다',
      detail: {
        폴더: folder,
        훑은개수: listed.objects.length,
        한도: LIST_PAGE * LIST_MAX_PAGES,
        효과: '이 폴더의 일부 파일이 목록에 안 나온다. 오래된 파일부터 정리하거나 한도를 올려야 한다.',
      },
    });
  }
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
        const legacyListed = await listAll(env.BUCKET, 'reports/' + studentName + '/');
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

  // 🔒 결석·병결·공결한 날의 수업자료 자동 잠금 — class/ 폴더, 학생 요청 한정.
  //   파일명의 6자리 YYMMDD로 수업 날짜를 판단(관우T 규칙). 잠긴 항목은 locked 플래그만 달아 그대로 내려보내고,
  //   실제 다운로드 차단은 download-file.js가 이중으로 막는다.
  if (!isAdmin && folder.startsWith('class/') && gateStudent) {
    try {
      const ctx = await absenceLockContext(env, gateStudent.id);
      for (const f of entries) {
        const d = sessionDateFromText(f.displayName || f.name);
        if (isLocked(ctx, d)) {
          f.locked = true;
          f.lockReason = 'absent';
          f.lockDate = d;
          f.requested = ctx.requested.has(d);
        }
      }
    } catch (_) { /* 잠금 판정 실패 시 기존 목록 유지 */ }
  }

  // ⚠️ 반드시 결석 잠금 판정 **뒤**에 부른다.
  //   잠금 판정은 표시 이름의 6자리 날짜(YYMMDD)를 읽는데, 꼬리표를 먼저 달면 그걸 건드릴 수 있다.
  //   (꼬리표의 날짜는 하이픈이 든 2026-08-03 이라 6자리 연속 숫자가 아니지만, 순서로도 막아 둔다.)
  markDuplicates(entries);

  return Response.json(entries);
}
