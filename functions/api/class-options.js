import { listStudents, setApprovalStatusBulk } from './_db.js';
import { isEnrolled, isCompleted, STATUS_COMPLETED } from './_auth.js';
import { logAudit } from './_auditlog.js';
// 🛡️ §11-16 — 이 파일은 _lockout.js 를 쓰지 않는다.
//    「코드로 반 찾기(GET ?code=)」를 원장 전용으로 잠갔기 때문에(아래 onRequest 참고)
//    공개로 두드릴 수 있는 문이 남아 있지 않다. 잠금이 필요한 곳은
//    가입 신청(POST /api/student-register) 한 곳뿐이고, 거기에만 걸려 있다.
//    ⚠️ ?code= 를 다시 공개로 되돌린다면 반드시 _lockout.js 의 gate* 잠금을 함께 걸 것.
// /api/class-options
//   GET  — 공개 (누구나 호출). R2의 학원/반 옵션 + 실제 학생 데이터에서 사용 중인 옵션 합집합 반환
//   POST — admin only. body: { action: 'add-class'|'delete-class'|'add-academy'|'delete-academy'|'set-schedule'|'archive-class'|'unarchive-class', academy, className?, schedule? }
//
// 저장 위치: R2 key `auth/class-options.json`
// 형식: { academies: [...], classes: { [academy]: [class1, ...] },
//         codes: { "학원/반": "12345" },
//         schedules: { "학원/반": { days: [1,3,5], start: "09:30", end: "13:30", clinic?: { days, start, end } } },
//         archived: { "학원/반": { at: ISO, students: [id...] } } }
// 🏷️ archived — 「반 종강」(2026-08-10). 반을 지우지 않고 접는다. 종강하면 반코드 폐기 · 수업시간표 해제 ·
//    그 반 재원생 전원 자동 '수료'. 출결·성적·리포트는 하나도 건드리지 않는다.
//    students 는 **이번 종강이 실제로 수료로 바꾼 학생 id**만 담는다 — 「종강 취소」가 딱 그 사람만 되돌리기 위함.
//    (원래부터 수료였던 학생까지 되살리면 안 되므로, 목록 없이 되돌리는 건 불가능하다.)
//   ⏰ schedules — 수업 요일(0=일 ~ 6=토)·시작/종료 시각(KST, HH:MM). 관리자 알림(리포트 미생성·출결 미입력 체크)의 기준 데이터.
//      clinic(선택) — 클리닉/보충 시간 블록. 예: 세정 시동반 본수업 월수금 09:30~13:00 + 클리닉 월수금 14:00~16:00.
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

// 🏷️ 종강한 반인가? — saved.archived 는 { "학원/반": {...} } 맵이다.
function isArchivedKey(saved, key) {
  return !!(saved && saved.archived && saved.archived[key]);
}

// 🏷️ 반 이름 기수 표기 — 2026-08-10 관우T 확정.
//   1학기 `26-1` · 여름방학 `26-s` · 2학기 `26-2` · 겨울방학 `26-w`(시작 연도 기준). 예) `시동반 (26-2)`
//
// ⚠️ 그냥 .sort() 하면 문자열 알파벳 순이라 `26-1 · 26-2 · 26-s · 26-w` 가 된다.
//    실제 시간 순은 `26-1 → 26-s → 26-2 → 26-w`. 표기는 그대로 두고 **정렬 키만** 여기서 만든다.
//    (표기를 시간순으로 정렬되게 바꾸자는 안은 기각 — 관우T가 읽을 이름이 우선이다.)
const SEASON_RANK = { '1': 1, 's': 2, '2': 3, 'w': 4 };
function seasonKey(name) {
  const m = String(name || '').match(/(\d{2})\s*-\s*([12swSW])(?![0-9])/);
  if (!m) return null;
  return Number(m[1]) * 10 + (SEASON_RANK[m[2].toLowerCase()] || 9);
}
// 기수 표기가 없는 옛 반이 먼저, 그다음 기수 오름차순(오래된 것 → 최근). 같으면 이름순.
function compareClassNames(a, b) {
  const ka = seasonKey(a), kb = seasonKey(b);
  if (ka === null && kb !== null) return -1;
  if (ka !== null && kb === null) return 1;
  if (ka !== null && kb !== null && ka !== kb) return ka - kb;
  return String(a).localeCompare(String(b), 'ko');
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

// 🔑 반 코드 — 학원/반마다 자동 발급되는 5자리 숫자.
//   학생 등록 시 이 코드로 반 자동 배정 + 코드 없으면 등록 불가(스팸 차단).
//
// ⚠️ 자릿수(5)는 register.html 의 입력칸 maxlength / 제출 전 자릿수 검사와 같아야 한다.
//    자릿수를 바꾸려면 아래 genCode() 와 register.html 두 곳을 같이 고칠 것.
function genCode(existing) {
  let code, tries = 0;
  do { code = String(Math.floor(10000 + Math.random() * 90000)); tries++; }
  while (existing && existing.has(code) && tries < 50);
  return code;
}

// 모든 학원/반에 코드가 있도록 보장 + 없어진 반의 코드 정리. 변경되면 true 반환.
function ensureCodes(saved) {
  saved.codes = saved.codes || {};
  const existing = new Set(Object.values(saved.codes));
  let changed = false;
  const validKeys = new Set();
  for (const acad of (saved.academies || [])) {
    for (const cls of (saved.classes[acad] || [])) {
      const key = acad + '/' + cls;
      // 🔴 종강한 반에는 코드를 다시 발급하지 않는다.
      //    이 3줄을 빼먹으면 archive-class 가 코드를 지워도 **다음 GET 한 번에 새 코드가 도로 발급**돼
      //    종강이 조용히 무력화된다(에러도 안 난다 — 반코드만 새 번호로 되살아난다).
      if (isArchivedKey(saved, key)) {
        if (saved.codes[key]) { delete saved.codes[key]; changed = true; }
        continue;
      }
      validKeys.add(key);
      if (!saved.codes[key]) {
        const code = genCode(existing);
        saved.codes[key] = code;
        existing.add(code);
        changed = true;
      }
    }
  }
  for (const key of Object.keys(saved.codes)) {
    if (!validKeys.has(key)) { delete saved.codes[key]; changed = true; }
  }
  return changed;
}

// ⏰ 시간 블록 검증 — { days: [0~6], start: 'HH:MM', end: 'HH:MM' } 형태만 허용. 아니면 null.
function validBlock(s) {
  if (!s || typeof s !== 'object') return null;
  const days = Array.isArray(s.days)
    ? [...new Set(s.days.map(Number))].filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b)
    : [];
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const start = String(s.start || '');
  const end = String(s.end || '');
  if (!days.length || !hm.test(start) || !hm.test(end) || end <= start) return null;
  return { days, start, end };
}

// ⏰ 수업 스케줄 검증 — 본수업 { days, start, end } + 선택 clinic { days, start, end }(클리닉/보충 블록).
//   clinic이 왔는데 형식이 틀리면 전체 거부(null) — 반쪽 저장 방지.
function validSchedule(s) {
  const main = validBlock(s);
  if (!main) return null;
  if (s.clinic != null) {
    const clinic = validBlock(s.clinic);
    if (!clinic) return null;
    main.clinic = clinic;
  }
  return main;
}

// 학생 데이터(D1)에서 실제 사용 중인 학원/반 추출
//
// 🏷️ 2026-08-10 — 세 가지 수를 따로 센다. 셋을 하나로 합치면 반드시 사고가 난다.
//   counts     = **재원생만**(승인 또는 빈 값). 화면의 「학생 N명」과 사람이 판단할 때 쓰는 수.
//   completed  = **수료생**. 「수료 M명」 배지. 종강한 반에 남아 있는 사람들이다.
//   countsAll  = 대기중·거부까지 **전부**. 삭제 안전장치(delete-class/delete-academy) 전용.
//
// ⚠️ 삭제 게이트에 counts(재원)를 쓰면 안 된다. 수료생만 남은 반이 "0명"으로 보여
//    반이 지워지고, 그 반의 출결·리포트가 어느 반 것인지 가리키는 이름이 사라진다.
// ⚠️ academies/classes 는 **상태와 무관하게 전부** 담는다. 수료생 반 이름이 목록에서 사라지면
//    관리자 화면의 반 드롭다운이 그 학생을 첫 번째 반으로 조용히 옮겨 저장해 버린다.
async function getUsedFromStudents(env) {
  const used = { academies: new Set(), classes: {}, counts: {}, completed: {}, countsAll: {} };
  try {
    const students = await listStudents(env);
    for (const s of students) {
      const acad = s.academy || '';
      const cls  = s.className || '';
      if (!acad) continue;
      used.academies.add(acad);
      if (!used.classes[acad]) used.classes[acad] = new Set();
      if (!cls) continue;
      used.classes[acad].add(cls);
      const key = acad + '/' + cls;
      used.countsAll[key] = (used.countsAll[key] || 0) + 1;
      if (isEnrolled(s.approvalStatus))       used.counts[key]    = (used.counts[key] || 0) + 1;
      else if (isCompleted(s.approvalStatus)) used.completed[key] = (used.completed[key] || 0) + 1;
    }
  } catch (_) {}
  return used;
}

function mergeOptions(saved, used) {
  const result = { academies: [], classes: {}, counts: {} };
  const allAcademies = new Set([...(saved.academies || []), ...used.academies]);
  for (const acad of allAcademies) {
    const savedCls = new Set(saved.classes?.[acad] || []);
    const usedCls = used.classes[acad] || new Set();
    const allCls = new Set([...savedCls, ...usedCls]);
    result.classes[acad] = Array.from(allCls).sort(compareClassNames);
  }
  result.academies = Array.from(allAcademies).sort();
  result.counts = used.counts;
  result.completed = used.completed;
  result.countsAll = used.countsAll;
  result.codes = saved.codes || {};
  result.schedules = saved.schedules || {};
  // 🏷️ 종강한 반 키 목록 — admin.html 이 「지난 반」으로 접는 근거. 목록에서 빼지는 않는다.
  result.archived = Object.keys(saved.archived || {});
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
    const url = new URL(request.url);
    const codeQ = (url.searchParams.get('code') || '').replace(/[^0-9]/g, '');

    // ═══════════════════════════════════════════════════════════════════════════
    // 🔒 2026-08-03 (§11-16) — 「코드로 반 찾기」는 원장 전용 (관우T 확정)
    //
    //   예전엔 등록 페이지가 학부모가 코드를 타이핑하는 도중에 이 창구로
    //   「이 코드 맞아?」를 물어보고 반 이름을 화면에 띄웠다. 편했지만,
    //   이 창구는 로그인 없이 누구나 몇 번이든 두드릴 수 있는 문이었다.
    //   코드는 5자리 숫자(10000~99999 = 9만 가지)뿐이라, 자동 프로그램이
    //   순서대로 훑으면 실제 반 코드를 알아내 가짜 신청을 밀어넣을 수 있었다.
    //
    //   → 등록 페이지의 즉시확인을 없앴고(register.html), 창구 자체도 여기서 잠근다.
    //     이제 코드 판정은 가입 신청(POST /api/student-register) 한 곳에서만 일어나고,
    //     거기엔 같은 IP 기준 횟수 제한(_lockout.js 의 gate*)이 걸려 있다.
    //     학부모는 「등록 완료」 화면에서 배정된 학원·반을 확인한다.
    //
    //   ⚠️ 되살리지 말 것 — 공개로 되돌리려면 반드시 _lockout.js 의 gate* 잠금을
    //      이 분기에 함께 걸어야 한다. 잠금 없는 공개 조회 = 코드 전수 대입 허용.
    //   ⚠️ 잠금 검사가 아니라 권한 검사이므로 R2/D1 읽기(loadOptions·getUsedFromStudents)
    //      **앞**에 둔다. 권한 없는 요청에 저장소 비용이 나가지 않게.
    // ═══════════════════════════════════════════════════════════════════════════
    if (codeQ && !isAdmin(request, env)) {
      return Response.json({
        valid: false,
        error: '반 코드는 등록 신청을 접수할 때 확인됩니다.',
      }, { status: 403 });
    }

    const saved = await loadOptions(env);
    const used  = await getUsedFromStudents(env);
    // 학생 데이터에서 사용 중인 학원/반을 R2 saved에 자동 흡수 (한 번 등록되면 학생 0명이 돼도 남음)
    await syncStudentClassesToSaved(env, saved, used);
    // 모든 반에 코드 보장 (기존 반도 첫 호출 때 코드 자동 생성·저장)
    if (ensureCodes(saved)) await saveOptions(env, saved);

    // 🔑 반 코드 조회 — **원장 전용**(위 403 관문을 통과한 요청만 여기 온다).
    //    관우T가 관리자 화면에서 「이 코드가 어느 반이지?」를 확인할 때 쓴다.
    //    매칭 1건만 반환(전체 목록은 비노출).
    if (codeQ) {
      for (const acad of saved.academies) {
        for (const cls of (saved.classes[acad] || [])) {
          if (saved.codes[acad + '/' + cls] === codeQ) {
            return Response.json({ valid: true, academy: acad, className: cls });
          }
        }
      }
      return Response.json({ valid: false });
    }

    const merged = mergeOptions(saved, used);
    // 🔒 인원 수(counts)·반코드(codes)는 admin 전용 — 비로그인 공개 노출 차단.
    //    학원/반 "이름"은 등록 폼에 필요해서 공개 유지.
    if (!isAdmin(request, env)) {
      // 🏷️ 종강한 반은 공개 목록(등록 폼)에서 아예 뺀다 — 지난 반에 새로 가입 신청이 붙지 않게.
      //    반코드도 이미 폐기돼 있으니 이건 2차 방어다. 삭제하는 게 아니라 안 보여줄 뿐.
      //    (merged.archived 를 지우기 **전에** 걸러야 한다. 순서를 뒤집으면 필터가 빈 목록으로 도는데 에러는 안 난다.)
      const archivedSet = new Set(merged.archived || []);
      if (archivedSet.size) {
        for (const acad of Object.keys(merged.classes)) {
          merged.classes[acad] = (merged.classes[acad] || []).filter(c => !archivedSet.has(acad + '/' + c));
        }
      }
      delete merged.counts;
      delete merged.completed;
      delete merged.countsAll;
      delete merged.codes;
      delete merged.schedules;  // 수업 시간표(내부 운영 정보)도 admin 전용
      delete merged.archived;
    }
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
    // 🔎 2026-07-31 — 아래 분기들은 saved 를 **그 자리에서** 뜯어고친다(in-place).
    //   손대기 전에 통째로 복사해 두지 않으면 로그의 "전" 값이 "후"와 같아져 아무 의미가 없다.
    //   (staff-approve.js 에서 똑같은 함정을 겪었다.)
    const 전체전 = JSON.parse(JSON.stringify(saved));
    const 반목록 = (o, a) => ((o.classes && o.classes[a]) || []).slice();

    if (action === 'add-academy') {
      if (!academy) return Response.json({ error: 'academy 필요' }, { status: 400 });
      const 이미있음 = saved.academies.includes(academy);
      if (!saved.academies.includes(academy)) saved.academies.push(academy);
      if (!saved.classes[academy]) saved.classes[academy] = [];
      await saveOptions(env, saved);
      await logAudit(env, request, {
        action: 'class.academy.add', target: academy, targetName: academy,
        summary: '학원 추가 [' + academy + ']' + (이미있음 ? ' — 이미 있던 학원(변화 없음)' : '')
          + ' · 학원 ' + 전체전.academies.length + '개 → ' + saved.academies.length + '개',
        detail: {
          학원: academy, 이미있던학원: 이미있음,
          학원목록: { 전: 전체전.academies, 후: saved.academies },
          비고: '학원만 만들었을 뿐 반은 없음 — 반을 추가해야 반코드가 발급되고 학생이 가입할 수 있다',
        },
      });
      return Response.json({ ok: true, action, academy });
    }

    if (action === 'delete-academy') {
      if (!academy) return Response.json({ error: 'academy 필요' }, { status: 400 });
      const used = await getUsedFromStudents(env);
      if (used.academies.has(academy)) {
        return Response.json({ error: `학원 [${academy}]에 학생이 있어서 삭제할 수 없습니다.` }, { status: 409 });
      }
      // ⚠️ 학원 하나를 지우면 그 밑의 반·반코드·수업시간표가 **통째로** 딸려 사라진다.
      //   지워질 것들을 먼저 붙잡아 둔다 — 잘못 지웠을 때 이 로그만 보고 되살릴 수 있어야 한다.
      const 지워질반 = 반목록(전체전, academy);
      const 지워질코드 = {};
      for (const k of Object.keys(전체전.codes || {})) if (k.startsWith(academy + '/')) 지워질코드[k] = 전체전.codes[k];
      const 지워질시간표 = {};
      for (const k of Object.keys(전체전.schedules || {})) if (k.startsWith(academy + '/')) 지워질시간표[k] = 전체전.schedules[k];

      saved.academies = saved.academies.filter(a => a !== academy);
      delete saved.classes[academy];
      if (saved.codes) for (const k of Object.keys(saved.codes)) { if (k.startsWith(academy + '/')) delete saved.codes[k]; }
      if (saved.schedules) for (const k of Object.keys(saved.schedules)) { if (k.startsWith(academy + '/')) delete saved.schedules[k]; }
      if (saved.archived) for (const k of Object.keys(saved.archived)) { if (k.startsWith(academy + '/')) delete saved.archived[k]; }
      await saveOptions(env, saved);
      await logAudit(env, request, {
        action: 'class.academy.delete', target: academy, targetName: academy,
        summary: '학원 삭제 [' + academy + '] — 반 ' + 지워질반.length + '개 · 반코드 '
          + Object.keys(지워질코드).length + '개 · 수업시간표 ' + Object.keys(지워질시간표).length + '개 함께 삭제 (복구 불가)',
        detail: {
          학원: academy,
          지워진반: 지워질반,
          지워진반코드: 지워질코드,
          지워진수업시간표: 지워질시간표,
          학원목록: { 전: 전체전.academies, 후: saved.academies },
          안전장치: '학생이 한 명이라도 있으면 409로 막힘 — 여기까지 왔다는 건 소속 학생 0명',
          영향: '지워진 반코드로는 더 이상 학생 가입이 안 된다 · 수업시간표 기반 리마인드(출결·리포트 미입력)도 멈춘다',
        },
      });
      return Response.json({ ok: true, action, academy });
    }

    if (action === 'add-class') {
      if (!academy || !className) return Response.json({ error: 'academy, className 둘 다 필요' }, { status: 400 });
      // 🏷️ 종강한 반과 이름이 같으면 막는다. 조용히 되살리면 「지난 반」에 새 학생이 섞이고,
      //    수업영상 매칭(학원+반 이름)이 옛 기수 영상을 새 학생에게 그대로 열어준다.
      if (isArchivedKey(saved, academy + '/' + className)) {
        return Response.json({
          error: `[${academy} · ${className}] 은 종강된 반입니다. 그 반을 다시 열려면 「종강 취소」를 누르시고, `
            + `새 학기 반이라면 기수를 붙여 새 이름으로 만들어 주세요. (예: ${className.replace(/\s*\(\d{2}-[12sw]\)\s*$/i, '')} (26-2))`,
          archived: true,
        }, { status: 409 });
      }
      if (!saved.academies.includes(academy)) saved.academies.push(academy);
      if (!saved.classes[academy]) saved.classes[academy] = [];
      if (!saved.classes[academy].includes(className)) saved.classes[academy].push(className);
      // 🔑 반 생성 시 코드 자동 발급
      saved.codes = saved.codes || {};
      const ckey = academy + '/' + className;
      const 코드전 = (전체전.codes || {})[ckey] || null;
      if (!saved.codes[ckey]) saved.codes[ckey] = genCode(new Set(Object.values(saved.codes)));
      await saveOptions(env, saved);
      await logAudit(env, request, {
        action: 'class.add', target: ckey, targetName: className,
        summary: '반 추가 [' + academy + ' · ' + className + '] · 반코드 '
          + (코드전 ? 코드전 + '(기존 유지)' : saved.codes[ckey] + '(새로 발급)')
          + (전체전.academies.includes(academy) ? '' : ' · 학원 [' + academy + ']도 새로 만들어짐'),
        detail: {
          학원: academy, 반: className,
          이미있던반: 반목록(전체전, academy).includes(className),
          반코드: { 전: 코드전 || '(없음)', 후: saved.codes[ckey], 새로발급: !코드전 },
          반목록: { 전: 반목록(전체전, academy), 후: 반목록(saved, academy) },
          학원도새로생김: !전체전.academies.includes(academy),
          비고: '이 반코드를 학생에게 알려줘야 가입 시 자동 배정된다(코드 없으면 가입 불가)',
        },
      });
      return Response.json({ ok: true, action, academy, className, code: saved.codes[ckey] });
    }

    if (action === 'delete-class') {
      if (!academy || !className) return Response.json({ error: 'academy, className 둘 다 필요' }, { status: 400 });
      const used = await getUsedFromStudents(env);
      const key = academy + '/' + className;
      // 🔴 삭제 게이트는 **countsAll**(대기중·거부·수료 전부)을 본다. counts(재원)로 보면
      //    수료생만 남은 종강 반이 "0명"으로 보여 지워지고, 그 학생들의 출결·리포트가
      //    어느 반 것인지 가리키던 이름이 사라진다.
      const count = used.countsAll[key] || 0;
      if (count > 0) {
        const 재원 = used.counts[key] || 0;
        const 수료 = used.completed[key] || 0;
        const 내역 = 수료 > 0 ? ` (재원 ${재원}명 · 수료 ${수료}명)` : '';
        return Response.json({
          error: `[${academy} · ${className}]에 학생 ${count}명이 있어서 삭제할 수 없습니다.${내역}`
            + (수료 > 0 ? ' 수료생이 있는 반은 지우지 마세요 — 「종강」으로 접으면 목록에서 내려가고 기록은 그대로 남습니다.' : ' (먼저 이동하거나 퇴원 처리)'),
        }, { status: 409 });
      }
      const 코드전 = (전체전.codes || {})[key] || null;
      const 시간표전 = (전체전.schedules || {})[key] || null;
      saved.classes[academy] = (saved.classes[academy] || []).filter(c => c !== className);
      if (saved.codes) delete saved.codes[academy + '/' + className];
      if (saved.schedules) delete saved.schedules[academy + '/' + className];
      // 반이 사라지면 「지난 반」 표시도 같이 사라져야 한다 — 안 지우면 없는 반이 archived 에 영영 남는다.
      if (saved.archived) delete saved.archived[key];
      await saveOptions(env, saved);
      await logAudit(env, request, {
        action: 'class.delete', target: key, targetName: className,
        summary: '반 삭제 [' + academy + ' · ' + className + '] — 반코드 ' + (코드전 || '(없었음)') + ' 폐기'
          + (시간표전 ? ' · 수업시간표도 삭제' : '') + ' (복구 불가)',
        detail: {
          학원: academy, 반: className,
          지워진반코드: 코드전 || '(없었음)',
          지워진수업시간표: 시간표전 || '(설정 안 돼 있었음)',
          반목록: { 전: 반목록(전체전, academy), 후: 반목록(saved, academy) },
          안전장치: '학생이 있으면 409로 막힘 — 여기까지 왔다는 건 소속 학생 0명',
          영향: '이 반코드로는 더 이상 가입 불가 · 시간표 기반 리마인드도 멈춤. 같은 이름으로 다시 만들면 코드는 새 번호로 발급된다',
        },
      });
      return Response.json({ ok: true, action, academy, className });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 🏷️ 반 종강 (2026-08-10, 관우T 확정) — 「퇴원」을 대신하는 학기 마감 도구.
    //
    //   왜 만들었나: 학기가 끝나면 안 다니는 학생이 생기는데, 그동안은 학생 행을 지우는 것
    //   말고는 방법이 없었다. 그런데 그 행 하나가 ① 로그인 열쇠 ② 수업 명단 ③ 반 소속을
    //   동시에 쥐고 있어서, 지우는 순간 셋이 한꺼번에 끊겼다 — 앱이 아예 안 열리고,
    //   그동안 쌓인 리포트도 학부모 눈에서 사라졌다.
    //
    //   종강이 하는 일 — 지우는 건 하나도 없다:
    //     · 반코드 폐기        → 그 코드로는 더 이상 가입 안 됨
    //     · 수업시간표 해제    → 출결·리포트 미입력 리마인드가 이 반을 그만 찾음
    //     · 재원생 전원 '수료' → 앱 로그인·리포트·성적은 그대로, 수업영상만 잠김
    //     · 「지난 반」으로 접힘 → 관리자 목록과 등록 폼에서 내려감
    //   출결·학습기록·리포트·성적은 **단 하나도 건드리지 않는다.**
    //
    //   ⚠️ 대기중·거부 학생은 손대지 않는다. 승인 흐름은 종강과 별개 문제다.
    // ═══════════════════════════════════════════════════════════════════════════
    if (action === 'archive-class') {
      if (!academy || !className) return Response.json({ error: 'academy, className 둘 다 필요' }, { status: 400 });
      const key = academy + '/' + className;
      if (isArchivedKey(saved, key)) {
        return Response.json({ error: `[${academy} · ${className}] 은 이미 종강된 반입니다.` }, { status: 409 });
      }
      if (!(saved.classes[academy] || []).includes(className)) {
        return Response.json({ error: `[${academy} · ${className}] 반이 없습니다.` }, { status: 404 });
      }

      // 이번 종강이 실제로 바꾼 사람만 기록한다 — 원래부터 수료였던 학생까지 되살리면 안 되므로.
      const students = await listStudents(env);
      const 대상 = students.filter(s =>
        (s.academy || '') === academy && (s.className || '') === className && isEnrolled(s.approvalStatus));
      const 바꾼결과 = await setApprovalStatusBulk(env, 대상.map(s => s.id), STATUS_COMPLETED);
      if (!바꾼결과.ok) {
        // R2를 건드리기 **전에** 멈춘다. 반은 접혔는데 학생은 재원인 어중간한 상태를 만들지 않기 위함.
        return Response.json({ error: '학생 수료 처리 중 오류 — 종강을 취소했습니다: ' + (바꾼결과.error || '알 수 없음') }, { status: 500 });
      }

      const 코드전 = (전체전.codes || {})[key] || null;
      const 시간표전 = (전체전.schedules || {})[key] || null;
      saved.archived = saved.archived || {};
      saved.archived[key] = {
        at: new Date().toISOString(),
        students: 대상.map(s => s.id),
        prevCode: 코드전 || null,
        prevSchedule: 시간표전 || null,
      };
      if (saved.codes) delete saved.codes[key];
      if (saved.schedules) delete saved.schedules[key];
      await saveOptions(env, saved);
      await logAudit(env, request, {
        action: 'class.archive', target: key, targetName: className,
        summary: '반 종강 [' + academy + ' · ' + className + '] — 재원생 ' + 대상.length + '명 수료 처리 · 반코드 '
          + (코드전 || '(없었음)') + ' 폐기' + (시간표전 ? ' · 수업시간표 해제' : ''),
        detail: {
          학원: academy, 반: className,
          수료로바뀐학생: 대상.map(s => ({ id: s.id, 이름: s.name || '', 전: s.approvalStatus || '(빈값)' })),
          실제변경행수: 바꾼결과.changed,
          폐기된반코드: 코드전 || '(없었음)',
          해제된수업시간표: 시간표전 || '(설정 안 돼 있었음)',
          지운것: '없음 — 출결·학습기록·리포트·성적은 그대로다',
          영향: '이 반 학생은 앱 로그인·리포트·성적은 되고 수업영상만 잠긴다 · 이 반코드로는 가입 불가 · 리마인드 대상에서 빠짐',
          되돌리기: '「종강 취소」(unarchive-class) — 이번에 바뀐 ' + 대상.length + '명만 재원으로 되돌린다',
        },
      });
      return Response.json({ ok: true, action, academy, className, completed: 대상.length });
    }

    // 🏷️ 종강 취소 — 잘못 눌렀을 때. 이번 종강이 수료로 바꾼 그 사람들만 정확히 되돌린다.
    //   ⚠️ "그 반의 수료생 전원"을 되돌리면 안 된다. 종강 전부터 개별 수료였던 학생까지 재원으로 살아난다.
    if (action === 'unarchive-class') {
      if (!academy || !className) return Response.json({ error: 'academy, className 둘 다 필요' }, { status: 400 });
      const key = academy + '/' + className;
      const meta = (saved.archived || {})[key];
      if (!meta) return Response.json({ error: `[${academy} · ${className}] 은 종강된 반이 아닙니다.` }, { status: 404 });

      const 되돌릴ids = Array.isArray(meta.students) ? meta.students : [];
      const 되돌린결과 = await setApprovalStatusBulk(env, 되돌릴ids, '승인');
      if (!되돌린결과.ok) {
        return Response.json({ error: '학생 복귀 처리 중 오류 — 종강 취소를 멈췄습니다: ' + (되돌린결과.error || '알 수 없음') }, { status: 500 });
      }

      delete saved.archived[key];
      if (!(saved.classes[academy] || []).includes(className)) {
        if (!saved.academies.includes(academy)) saved.academies.push(academy);
        if (!saved.classes[academy]) saved.classes[academy] = [];
        saved.classes[academy].push(className);
      }
      if (meta.prevSchedule) { saved.schedules = saved.schedules || {}; saved.schedules[key] = meta.prevSchedule; }
      // 🔑 반코드는 **새 번호로** 발급된다(ensureCodes). 옛 코드를 되살리지 않는 건 일부러다 —
      //    종강 안내와 함께 옛 코드가 이미 밖으로 돌았을 수 있다.
      ensureCodes(saved);
      await saveOptions(env, saved);
      await logAudit(env, request, {
        action: 'class.unarchive', target: key, targetName: className,
        summary: '반 종강 취소 [' + academy + ' · ' + className + '] — 학생 ' + 되돌릴ids.length + '명 재원 복귀 · 반코드 '
          + (saved.codes[key] || '(발급 실패)') + ' 새로 발급' + (meta.prevSchedule ? ' · 수업시간표 복원' : ''),
        detail: {
          학원: academy, 반: className,
          종강했던시각: meta.at || '(기록 없음)',
          재원으로되돌린학생id: 되돌릴ids,
          실제변경행수: 되돌린결과.changed,
          반코드: { 종강전: meta.prevCode || '(없었음)', 지금: saved.codes[key] || '(발급 실패)' },
          주의: '되돌린 건 이번 종강이 수료로 바꾼 학생뿐 — 그 전부터 수료였던 학생은 그대로다',
          반코드가바뀐이유: '종강 안내와 함께 옛 코드가 밖으로 돌았을 수 있어 일부러 새 번호로 발급한다',
        },
      });
      return Response.json({ ok: true, action, academy, className, restored: 되돌릴ids.length, code: saved.codes[key] || null });
    }

    // ⏰ 수업 스케줄 설정/해제 — body.schedule = { days, start, end } 또는 null(해제)
    if (action === 'set-schedule') {
      if (!academy || !className) return Response.json({ error: 'academy, className 둘 다 필요' }, { status: 400 });
      const exists = (saved.classes[academy] || []).includes(className);
      if (!exists) return Response.json({ error: `[${academy} · ${className}] 반이 없습니다. 먼저 반을 추가하세요.` }, { status: 404 });
      // 종강한 반에 수업시간을 다시 걸면 리마인드가 되살아난다 — 끝난 반 출결을 매주 재촉하게 된다.
      if (isArchivedKey(saved, academy + '/' + className)) {
        return Response.json({ error: `[${academy} · ${className}] 은 종강된 반이라 수업시간을 설정할 수 없습니다. 먼저 「종강 취소」를 눌러 주세요.` }, { status: 409 });
      }
      saved.schedules = saved.schedules || {};
      const skey = academy + '/' + className;
      const 시간표전 = (전체전.schedules || {})[skey] || null;
      // 사람이 읽는 요약: "월수금 09:30~13:30 (+클리닉 월수금 14:00~16:00)"
      const 요일이름 = ['일', '월', '화', '수', '목', '금', '토'];
      const 읽기 = (b) => b ? ((b.days || []).map(d => 요일이름[d] || d).join('') + ' ' + b.start + '~' + b.end
        + (b.clinic ? ' (+클리닉 ' + (b.clinic.days || []).map(d => 요일이름[d] || d).join('') + ' ' + b.clinic.start + '~' + b.clinic.end + ')' : ''))
        : '(없음)';

      if (body.schedule == null) {
        delete saved.schedules[skey];
        await saveOptions(env, saved);
        await logAudit(env, request, {
          action: 'class.schedule.clear', target: skey, targetName: className,
          summary: '수업시간표 해제 [' + academy + ' · ' + className + '] — 전: ' + 읽기(시간표전),
          detail: {
            학원: academy, 반: className,
            지워진시간표: 시간표전 || '(원래 없었음)',
            지워진시간표읽기: 읽기(시간표전),
            영향: '이 반은 이제 수업시간 기준 자동 점검(출결·리포트 미입력 리마인드) 대상에서 빠진다',
          },
        });
        return Response.json({ ok: true, action, academy, className, schedule: null });
      }
      const sch = validSchedule(body.schedule);
      if (!sch) return Response.json({ error: '스케줄 형식 오류 — days(요일 1개 이상, 0=일~6=토), start/end(HH:MM, 시작<종료) 필요. clinic(선택)도 같은 형식.' }, { status: 400 });
      saved.schedules[skey] = sch;
      await saveOptions(env, saved);
      await logAudit(env, request, {
        action: 시간표전 ? 'class.schedule.update' : 'class.schedule.set',
        target: skey, targetName: className,
        summary: '수업시간표 ' + (시간표전 ? '변경' : '설정') + ' [' + academy + ' · ' + className + '] — '
          + (시간표전 ? 읽기(시간표전) + ' → ' : '') + 읽기(sch),
        detail: {
          학원: academy, 반: className,
          전: 시간표전 || '(설정 안 돼 있었음)', 후: sch,
          전읽기: 읽기(시간표전), 후읽기: 읽기(sch),
          클리닉블록: sch.clinic ? '있음' : (시간표전 && 시간표전.clinic ? '⚠️ 원래 있었는데 이번에 없어짐' : '없음'),
          영향: '수업시간 기준 자동 점검(출결·리포트 미입력 리마인드)의 판단 기준이 바뀐다',
        },
      });
      return Response.json({ ok: true, action, academy, className, schedule: sch });
    }

    return Response.json({ error: 'action: add-class | delete-class | archive-class | unarchive-class | add-academy | delete-academy | set-schedule' }, { status: 400 });
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}

// 🔑 학생 등록(student-register.js)에서 import — 반 코드 → { academy, className } 서버측 권위 검증.
//   코드가 없거나 매칭 안 되면 null. (코드 없는 기존 반은 여기서도 자동 백필·저장)
export async function resolveClassCode(env, code) {
  const codeQ = String(code || '').replace(/[^0-9]/g, '');
  if (!codeQ) return null;
  const saved = await loadOptions(env);
  if (ensureCodes(saved)) await saveOptions(env, saved);
  for (const acad of saved.academies) {
    for (const cls of (saved.classes[acad] || [])) {
      const key = acad + '/' + cls;
      // 🏷️ 종강한 반의 코드로는 가입되지 않는다. ensureCodes 가 이미 코드를 지우므로 실제로는
      //    여기까지 오지 않지만, 가입 관문이라 한 겹 더 둔다.
      if (isArchivedKey(saved, key)) continue;
      if (saved.codes[key] === codeQ) return { academy: acad, className: cls };
    }
  }
  return null;
}

// ⏰ 관리자 리마인드 체크(추후 /api/admin-reminders 등)에서 import.
//   반환: { "학원/반": { days: [1,3,5], start: "09:30", end: "13:30" }, ... }
//   사용 예: KST 오늘 요일이 days에 포함된 반만 골라 출결/리포트 존재 여부를 D1에서 확인 → 없으면 __admin__ 푸시.
export async function loadClassSchedules(env) {
  const saved = await loadOptions(env);
  return saved.schedules || {};
}
