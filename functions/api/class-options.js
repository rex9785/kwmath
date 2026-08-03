import { listStudents } from './_db.js';
import { logAudit } from './_auditlog.js';
// 🛡️ §11-16 — 이 파일은 _lockout.js 를 쓰지 않는다.
//    「코드로 반 찾기(GET ?code=)」를 원장 전용으로 잠갔기 때문에(아래 onRequest 참고)
//    공개로 두드릴 수 있는 문이 남아 있지 않다. 잠금이 필요한 곳은
//    가입 신청(POST /api/student-register) 한 곳뿐이고, 거기에만 걸려 있다.
//    ⚠️ ?code= 를 다시 공개로 되돌린다면 반드시 _lockout.js 의 gate* 잠금을 함께 걸 것.
// /api/class-options
//   GET  — 공개 (누구나 호출). R2의 학원/반 옵션 + 실제 학생 데이터에서 사용 중인 옵션 합집합 반환
//   POST — admin only. body: { action: 'add-class'|'delete-class'|'add-academy'|'delete-academy'|'set-schedule', academy, className?, schedule? }
//
// 저장 위치: R2 key `auth/class-options.json`
// 형식: { academies: [...], classes: { [academy]: [class1, ...] },
//         codes: { "학원/반": "12345" },
//         schedules: { "학원/반": { days: [1,3,5], start: "09:30", end: "13:30", clinic?: { days, start, end } } } }
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

// 학생 데이터에서 실제 사용 중인 학원/반 추출 (active만)
// 학생 데이터(D1)에서 실제 사용 중인 학원/반 추출
async function getUsedFromStudents(env) {
  const used = { academies: new Set(), classes: {}, counts: {} };
  try {
    const students = await listStudents(env);
    for (const s of students) {
      const acad = s.academy || '';
      const cls  = s.className || '';
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
  result.codes = saved.codes || {};
  result.schedules = saved.schedules || {};
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
      delete merged.counts;
      delete merged.codes;
      delete merged.schedules;  // 수업 시간표(내부 운영 정보)도 admin 전용
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
      const count = used.counts[key] || 0;
      if (count > 0) {
        return Response.json({ error: `[${academy} · ${className}]에 학생 ${count}명이 있어서 삭제할 수 없습니다. (먼저 이동하거나 퇴원 처리)` }, { status: 409 });
      }
      const 코드전 = (전체전.codes || {})[key] || null;
      const 시간표전 = (전체전.schedules || {})[key] || null;
      saved.classes[academy] = (saved.classes[academy] || []).filter(c => c !== className);
      if (saved.codes) delete saved.codes[academy + '/' + className];
      if (saved.schedules) delete saved.schedules[academy + '/' + className];
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

    // ⏰ 수업 스케줄 설정/해제 — body.schedule = { days, start, end } 또는 null(해제)
    if (action === 'set-schedule') {
      if (!academy || !className) return Response.json({ error: 'academy, className 둘 다 필요' }, { status: 400 });
      const exists = (saved.classes[academy] || []).includes(className);
      if (!exists) return Response.json({ error: `[${academy} · ${className}] 반이 없습니다. 먼저 반을 추가하세요.` }, { status: 404 });
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

    return Response.json({ error: 'action: add-class | delete-class | add-academy | delete-academy | set-schedule' }, { status: 400 });
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
      if (saved.codes[acad + '/' + cls] === codeQ) return { academy: acad, className: cls };
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
