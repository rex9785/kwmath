// /api/today-tasks  (GET)  — 홈 「오늘 확인할 것」의 **시간 기반** 줄
// ───────────────────────────────────────────────────────────
// 왜 만들었나 (2026-08-03 관우T 지시: "맨 위 오늘 할 일이 항상 비어 있다.
//   출결할 시간이라는 둥 조교 총평 확인하라는 둥 그런 게 떠야 한다")
//   기존 홈 요약(admin.html loadHomeSummary / staff-home.html loadTodo)은
//   **"남이 나를 기다리는 밀린 건수"만** 셌다 — 새 문의·안 읽은 질문·승인 대기 같은 것들.
//   그날 아무도 안 물어보면 0건이 되고, 0건은 줄을 안 그리므로 박스가 통째로 빈다.
//   정작 매일 반복되는 "지금 출결 찍을 시간 / 영상 올릴 시간 / 리포트 만들 시간"은
//   **시각**으로 판단해야 하는데 그 축이 아예 없었다. 이 endpoint가 그 축을 담당한다.
//
// 기준 데이터: R2 auth/class-options.json 의 schedules
//   { "학원/반": { days:[1,3,5], start:"09:30", end:"13:30", clinic?:{days,start,end} } }
//   admin.html 🏫 학원·반 관리에서 🕘 칩으로 설정. **시간표 없는 반은 판단 대상이 아니다**
//   (그래서 "시간표가 하나도 없다"는 사실 자체를 diag로 돌려준다 — 조용히 비는 것보다 낫다).
//
// 푸시(admin-reminders.js)와의 관계 — 둘은 목적이 다르다.
//   푸시  : 안 보고 있어도 폰을 울린다. 반별 하루 1회·심야 차단·멱등 상태 저장.
//   이 API: 앱을 열었을 때 "지금 뭐가 남았나"를 보여준다. 하루 몇 번을 열든 사실대로.
//   그래서 여기엔 멱등 상태도 심야 게이트도 없다. 남아 있으면 남아 있다고 계속 보여준다.
//
// 비용 — 홈을 열 때마다 도는 조회라 무겁게 만들면 안 된다.
//   D1: 학생 명단 1 + 반당 출결/리포트 COUNT + 클리닉 2 (하루치 통째)
//   R2: 시간표 1건 + 영상 목록 list 1회(본문은 최근 업로드분만 골라서 읽음 — 아래 주석)
// ───────────────────────────────────────────────────────────
import { loadClassSchedules } from './class-options.js';
import { listStudents, listClinicByDate, listClinicReviewsByDate } from './_db.js';
import { staffScopeAcademy } from './_staff.js';

// ⏱️ 언제부터 "할 시간"으로 볼 것인가 — 숫자만 고치면 기준이 바뀐다.
//   너무 이르면 아직 안 해도 되는 일이 떠서 눈이 무시하게 되고, 너무 늦으면 까먹은 뒤에 뜬다.
const 출결_시작후분 = 10;    // 수업 시작 +10분 — 출석 부르고 바로 찍으신다(2026-08-03 관우T 확정).
                             //   푸시 리마인드(admin-reminders.js)는 +30분 그대로다. 일부러 어긋나 있다 —
                             //   저건 "폰을 울려 방해하는" 것이고 이건 "앱을 열었을 때 보이는" 것이라 기준이 달라야 한다.
const 영상_종료후분 = 30;    // 수업 종료 +30분 — 정리하고 올릴 시간
const 리포트_종료후분 = 120; // 수업 종료 +2시간 — 영상 분석(MathOS)까지 감안
const 조교총평_시작후분 = 30; // 클리닉 시작 +30분 — 조교가 쓰기 시작할 시점

const 요일이름 = ['일', '월', '화', '수', '목', '금', '토'];

// 학원·반 이름 대조는 리포 전체가 이 정규화를 쓴다(class-videos.js·makeup-class.js·makeup-videos.js·save-video-code.js).
//   "대치동 정규반" ↔ "대치동정규반" 같은 띄어쓰기 차이로 영상이 "없다"고 잘못 재촉하지 않게 여기서도 똑같이 맞춘다.
const norm = (s) => (s || '').toString().replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();
const 반키 = (학원, 반) => norm(학원) + '/' + norm(반);

function kstNow() {
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  const y = k.getUTCFullYear(), m = k.getUTCMonth() + 1, d = k.getUTCDate();
  return {
    dateStr: y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'),
    dow: k.getUTCDay(),
    minutes: k.getUTCHours() * 60 + k.getUTCMinutes(),
    hhmm: String(k.getUTCHours()).padStart(2, '0') + ':' + String(k.getUTCMinutes()).padStart(2, '0'),
  };
}

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(v) ? v : null;
}

// D1 한 쿼리의 바인딩 개수 한계를 피해 90개씩 끊어 COUNT를 합산 (admin-reminders.js와 같은 방식).
async function countChunked(env, sqlHead, list, dateStr) {
  let total = 0;
  for (let i = 0; i < list.length; i += 90) {
    const chunk = list.slice(i, i + 90);
    if (!chunk.length) continue;
    const r = await env.DB.prepare(sqlHead + chunk.map(() => '?').join(',') + ')')
      .bind(dateStr, ...chunk).first();
    total += (r && Number(r.c)) || 0;
  }
  return total;
}

// 📺 오늘 수업 영상이 R2에 올라와 있나 — { "학원/반": true } 로 돌려준다.
//   ⚠️ video-list.js 는 최대 500개 JSON을 **전부** 읽는다(영상 관리 탭 전용). 홈에서 그걸 매번 하면 안 된다.
//   그래서 목록(list)만 한 번 부르고, **어제 이후에 올라온 파일의 본문만** 읽는다.
//   오늘 수업 영상은 오늘(또는 넘어가며 어제 밤) 올라올 수밖에 없으므로 이 범위면 충분하고,
//   오래된 파일 수백 개를 읽는 비용이 사라진다. 실패하면 null — 판단을 포기하고 줄을 안 그린다.
async function todayVideoMap(env, dateStr) {
  try {
    const 어제0시 = Date.parse(dateStr + 'T00:00:00+09:00') - 86400 * 1000;
    const listed = await env.BUCKET.list({ prefix: 'video-codes/', limit: 500 });
    const 최근 = (listed.objects || []).filter((o) => {
      const t = o && o.uploaded ? new Date(o.uploaded).getTime() : 0;
      return t >= 어제0시;
    });
    const map = {};
    for (const obj of 최근) {
      try {
        const item = await env.BUCKET.get(obj.key);
        if (!item) continue;
        const v = JSON.parse(await item.text());
        if (!v || String(v.date || '') !== dateStr) continue;
        map[반키(v.school, v.class_name)] = true;
      } catch (_) { /* 파일 하나가 깨져도 나머지는 본다 */ }
    }
    return map;
  } catch (_) {
    return null;   // 목록 자체를 못 받음 → "영상 업로드" 판단 불가
  }
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return Response.json({ ok: false, error: 'GET only' }, { status: 405 });

  // 미들웨어가 원장/조교 세션을 검증한 뒤 Bearer를 ADMIN_PASSWORD로 번역해 준다.
  const auth = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || auth !== env.ADMIN_PASSWORD) {
    return Response.json({ ok: false, error: '인증이 필요합니다.' }, { status: 401 });
  }
  const scopeAcademy = await staffScopeAcademy(env, request);   // null=원장 · ''=미배정 조교 · '학원명'=조교
  const isOwner = scopeAcademy === null;

  const now = kstNow();
  const out = {
    ok: true, date: now.dateStr, hhmm: now.hhmm, dow: now.dow,
    role: isOwner ? 'owner' : 'staff',
    items: [], diag: {},
  };

  let schedules = {};
  try { schedules = await loadClassSchedules(env); } catch (_) {
    out.diag.schedulesFailed = true;
    return Response.json(out);
  }

  // 조교는 자기 학원 반만 본다(다른 학원 시간표는 애초에 계산에 넣지 않는다).
  const 전체키 = Object.keys(schedules).filter((k) => {
    if (isOwner) return true;
    if (!scopeAcademy) return false;               // 학원 미배정 조교 → 대상 없음
    return k.slice(0, k.indexOf('/')) === scopeAcademy;
  });
  out.diag.configured = 전체키.length;
  if (!전체키.length) { out.diag.noSchedules = true; return Response.json(out); }

  // 오늘 수업이 있는 반 / 오늘 클리닉이 있는 반
  const 오늘수업 = [], 오늘클리닉 = [];
  for (const key of 전체키) {
    const sch = schedules[key];
    if (!sch) continue;
    if (Array.isArray(sch.days) && sch.days.includes(now.dow)) 오늘수업.push(key);
    const c = sch.clinic;
    if (c && Array.isArray(c.days) && c.days.includes(now.dow)) 오늘클리닉.push(key);
  }
  out.diag.classesToday = 오늘수업.length;
  out.diag.clinicToday = 오늘클리닉.length;

  // ── 클리닉 총평 (수업 반 유무와 무관하게 먼저 처리) ─────────────────
  //   원장: 조교가 아직 안 쓴 학생 수 = "조교 총평 확인" (내가 발송 안 한 건수는 홈의 기존 줄이 담당)
  //   조교: 내가 아직 안 쓴 학생 수 = "클리닉 총평 쓸 시간"
  if (오늘클리닉.length) {
    const 시작들 = 오늘클리닉.map((k) => parseHHMM(schedules[k].clinic.start)).filter((v) => v !== null);
    const 종료들 = 오늘클리닉.map((k) => parseHHMM(schedules[k].clinic.end)).filter((v) => v !== null);
    const 가장이른시작 = 시작들.length ? Math.min(...시작들) : null;
    const 가장이른종료 = 종료들.length ? Math.min(...종료들) : null;
    const 기준 = isOwner
      ? 가장이른종료                                   // 원장은 클리닉이 끝난 뒤부터 확인
      : (가장이른시작 === null ? null : 가장이른시작 + 조교총평_시작후분);
    if (기준 !== null && now.minutes >= 기준) {
      try {
        const [clinicRows, reviews] = await Promise.all([
          listClinicByDate(env, now.dateStr),
          listClinicReviewsByDate(env, now.dateStr),
        ]);
        // 결석·병결·공결은 총평 대상이 아니다 — 안 사라지는 숫자를 만들면 배지가 무의미해진다.
        const 제외 = { '결석': 1, '병결': 1, '공결': 1 };
        const 작성됨 = {};
        for (const r of (reviews || [])) if (r && r.studentId != null) 작성됨[String(r.studentId)] = 1;
        let 대상 = (clinicRows || []).filter((r) => r && r.student_id != null && !제외[r.status]);
        if (!isOwner) {
          // 조교는 자기 학원 학생만 — 학생 명단으로 학원을 확인한다.
          const students = await listStudents(env).catch(() => []);
          const 내학원 = new Set(students.filter((s) => (s.academy || '') === scopeAcademy).map((s) => String(s.id)));
          대상 = 대상.filter((r) => 내학원.has(String(r.student_id)));
        }
        if (!대상.length) {
          // 클리닉 시간이 됐는데 **기록이 한 건도 없다** — 총평 이전에 출결부터 안 찍힌 상태다.
          //   이 경우를 안 다루면 홈이 또 조용히 빈다(조교 홈이 늘 비었던 진짜 이유가 이것일 수 있다).
          out.items.push({ key: 'clinicNoRecord', n: 오늘클리닉.length });
        } else {
          const 안쓴 = 대상.filter((r) => !작성됨[String(r.student_id)]).length;
          if (안쓴 > 0) {
            out.items.push({ key: isOwner ? 'clinicReviewOwner' : 'clinicReviewStaff', n: 안쓴 });
          }
        }
      } catch (_) { /* 실패하면 이 줄만 빠진다 */ }
    }
  }

  // 조교에게는 여기까지 (출결·영상·리포트는 원장 몫 — 2026-08-03 관우T 확인)
  if (!isOwner || !오늘수업.length) return Response.json(out);

  let students = [];
  try { students = await listStudents(env); } catch (_) {
    out.diag.studentsFailed = true;
    return Response.json(out);
  }

  // 영상 목록은 "종료 +30분이 지난 반"이 하나라도 있을 때만 부른다(수업 중엔 부를 이유가 없다).
  const 영상볼필요 = 오늘수업.some((k) => {
    const e = parseHHMM(schedules[k].end);
    return e !== null && now.minutes >= e + 영상_종료후분;
  });
  const 영상맵 = 영상볼필요 ? await todayVideoMap(env, now.dateStr) : {};

  const 출결없는반 = [], 영상없는반 = [], 리포트없는반 = [];
  for (const key of 오늘수업) {
    const sch = schedules[key];
    const start = parseHHMM(sch.start), end = parseHHMM(sch.end);
    const slash = key.indexOf('/');
    const academy = slash >= 0 ? key.slice(0, slash) : key;
    const className = slash >= 0 ? key.slice(slash + 1) : '';
    const roster = students.filter((s) => (s.academy || '') === academy && (s.className || '') === className);
    if (!roster.length) continue;                       // 학생이 없는 반은 아무것도 묻지 않는다

    // ① 출결 — 시작 +10분이 지났는데 **아직 안 찍은 학생이 남아 있다**
    //    ⚠️ 예전엔 cnt === 0(한 명도 안 찍음)일 때만 줄을 그렸다. 그래서 20명 중 1명만 찍어도
    //       줄이 통째로 사라졌고, 앱을 다시 열면 19명이 남았는데도 홈이 조용했다(관우T 2026-08-03
    //       "하루가 지금은 찾아 찾아 들어가니까 불편해"). 이제 남은 인원으로 판단하고 그 수를 내려보낸다.
    if (start !== null && now.minutes >= start + 출결_시작후분) {
      const ids = roster.map((s) => s.id).filter((v) => v !== undefined && v !== null);
      try {
        const cnt = await countChunked(env, 'SELECT COUNT(*) AS c FROM attendance WHERE date=? AND student_id IN (', ids, now.dateStr);
        const 남은 = Math.max(0, ids.length - cnt);   // 혹시 한 학생에 행이 둘이어도 음수로 안 내려간다
        if (남은 > 0) 출결없는반.push({ academy, className, left: 남은, total: ids.length });
      } catch (_) { /* 조회 실패 반은 조용히 건너뛴다 */ }
    }

    if (end === null) continue;

    // ② 영상 — 종료 +30분이 지났는데 오늘 날짜 영상이 없다
    const 영상있음 = 영상맵 ? !!영상맵[반키(academy, className)] : null;   // null = 판단 불가(목록 실패)
    if (now.minutes >= end + 영상_종료후분 && 영상있음 === false) 영상없는반.push(className);

    // ③ 리포트 — 종료 +2시간이 지났고, **영상은 올라와 있는데** 리포트가 없다.
    //    영상조차 없으면 ②가 이미 말하고 있다. 같은 원인으로 두 줄을 띄우면 잔소리가 된다.
    if (now.minutes >= end + 리포트_종료후분 && 영상있음 !== false) {
      const names = [...new Set(roster.map((s) => s.name).filter(Boolean))];
      if (names.length) {
        try {
          //    ⚠️ reports 테이블은 이름 키다(MathOS가 이름+날짜로 올림). 동명이인이 다른 반에서
          //       리포트를 받으면 "있다"로 셀 수 있다 — 잘못 재촉하는 것보다 한 번 덜 재촉하는 쪽.
          const rep = await countChunked(env, 'SELECT COUNT(*) AS c FROM reports WHERE class_date=? AND student_name IN (', names, now.dateStr);
          if (rep === 0) 리포트없는반.push(className);
        } catch (_) { /* 조회 실패 반은 조용히 건너뛴다 */ }
      }
    }
  }

  // 출결은 **반마다 한 줄**로 낸다. 눌렀을 때 그 반으로 바로 필터를 걸어 주려면 줄과 반이 1:1이어야 한다
  //   (여러 반을 한 줄에 묶으면 어디로 데려갈지 정할 수 없다). n = 그 반에서 아직 안 찍은 학생 수.
  //   academy를 같이 보내는 이유: 학원이 달라도 반 이름이 같을 수 있어 반 이름만으론 특정이 안 된다.
  for (const t of 출결없는반) {
    out.items.push({ key: 'attendance', n: t.left, classes: [t.className], academy: t.academy, className: t.className, total: t.total });
  }
  if (영상없는반.length) out.items.push({ key: 'video', n: 영상없는반.length, classes: 영상없는반 });
  if (리포트없는반.length) out.items.push({ key: 'report', n: 리포트없는반.length, classes: 리포트없는반 });

  // 오늘 수업이 있는데 아직 시작 전이면 "몇 시부터"를 알려 준다(빈 박스의 이유가 되도록).
  if (!out.items.length) {
    const 다음 = 오늘수업
      .map((k) => ({ key: k, start: parseHHMM(schedules[k].start) }))
      .filter((x) => x.start !== null && now.minutes < x.start)
      .sort((a, b) => a.start - b.start)[0];
    if (다음) {
      out.diag.nextClass = {
        className: 다음.key.slice(다음.key.indexOf('/') + 1),
        start: schedules[다음.key].start,
        dowName: 요일이름[now.dow],
      };
    }
  }

  return Response.json(out);
}
