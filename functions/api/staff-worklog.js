// /api/staff-worklog — 조교 근무기록(월급 계산용). R2 저장, D1 스키마 변경 없음.
//   키:  staff-worklog/{phoneDigits}/{YYYY-MM}.json
//   값:  { entries: { '2026-06-24': { hours?, start?, end?, memo?, updatedAt }, ... } }
//
// 신원·권한 (★중요):
//   - 미들웨어가 ast_(조교) 토큰을 검증하면 Authorization을 ADMIN_PASSWORD로 번역하고
//     X-Staff-Phone(검증된 조교 전화번호, 위조불가)을 실어 보낸다.
//   - adm_(원장) 토큰은 X-Staff-Phone이 없다 → 원장으로 식별.
//   ⇒ 쓰기(POST/DELETE)는 "조교 본인"만(X-Staff-Phone 필수). 원장은 조회만.
//
// 💰 급여 구간 (2026-08-05 변경 — 관우T 확정):
//   월급날은 매월 5일이고, **그 5일까지 일한 것**을 그날 지급한다.
//   ⇒ 정산 구간 = 「전월 6일 ~ 지급월 5일」 (양끝 포함).  예) 2026-08-05 지급 = 2026-07-06 ~ 2026-08-05 근무분
//   ❗ 예전에는 달력 월(1일~말일)이었다. "8월 5일에 7월분(7/1~7/31) 지급" → 지금은 아니다.
//   저장 구조(R2 키)는 **안 바뀌었다.** 파일은 여전히 달력 월 단위이고, 구간이 두 달에 걸치므로
//   readPeriod() 가 그 두 달 파일을 읽어 날짜 범위로 걸러 합친다. 마이그레이션 불필요.
//
// 🔒 정산확정(잠금) (2026-08-05 변경 — 관우T 확정):
//   예전: 달 단위 플래그(월파일의 locked). 구간이 달을 걸치면 8/5까지 확정하려다 8월 전체가 잠겼다.
//   지금: **확정 마감일 방식** — 조교 레코드(staff/{번호}.json)의 lockedUpto = 'YYYY-MM-DD'.
//        그 날짜 **이하**의 모든 근무기록을 조교가 추가·수정·삭제할 수 없다(423). 그 다음날부터는 자유.
//   ⚠️ 옛 월단위 플래그(md.locked)도 계속 존중한다 — 이미 잠가 둔 달이 새 코드에서 슬그머니
//      풀리는 일이 없게 하기 위한 하위호환이다. 잠금 해제 시에는 그 두 달의 옛 플래그도 같이 지운다.
//
// 엔드포인트:
//   GET  ?period=YYYY-MM                 → 본인(조교) 그 급여구간 기록 + 합계   (YYYY-MM = 지급월)
//   GET  ?phone=010...&period=YYYY-MM    → (원장) 특정 조교 그 구간 기록 + 합계
//   GET  ?all=1&period=YYYY-MM           → (원장) 전체 조교 그 구간 합계 요약
//   GET  ?month=YYYY-MM (구버전 호환)    → 달력 월 그대로. period 가 오면 period 가 이긴다.
//   POST { lock:bool, phone, period }    → (원장) 그 구간 정산확정/해제 = lockedUpto 이동
//   POST { date, hours? | start?,end?, memo? }  → (조교 본인) 그 날 upsert
//   DELETE ?date=YYYY-MM-DD              → (조교 본인) 그 날 삭제
//
// 시간 계산: start·end(HH:MM)가 있으면 (end-start) 시간으로, 없으면 hours 직접값.
import { listStaff, getStaffRecord, putStaffRecord } from './_staff.js';
import { normalizePhone } from './_auth.js';
import { safeError } from './_errors.js';
import { logAudit, diffFields, actorOf, describeDevice } from './_auditlog.js';

const WKEY = (digits, month) => 'staff-worklog/' + digits + '/' + month + '.json';

// 🟠 로그용 계좌 표기 — 계좌번호 전문은 절대 남기지 않는다. 뒤 4자리 + 자릿수만.
//   (선례: payroll-reminder.js 가 같은 방식으로 남긴다. 전문이 필요하면 R2 staff/{번호}.json 을 볼 것.)
const 계좌표시 = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  return d ? ('****' + d.slice(-4) + ' · 숫자 ' + d.length + '자리') : '(미등록)';
};
const onlyDigits = (p) => String(p || '').replace(/\D/g, '');
const isMonth = (m) => /^\d{4}-\d{2}$/.test(String(m || ''));
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const isHHMM = (t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(t || ''));

function thisMonth() {
  // 한국시간(UTC+9) 기준 '이번 달'. UTC로 계산하면 한국 새벽 0~9시에 지난 달로 잡힘.
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

// ───────── 급여 구간 (전월 6일 ~ 지급월 5일) ─────────
// 🔎 날짜를 전부 'YYYY-MM-DD' 문자열로 다룬다. 이 형식은 사전순 비교 = 날짜순 비교라
//    d >= start && d <= end 한 줄로 구간 판정이 끝난다(Date 객체·시간대 함정 없음).
export const PAYDAY = 5;                       // 월급날 = 매월 5일 (여기만 바꾸면 구간이 통째로 따라온다)
const pad2 = (n) => String(n).padStart(2, '0');

// payMonth('2026-08') → { start:'2026-07-06', end:'2026-08-05', months:['2026-07','2026-08'], payday:'2026-08-05' }
//   payMonth = **지급월**(그 달 5일에 돈이 나간다). 1월이면 전월이 작년 12월이 되는 것까지 여기서 처리.
export function periodOf(payMonth) {
  const y = Number(String(payMonth).slice(0, 4));
  const m = Number(String(payMonth).slice(5, 7));          // 1~12
  const py = m === 1 ? y - 1 : y;                          // 구간이 시작하는 달(= 전월)의 연
  const pm = m === 1 ? 12 : m - 1;                         // 구간이 시작하는 달
  return {
    payMonth: y + '-' + pad2(m),
    payday: y + '-' + pad2(m) + '-' + pad2(PAYDAY),
    start: py + '-' + pad2(pm) + '-' + pad2(PAYDAY + 1),   // 전월 6일
    end: y + '-' + pad2(m) + '-' + pad2(PAYDAY),           // 지급월 5일
    months: [py + '-' + pad2(pm), y + '-' + pad2(m)],      // 읽어야 할 R2 월파일 2개
  };
}

// 오늘(KST) 기준 "지금 정산할 구간"의 지급월.
//   5일 이하 → 이번 달 5일이 아직 안 지났거나 오늘이다 → 이번 달이 지급월.
//   6일 이상 → 이번 구간은 다음 달 5일에 나간다 → 다음 달이 지급월.
export function currentPayMonth() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + 1;
  if (d.getUTCDate() > PAYDAY) { m += 1; if (m > 12) { m = 1; y += 1; } }
  return y + '-' + pad2(m);
}

// 구간에 걸친 두 달 파일을 읽어 날짜 범위로 걸러 합친다.
//   ⚠️ 월파일 구조는 그대로다 — 여기서만 합쳐 보여 준다(데이터 이사 없음).
//   legacyLocked = 그 두 달 중 하나라도 옛 월단위 잠금이 걸려 있으면 true (하위호환 표시용).
async function readPeriod(env, digits, per) {
  const entries = {};
  let legacyLocked = false;
  for (const mm of per.months) {
    const md = await readMonth(env, digits, mm);
    if (md && md.locked) legacyLocked = true;
    const src = (md && md.entries) || {};
    for (const d of Object.keys(src)) {
      if (d >= per.start && d <= per.end) entries[d] = src[d];
    }
  }
  return { entries, legacyLocked };
}

// 조교 레코드의 확정 마감일. 없으면 ''.
const lockedUptoOf = (rec) => (rec && isDate(rec.lockedUpto) ? String(rec.lockedUpto) : '');
// 하루 전 날짜(확정 해제 시 마감일을 구간 시작 직전으로 되돌릴 때 씀).
function prevDay(ymd) {
  const t = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) - 86400000;
  const d = new Date(t);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

// 한 항목의 실제 근무시간(시간 단위, 소수 2자리). start/end 우선, 없으면 hours.
function entryHours(e) {
  if (!e) return 0;
  if (e.start && e.end && isHHMM(e.start) && isHHMM(e.end)) {
    const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
    const diff = toMin(e.end) - toMin(e.start);
    return diff > 0 ? Math.round((diff / 60) * 100) / 100 : 0;
  }
  const h = Number(e.hours);
  return Number.isFinite(h) && h > 0 ? Math.round(h * 100) / 100 : 0;
}

async function readMonth(env, digits, month) {
  try {
    const obj = await env.BUCKET.get(WKEY(digits, month));
    if (!obj) return { entries: {} };
    const data = JSON.parse(await obj.text());
    return (data && typeof data === 'object' && data.entries) ? data : { entries: {} };
  } catch (_) { return { entries: {} }; }
}

async function writeMonth(env, digits, month, data) {
  await env.BUCKET.put(WKEY(digits, month), JSON.stringify(data), {
    httpMetadata: { contentType: 'application/json' },
  });
}

// 외부(payroll-reminder 등)에서 재사용: 한 조교의 한 달 합계만 깔끔히.
//   → { totalHours, totalPay, dayCount, rows }
//   ⚠️ 달력 월 기준이다. 급여 정산에는 쓰지 말 것 — 급여는 아래 staffPeriodSummary(구간)로 계산한다.
//      (2026-08-05 이후 실제 지급액과 다르다. 남겨 둔 이유는 옛 호출부 안전용.)
export async function staffMonthSummary(env, phoneDigits, month, hourlyWage) {
  const md = await readMonth(env, onlyDigits(phoneDigits), month);
  return summarize(md, hourlyWage);
}

// 💰 급여 정산의 표준 계산기 — 한 조교의 한 급여구간(전월 6일~지급월 5일) 합계.
//   payMonth = 지급월('YYYY-MM'). → { totalHours, totalPay, dayCount, rows, period }
export async function staffPeriodSummary(env, phoneDigits, payMonth, hourlyWage) {
  const per = periodOf(payMonth);
  const pd = await readPeriod(env, onlyDigits(phoneDigits), per);
  const sum = summarize(pd, hourlyWage);
  sum.period = per;
  return sum;
}

// 한 달치 합계 계산 → { totalHours, totalPay, dayCount, entries(정렬·시간포함) }
function summarize(monthData, hourlyWage) {
  const entries = (monthData && monthData.entries) || {};
  const dates = Object.keys(entries).sort();
  let totalHours = 0;
  const rows = dates.map((date) => {
    const e = entries[date] || {};
    const h = entryHours(e);
    totalHours += h;
    return { date, hours: h, start: e.start || '', end: e.end || '', memo: e.memo || '' };
  });
  totalHours = Math.round(totalHours * 100) / 100;
  const wage = Number(hourlyWage) || 0;
  return { totalHours, totalPay: Math.round(totalHours * wage), dayCount: rows.length, rows };
}

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdminTok = !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  if (!isAdminTok) {
    // 📓 근무기록은 월급의 원천 데이터다 — 실패한 접근도 남긴다.
    //   조교 세션이 만료됐는지, 남의 근무기록을 건드리려 한 시도인지를 뒤에 가릴 수 있어야 한다.
    await logAudit(env, request, {
      action: 'staff.worklog.denied',
      actorRole: 'anon',
      summary: '근무기록 API 인증 실패 — ' + request.method + ' (토큰 없음 또는 불일치)',
      detail: {
        결과: '거부(401). 조회도 저장도 하지 않았다.',
        사유: env.ADMIN_PASSWORD ? '토큰이 관리자 비밀번호와 불일치(만료된 세션 포함)' : '서버에 ADMIN_PASSWORD 미설정',
        토큰있음: !!token,
        메서드: request.method,
        기기: describeDevice(request.headers.get('User-Agent')) || '(알 수 없음)',
        효과: '없음.',
        비고: '입력된 토큰 원문은 기록하지 않는다. 조교 앱이 로그인 만료된 상태로 호출해도 여기 남는다.',
      },
    });
    return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });
  }

  const url = new URL(request.url);
  const selfDigits = onlyDigits(request.headers.get('X-Staff-Phone') || '');   // 조교면 값 있음, 원장이면 ''
  const isStaff = !!selfDigits;

  // 📓 2026-07-31 — "어떤 조교가 뭘 만졌는지"를 남기기 위한 신원·기기.
  //   미들웨어가 검증해 심은 X-Staff-Phone / X-Staff-Name 을 actorOf 가 읽는다(위조 불가).
  //   ⚠️ try 밖에서 만든다 — catch 블록에서도 써야 하기 때문.
  const 기기 = describeDevice(request.headers.get('User-Agent')) || '(알 수 없음)';
  const 나 = actorOf(request, env);
  const 내이름 = 나.actorName || (isStaff ? selfDigits : '원장');

  try {
    // ───────── GET ─────────
    if (request.method === 'GET') {
      // 💰 period(지급월)가 오면 급여구간 모드, 없으면 옛 달력월 모드(호환).
      //   화면 3장(admin-staff·staff-worklog·리마인드)은 전부 period 를 보낸다.
      const qPeriod = url.searchParams.get('period');
      const usePeriod = isMonth(qPeriod);
      const month = isMonth(url.searchParams.get('month')) ? url.searchParams.get('month') : thisMonth();
      const per = usePeriod ? periodOf(qPeriod) : null;

      // 원장 전체 요약
      if (!isStaff && url.searchParams.get('all') === '1') {
        const staff = await listStaff(env);
        const out = [];
        for (const s of staff) {
          const d = onlyDigits(s.phone);
          const sum = usePeriod
            ? summarize(await readPeriod(env, d, per), s.hourlyWage)
            : summarize(await readMonth(env, d, month), s.hourlyWage);
          out.push({
            phone: s.phone, name: s.name || '', academy: s.academy || '',
            hourlyWage: s.hourlyWage || 0, approved: !!s.approved,
            totalHours: sum.totalHours, totalPay: sum.totalPay, dayCount: sum.dayCount,
            // 🔒 목록에서도 확정 여부가 보여야 한다 — 확정 마감일이 구간 끝을 덮으면 확정된 구간.
            locked: usePeriod ? (!!lockedUptoOf(s) && lockedUptoOf(s) >= per.end) : false,
          });
        }
        return Response.json(usePeriod
          ? { ok: true, period: per, month: per.payMonth, staff: out }
          : { ok: true, month, staff: out });
      }

      // 대상 조교: 본인(조교) 또는 ?phone=(원장)
      const targetDigits = isStaff ? selfDigits : onlyDigits(url.searchParams.get('phone') || '');
      if (!targetDigits) return Response.json({ error: '조회할 조교(phone)가 필요합니다.' }, { status: 400 });

      const rec = await getStaffRecord(env, normalizePhone(targetDigits) || targetDigits);
      const wage = rec ? (rec.hourlyWage || 0) : 0;
      const upto = lockedUptoOf(rec);

      if (usePeriod) {
        const pd = await readPeriod(env, targetDigits, per);
        const sum = summarize(pd, wage);
        return Response.json({
          ok: true, phone: targetDigits, period: per, month: per.payMonth,
          name: rec ? (rec.name || '') : '', academy: rec ? (rec.academy || '') : '',
          hourlyWage: wage, account: rec ? (rec.account || '') : '',
          totalHours: sum.totalHours, totalPay: sum.totalPay, dayCount: sum.dayCount,
          entries: sum.rows,
          // locked = 이 구간이 확정됐나. 옛 월단위 잠금이 남아 있어도 잠긴 것으로 본다(실제로 못 고치니까).
          locked: (!!upto && upto >= per.end) || pd.legacyLocked,
          lockedUpto: upto || null, lockedAt: (rec && rec.lockedAt) || null,
          legacyLocked: pd.legacyLocked,
        });
      }

      const md = await readMonth(env, targetDigits, month);
      const sum = summarize(md, wage);
      return Response.json({
        ok: true, phone: targetDigits, month,
        name: rec ? (rec.name || '') : '', academy: rec ? (rec.academy || '') : '',
        hourlyWage: wage, account: rec ? (rec.account || '') : '',
        totalHours: sum.totalHours, totalPay: sum.totalPay, dayCount: sum.dayCount,
        entries: sum.rows,
        locked: !!md.locked, lockedAt: md.lockedAt || null,
        lockedUpto: upto || null,
      });
    }

    // ───────── POST ─────────
    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (_) {}

      // 원장: 특정 조교의 그 **급여구간**을 정산확정/해제. 확정하면 그 조교는 마감일 이전 기록을 못 고침.
      //   원장(adm_)은 X-Staff-Phone이 없어 isStaff=false. body.lock 있으면 근무입력이 아니라 확정 처리.
      //   📌 2026-08-05 — 달 단위 플래그를 버리고 조교 레코드의 lockedUpto(확정 마감일) 하나로 통일했다.
      //      구간이 두 달에 걸치므로(7/6~8/5) 달 단위로는 8월 전체가 같이 잠겨 버렸다.
      if (!isStaff && body.lock !== undefined) {
        const ld = onlyDigits(body.phone || '');
        const lp = String(body.period || body.month || '');   // month 는 옛 화면 호환
        if (!ld || !isMonth(lp)) {
          await logAudit(env, request, {
            action: 'staff.worklog.lock.reject',
            summary: '정산확정 요청 거부 — 조교 번호 또는 지급월(period)이 빠졌다',
            detail: {
              결과: '거부(400). 어떤 구간의 확정 상태도 바뀌지 않았다.',
              보낸값: {
                phone: String(body.phone || '').slice(0, 30) || '(빈칸)',
                period: lp || '(빈칸)',
                lock: !!body.lock,
              },
              기기: 기기,
              효과: '없음.',
            },
          });
          return Response.json({ error: '조교(phone)와 지급월(period)이 필요합니다.' }, { status: 400 });
        }

        const per = periodOf(lp);
        const skey = normalizePhone(ld) || ld;
        const rec = await getStaffRecord(env, skey);
        if (!rec) {
          await logAudit(env, request, {
            action: 'staff.worklog.lock.reject',
            target: ld, targetName: '',
            summary: '[' + ld + '] 정산확정 실패 — 조교 레코드를 못 찾음 (staff/' + skey + '.json)',
            detail: {
              결과: '실패(404). 확정 상태가 바뀌지 않았다.',
              사유: 'R2에 이 번호의 조교 레코드가 없다. 확정 마감일은 조교 레코드에 저장하므로 레코드가 없으면 저장할 곳이 없다.',
              대상구간: per.start + ' ~ ' + per.end,
              기기: 기기,
              효과: '없음.',
            },
          });
          return Response.json({ error: '조교 정보를 찾을 수 없어요.' }, { status: 404 });
        }

        // 🔎 rec 을 그 자리에서 뜯어고치므로(in-place) 손대기 **전에** 이전 상태를 떠 둔다.
        //   안 그러면 로그의 "전/후"가 똑같이 찍혀 아무 의미가 없다(선례: staff-approve.js).
        const 이전마감 = lockedUptoOf(rec);
        const 이전시각 = rec.lockedAt || null;

        // 그 구간의 실제 기록(확정 시점 스냅샷) — 나중에 "그때 얼마로 굳혔나"를 대조할 근거.
        const pd = await readPeriod(env, ld, per);
        const 구간합계 = summarize(pd, rec.hourlyWage || 0);

        let 새마감;
        if (body.lock) {
          // 확정: 마감일을 구간 끝(지급월 5일)로. 이미 더 뒤까지 확정돼 있으면 뒤로 물리지 않는다.
          새마감 = (이전마감 && 이전마감 > per.end) ? 이전마감 : per.end;
        } else {
          // 해제: 마감일을 이 구간 시작 직전(= 전월 5일)으로 되돌린다.
          //   ⚠️ 마감일은 하나뿐이라 "이 구간만 콕 집어 해제"는 불가능하다 —
          //      이 구간과 그 이후 구간이 **함께** 풀린다. 아래 로그와 화면 확인문구에 그대로 적는다.
          새마감 = prevDay(per.start);
        }
        rec.lockedUpto = 새마감;
        rec.lockedAt = new Date().toISOString();
        await putStaffRecord(env, skey, rec);

        // 🧹 하위호환 정리 — 해제인데 옛 월단위 잠금이 남아 있으면 조교는 여전히 못 고친다.
        //   "풀었는데 안 풀린다"가 되지 않게 이 구간이 걸친 두 달의 옛 플래그를 같이 지운다.
        const 옛플래그정리 = [];
        if (!body.lock) {
          for (const mm of per.months) {
            const lmd = await readMonth(env, ld, mm);
            if (lmd && lmd.locked) {
              lmd.locked = false; lmd.lockedAt = null;
              await writeMonth(env, ld, mm, lmd);
              옛플래그정리.push(mm);
            }
          }
        }

        const 확정됨 = !!body.lock;
        const 변화없음 = 이전마감 === 새마감;
        // 📓 확정 = "이 구간 지급액을 굳힌다". 굳은 뒤엔 그 조교가 마감일 이전 기록을 못 고친다(423).
        //   해제는 반대로 확정했던 금액이 다시 움직일 수 있다는 뜻이라 더 중요하게 남긴다.
        await logAudit(env, request, {
          action: 확정됨 ? 'staff.worklog.lock' : 'staff.worklog.unlock',
          target: ld, targetName: rec.name || '',
          summary: '[' + (rec.name || ld) + '] ' + per.start + '~' + per.end + ' 정산 '
            + (확정됨 ? '확정' : '확정 해제')
            + (변화없음 ? ' — 상태 변화 없음(마감일 그대로 ' + (새마감 || '없음') + ')' : '')
            + ' · 구간 기록 ' + 구간합계.dayCount + '일 ' + 구간합계.totalHours + '시간'
            + (rec.hourlyWage ? (' · ' + 구간합계.totalPay + '원') : ' · 시급 미설정'),
          detail: {
            대상조교: { 전화번호: ld, 이름: rec.name || '(이름없음)', 시급: rec.hourlyWage || 0 },
            지급월: per.payMonth,
            정산구간: per.start + ' ~ ' + per.end + ' (지급일 ' + per.payday + ')',
            확정마감일: { 전: 이전마감 || '(없음)', 후: 새마감 || '(없음)' },
            확정시각: { 전: 이전시각 || '(없음)', 후: rec.lockedAt },
            변화없음: 변화없음,
            그시점기록: { 일수: 구간합계.dayCount, 총시간: 구간합계.totalHours, 정산액: 구간합계.totalPay },
            옛월단위잠금해제: 옛플래그정리.length ? 옛플래그정리 : '(해당 없음)',
            기기: 기기,
            효과: 확정됨
              ? '이제 그 조교는 ' + 새마감 + ' 이전(당일 포함) 근무기록을 추가·수정·삭제할 수 없다(423). '
                + '그 다음날부터는 평소대로 입력된다 — 다음 구간 근무가 막히지 않는다.'
              : '확정 마감일이 ' + 새마감 + ' 로 물러났다. 그 조교는 ' + per.start + ' 이후 기록을 다시 고칠 수 있다 — '
                + '이미 확정했던 정산액이 바뀔 수 있다. 마감일은 하나뿐이라 이 구간 **이후** 구간도 함께 풀린다.',
            비고: '확정 마감일은 조교 레코드(staff/{번호}.json)의 lockedUpto 한 칸이다. '
              + '구간이 두 달에 걸치므로(전월 6일~지급월 5일) 달 단위 플래그로는 다음 달이 통째로 잠기던 문제를 이 방식으로 없앴다.',
          },
        });
        return Response.json({
          ok: true, phone: ld, period: per, month: per.payMonth,
          locked: 확정됨, lockedUpto: 새마감,
        });
      }

      // 이하(근무기록 입력·계좌변경)는 조교 본인만.
      if (!isStaff) {
        await logAudit(env, request, {
          action: 'staff.worklog.denied',
          summary: '근무기록 입력 거부 — 조교 본인만 입력 가능(조교 세션이 아닌 호출)',
          detail: {
            결과: '거부(403). 아무것도 저장되지 않았다.',
            사유: 'X-Staff-Phone(미들웨어가 검증해 심는 조교 신원)이 없다 = 조교 세션이 아니다.',
            보낸값: {
              날짜: String(body.date || '').slice(0, 20) || '(빈칸)',
              계좌필드보냄: body.account !== undefined,
              잠금필드보냄: body.lock !== undefined,
            },
            기기: 기기,
            효과: '없음. 원장은 조회·잠금만 할 수 있고 근무기록 입력은 조교 본인만 한다.',
            비고: '원장이 잠금(lock)을 보내려다 phone/month를 빠뜨린 게 아니라 lock 자체를 안 보낸 경우에도 여기로 온다.',
          },
        });
        return Response.json({ error: '근무기록은 조교 본인만 입력할 수 있어요.' }, { status: 403 });
      }

      // 급여 계좌 변경 — date 없이 account만 보내면 본인 계좌 업데이트(근무기록 아님)
      if (body.account !== undefined && !body.date) {
        const skey = normalizePhone(selfDigits) || selfDigits;
        const rec = await getStaffRecord(env, skey);
        if (!rec) {
          await logAudit(env, request, {
            action: 'staff.account.update.fail',
            target: selfDigits, targetName: 내이름,
            summary: '[' + 내이름 + '] 급여 계좌 변경 실패 — 조교 레코드를 못 찾음 (staff/' + skey + '.json)',
            detail: {
              결과: '실패(404). 계좌가 바뀌지 않았다.',
              사유: 'R2에 이 번호의 조교 레코드가 없다(원장이 지웠거나 저장 키가 다르다).',
              찾은키: 'staff/' + skey + '.json',
              기기: 기기,
              효과: '없음. 이 조교는 월급 계좌를 스스로 바꿀 수 없는 상태다 — 원장 확인이 필요하다.',
              비고: '레코드가 없으면 로그인도 곧 막힌다(미들웨어가 매 요청 레코드로 승인상태를 확인한다).',
            },
          });
          return Response.json({ error: '조교 정보를 찾을 수 없어요.' }, { status: 404 });
        }
        // 🔎 rec 을 그 자리에서 뜯어고치므로(in-place) 손대기 **전에** 통째로 복사해 둔다.
        //   이걸 안 하면 아래 로그의 "전" 계좌가 이미 바뀐 값과 같아져 아무 의미가 없다.
        //   (선례: staff-approve.js·class-options.js 에서 실제로 이 함정에 빠졌다.)
        const before = JSON.parse(JSON.stringify(rec));
        rec.account = String(body.account || '').replace(/[<>"'`]/g, '').trim().slice(0, 60);
        await putStaffRecord(env, skey, rec);

        // 🟠 돈이 실제로 들어가는 계좌가 바뀌는 자리다. "언제 누가 바꿨나"는 전부 남기되
        //   계좌번호 전문은 남기지 않는다(뒤 4자리·자릿수·바뀜여부만).
        const 계좌바뀜 = String(before.account || '') !== String(rec.account || '');
        await logAudit(env, request, {
          action: 계좌바뀜 ? 'staff.account.update' : 'staff.account.update.noop',
          target: selfDigits, targetName: 내이름,
          summary: '[' + 내이름 + '] 급여 계좌 '
            + (계좌바뀜 ? ('변경 ' + 계좌표시(before.account) + ' → ' + 계좌표시(rec.account)) : '저장 — 내용 동일(변화 없음)')
            + ' · ' + 기기,
          detail: {
            조교: {
              전화번호: selfDigits, 이름: 내이름,
              담당학원: rec.academy || '(미배정)', 시급: rec.hourlyWage || 0, 승인여부: !!rec.approved,
            },
            계좌: { 전: 계좌표시(before.account), 후: 계좌표시(rec.account) },
            바뀜: 계좌바뀜,
            계좌를비웠나: !!(before.account && !rec.account),
            은행명등문자포함: /[^\d\s-]/.test(String(rec.account || '')),   // 숫자만이면 은행명이 빠졌다는 신호
            기기: 기기,
            효과: 계좌바뀜
              ? '다음 월급날(매월 5일) 리마인드부터 이 계좌로 안내된다. 조교 본인이 스스로 바꾼 것이다.'
              : '아무것도 달라지지 않았다(같은 값 재저장).',
            비고: '계좌번호 전문은 로그에 남기지 않는다 — 뒤 4자리와 자릿수만 남긴다. '
              + '전문이 필요하면 R2 staff/{번호}.json 을 직접 볼 것.',
          },
        });
        return Response.json({ ok: true, updated: 'account', account: rec.account });
      }

      // 입력값이 막힌 경우도 남긴다 — "입력했는데 저장이 안 됐다"는 말과 실제를 가르는 근거.
      const 입력거부 = async (사유) => {
        await logAudit(env, request, {
          action: 'staff.worklog.reject',
          target: selfDigits, targetName: 내이름,
          summary: '[' + 내이름 + '] 근무기록 입력 거부 — ' + 사유,
          detail: {
            결과: '거부(400). 근무기록이 저장되지 않았다.',
            사유: 사유,
            보낸값: {
              날짜: String(body.date || '').slice(0, 20) || '(빈칸)',
              출근: String(body.start === undefined ? '' : body.start).slice(0, 10) || '(빈칸)',
              퇴근: String(body.end === undefined ? '' : body.end).slice(0, 10) || '(빈칸)',
              직접입력시간: String(body.hours === undefined ? '' : body.hours).slice(0, 10) || '(빈칸)',
              메모: String(body.memo || '').slice(0, 200) || '(빈칸)',
            },
            기기: 기기,
            효과: '없음 — 그 날 기록은 그대로다(있었으면 있는 채로, 없었으면 없는 채로). 급여 계산도 그대로다.',
          },
        });
      };

      const date = String(body.date || '').trim();
      if (!isDate(date)) {
        await 입력거부('날짜(date) 형식 오류 — YYYY-MM-DD 가 아님');
        return Response.json({ error: 'date(YYYY-MM-DD)가 필요합니다.' }, { status: 400 });
      }

      const entry = { updatedAt: new Date().toISOString() };
      const hasStart = body.start !== undefined && body.start !== '';
      const hasEnd = body.end !== undefined && body.end !== '';
      if (hasStart || hasEnd) {
        if (!isHHMM(body.start) || !isHHMM(body.end)) {
          await 입력거부('출근/퇴근 시각이 HH:MM 형식이 아니거나 한쪽만 들어옴');
          return Response.json({ error: '출근/퇴근 시각을 HH:MM 형식으로 둘 다 입력해주세요.' }, { status: 400 });
        }
        const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
        if (toMin(body.end) <= toMin(body.start)) {
          await 입력거부('퇴근 시각이 출근 시각보다 이르거나 같음 (' + body.start + '~' + body.end + ')');
          return Response.json({ error: '퇴근 시각이 출근 시각보다 늦어야 해요.' }, { status: 400 });
        }
        entry.start = body.start; entry.end = body.end;
      } else {
        const h = Number(body.hours);
        if (!Number.isFinite(h) || h <= 0 || h > 24) {
          await 입력거부('근무시간이 0~24 범위 밖이거나 숫자가 아님 — 보낸값 "' + String(body.hours === undefined ? '' : body.hours).slice(0, 20) + '"');
          return Response.json({ error: '근무시간(시간)을 0~24 사이로 입력하거나, 출퇴근 시각을 넣어주세요.' }, { status: 400 });
        }
        entry.hours = Math.round(h * 100) / 100;
      }
      if (typeof body.memo === 'string') entry.memo = body.memo.slice(0, 500);

      const month = date.slice(0, 7);
      const md = await readMonth(env, selfDigits, month);
      // 🔒 확정 검사 두 겹: ① 확정 마감일(그 날짜 **이하**는 못 고침) ② 옛 월단위 잠금(하위호환).
      //   ②를 남겨 두는 이유 — 새 방식으로 넘어오기 전에 잠가 둔 달이 슬그머니 풀리면 안 되기 때문.
      const 내레코드 = await getStaffRecord(env, normalizePhone(selfDigits) || selfDigits);
      const 마감일 = lockedUptoOf(내레코드);
      const 마감에걸림 = !!마감일 && date <= 마감일;
      if (마감에걸림 || md.locked) {
        await logAudit(env, request, {
          action: 'staff.worklog.locked',
          target: selfDigits + ' / ' + date, targetName: 내이름,
          summary: '[' + 내이름 + '] ' + date + ' 근무기록 입력 거부 — 정산이 확정된 날짜'
            + (마감에걸림 ? (' (확정 마감일 ' + 마감일 + ' 이하)') : ' (' + month + ' 옛 월단위 잠금)'),
          detail: {
            결과: '거부(423). 근무기록이 저장되지 않았다.',
            사유: 마감에걸림
              ? ('원장이 ' + 마감일 + ' 까지 정산을 확정했다. 그 날짜 이하(당일 포함)는 조교가 고칠 수 없다.')
              : (month + ' 은 옛 방식으로 월 전체가 잠긴 달이다(2026-08-05 이전 확정분).'),
            확정마감일: 마감일 || '(없음)',
            옛월단위잠금: !!md.locked,
            잠근시각: (내레코드 && 내레코드.lockedAt) || md.lockedAt || '(기록 없음)',
            넣으려던값: {
              날짜: date, 출근: entry.start || '', 퇴근: entry.end || '',
              직접입력시간: entry.hours === undefined ? '' : entry.hours,
              계산된시간: entryHours(entry), 메모: entry.memo || '',
            },
            기기: 기기,
            효과: '없음. 확정된 구간의 지급액이 뒤늦게 바뀌는 것을 막는다. '
              + '정말 고쳐야 하면 원장이 그 구간 확정을 풀어야 한다(staff.worklog.unlock 으로 남는다).',
            비고: '조교가 "입력이 안 된다"고 하면 이 로그로 확정 때문인지 바로 확인된다. '
              + '마감일 다음날부터는 정상 입력된다 — 전체가 막힌 게 아니다.',
          },
        });
        return Response.json({
          error: 마감에걸림
            ? ('' + 마감일 + ' 까지는 정산이 확정되어 수정할 수 없어요. 원장님께 문의해주세요.')
            : '이 달은 정산이 확정되어 수정할 수 없어요. 원장님께 문의해주세요.',
        }, { status: 423 });
      }
      md.entries = md.entries || {};
      // 🔎 같은 날짜에 이미 기록이 있으면 이건 **덮어쓰기**다 — 사라지는 값을 먼저 통째로 떠 둔다.
      //   (md.entries[date] = entry 로 원본 참조가 끊기므로, 이 줄이 없으면 이전 값이 영영 사라진다.)
      const 이전항목 = md.entries[date] ? JSON.parse(JSON.stringify(md.entries[date])) : null;
      md.entries[date] = entry;
      await writeMonth(env, selfDigits, month, md);

      // 📓 시급 × 총시간 = 월급이다. 이 한 줄이 그 달 지급액을 직접 움직인다.
      const 새시간 = entryHours(entry);
      const 이전시간 = entryHours(이전항목);
      // diffFields 는 after 가 undefined 인 칸을 "안 건드림"으로 보므로, 빈칸을 ''로 맞춰 비교한다.
      //   (안 그러면 "3시간 직접입력 → 출퇴근시각으로 변경"이 '시간 안 바뀜'으로 잘못 찍힌다.)
      const 비교전 = 이전항목
        ? { start: 이전항목.start || '', end: 이전항목.end || '', hours: 이전항목.hours === undefined ? '' : 이전항목.hours, memo: 이전항목.memo || '' }
        : {};
      const 비교후 = { start: entry.start || '', end: entry.end || '', hours: entry.hours === undefined ? '' : entry.hours, memo: entry.memo || '' };
      const 변경사항 = diffFields(비교전, 비교후, ['start', 'end', 'hours', 'memo']);
      await logAudit(env, request, {
        action: 이전항목 ? 'staff.worklog.update' : 'staff.worklog.create',
        target: selfDigits + ' / ' + date, targetName: 내이름,
        summary: '[' + 내이름 + '] ' + date + ' 근무 ' + (이전항목 ? '수정' : '입력') + ' — '
          + (이전항목 ? (이전시간 + '시간 → ' + 새시간 + '시간') : (새시간 + '시간'))
          + (entry.start ? (' (' + entry.start + '~' + entry.end + ')') : '') + ' · ' + 기기,
        detail: {
          조교: { 전화번호: selfDigits, 이름: 내이름 },
          날짜: date, 달: month,
          전: 이전항목 ? {
            출근: 이전항목.start || '', 퇴근: 이전항목.end || '',
            직접입력시간: 이전항목.hours === undefined ? '' : 이전항목.hours,
            메모: 이전항목.memo || '', 계산된시간: 이전시간, 마지막수정: 이전항목.updatedAt || '',
          } : '(이 날 기록이 없었음 — 새로 입력)',
          후: {
            출근: entry.start || '', 퇴근: entry.end || '',
            직접입력시간: entry.hours === undefined ? '' : entry.hours,
            메모: entry.memo || '', 계산된시간: 새시간, 마지막수정: entry.updatedAt,
          },
          바뀐칸: 변경사항.바뀐칸,
          변경: 변경사항.변경,
          시간증감: Math.round((새시간 - 이전시간) * 100) / 100,
          기기: 기기,
          효과: '이 날짜가 속한 급여구간(전월 6일~지급월 5일) 계산에 바로 반영된다. 시급 × 총시간이 급여이므로 '
            + (이전항목 ? '이 수정폭만큼 지급액이 달라진다.' : '이 시간만큼 지급액이 늘어난다.')
            + ' 지급월은 ' + (Number(date.slice(8, 10)) <= PAYDAY ? month : (date.slice(0, 7) + '의 다음 달')) + ' 5일이다.',
          비고: '출근·퇴근이 둘 다 있으면 그 차이로 계산하고, 없으면 직접 입력한 시간을 쓴다. '
            + '같은 날짜에 다시 입력하면 덮어쓴다 — 위 "전"이 그때 사라진 값이다.',
        },
      });

      return Response.json({ ok: true, date, hours: entryHours(entry), entry });
    }

    // ───────── DELETE (조교 본인만) ─────────
    if (request.method === 'DELETE') {
      if (!isStaff) {
        await logAudit(env, request, {
          action: 'staff.worklog.denied',
          summary: '근무기록 삭제 거부 — 조교 본인만 삭제 가능(조교 세션이 아닌 호출)',
          detail: {
            결과: '거부(403). 아무것도 지워지지 않았다.',
            사유: 'X-Staff-Phone(미들웨어가 검증해 심는 조교 신원)이 없다 = 조교 세션이 아니다.',
            지우려던날짜: String(url.searchParams.get('date') || '').slice(0, 20) || '(빈칸)',
            기기: 기기,
            효과: '없음. 원장도 남의 근무기록을 직접 지울 수 없다(잠금만 가능).',
          },
        });
        return Response.json({ error: '근무기록은 조교 본인만 삭제할 수 있어요.' }, { status: 403 });
      }
      const date = String(url.searchParams.get('date') || '').trim();
      if (!isDate(date)) {
        await logAudit(env, request, {
          action: 'staff.worklog.delete.reject',
          target: selfDigits, targetName: 내이름,
          summary: '[' + 내이름 + '] 근무기록 삭제 거부 — 날짜 형식 오류 "' + String(url.searchParams.get('date') || '').slice(0, 20) + '"',
          detail: {
            결과: '거부(400). 아무것도 지워지지 않았다.',
            사유: 'date가 YYYY-MM-DD 형식이 아니다.',
            기기: 기기,
            효과: '없음.',
          },
        });
        return Response.json({ error: 'date(YYYY-MM-DD)가 필요합니다.' }, { status: 400 });
      }
      const month = date.slice(0, 7);
      const md = await readMonth(env, selfDigits, month);
      // 🔒 입력과 같은 두 겹 검사 — 확정 마감일 + 옛 월단위 잠금(하위호환).
      const 내레코드 = await getStaffRecord(env, normalizePhone(selfDigits) || selfDigits);
      const 마감일 = lockedUptoOf(내레코드);
      const 마감에걸림 = !!마감일 && date <= 마감일;
      if (마감에걸림 || md.locked) {
        await logAudit(env, request, {
          action: 'staff.worklog.locked',
          target: selfDigits + ' / ' + date, targetName: 내이름,
          summary: '[' + 내이름 + '] ' + date + ' 근무기록 삭제 거부 — 정산이 확정된 날짜'
            + (마감에걸림 ? (' (확정 마감일 ' + 마감일 + ' 이하)') : ' (' + month + ' 옛 월단위 잠금)'),
          detail: {
            결과: '거부(423). 아무것도 지워지지 않았다.',
            사유: 마감에걸림
              ? ('원장이 ' + 마감일 + ' 까지 정산을 확정했다. 그 날짜 이하(당일 포함)는 조교가 지울 수 없다.')
              : (month + ' 은 옛 방식으로 월 전체가 잠긴 달이다(2026-08-05 이전 확정분).'),
            확정마감일: 마감일 || '(없음)',
            옛월단위잠금: !!md.locked,
            잠근시각: (내레코드 && 내레코드.lockedAt) || md.lockedAt || '(기록 없음)',
            지우려던날짜: date,
            기기: 기기,
            효과: '없음. 확정된 구간의 지급액이 뒤늦게 줄어드는 것을 막는다.',
          },
        });
        return Response.json({
          error: 마감에걸림
            ? ('' + 마감일 + ' 까지는 정산이 확정되어 삭제할 수 없어요. 원장님께 문의해주세요.')
            : '이 달은 정산이 확정되어 삭제할 수 없어요. 원장님께 문의해주세요.',
        }, { status: 423 });
      }
      if (md.entries && md.entries[date]) {
        // 🔴 지우면 되돌릴 수 없다 — 지워지는 값을 통째로 남긴다(이미 읽은 데이터라 추가 조회 없음).
        const 지운항목 = JSON.parse(JSON.stringify(md.entries[date]));
        const 지운시간 = entryHours(지운항목);
        delete md.entries[date];
        await writeMonth(env, selfDigits, month, md);
        await logAudit(env, request, {
          action: 'staff.worklog.delete',
          target: selfDigits + ' / ' + date, targetName: 내이름,
          summary: '[' + 내이름 + '] ' + date + ' 근무기록 삭제 — ' + 지운시간 + '시간이 그 달 합계에서 빠짐 · ' + 기기,
          detail: {
            조교: { 전화번호: selfDigits, 이름: 내이름 },
            날짜: date, 달: month,
            지운항목: {
              출근: 지운항목.start || '', 퇴근: 지운항목.end || '',
              직접입력시간: 지운항목.hours === undefined ? '' : 지운항목.hours,
              메모: 지운항목.memo || '', 계산된시간: 지운시간,
              마지막수정: 지운항목.updatedAt || '',
            },
            남은일수: Object.keys(md.entries || {}).length,
            기기: 기기,
            효과: '이 날짜가 속한 급여구간 총 근무시간이 ' + 지운시간 + '시간 줄어 그만큼 급여가 줄어든다. '
              + 'R2에서 완전히 사라지므로 복구하려면 이 로그의 「지운항목」을 보고 다시 입력해야 한다.',
            비고: '조교 본인이 지웠다. 확정 마감일보다 뒤 날짜라 삭제가 허용된 것이다.',
          },
        });
        return Response.json({ ok: true, removed: 1, date });
      }
      // 지울 게 없었던 경우도 남긴다 — "지웠는데 남아있다"류 착각을 가르는 근거.
      await logAudit(env, request, {
        action: 'staff.worklog.delete.noop',
        target: selfDigits + ' / ' + date, targetName: 내이름,
        summary: '[' + 내이름 + '] ' + date + ' 근무기록 삭제 요청 — 지울 기록이 없었음(변화 없음)',
        detail: {
          결과: '삭제 0건. R2 파일도 다시 쓰지 않았다.',
          날짜: date, 달: month,
          그달기록일수: Object.keys((md && md.entries) || {}).length,
          기기: 기기,
          효과: '없음. 이미 지워졌거나 처음부터 그 날 기록이 없었다.',
        },
      });
      return Response.json({ ok: true, removed: 0, date });
    }

    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  } catch (e) {
    // 🔴 여기까지 오면 처리가 중간에 터진 것 — R2에 반쯤 쓰였을 수도 있다. 반드시 남긴다.
    await logAudit(env, request, {
      action: 'staff.worklog.fail',
      target: selfDigits || '', targetName: 내이름,
      summary: '근무기록 처리 중 오류 — ' + request.method + ' · ' + String((e && e.message) || e).slice(0, 120),
      detail: {
        결과: '실패. 요청이 끝까지 처리되지 않았다.',
        오류: String((e && e.stack) || (e && e.message) || e).slice(0, 2000),
        메서드: request.method,
        조교: { 전화번호: selfDigits || '(원장/비조교)', 이름: 내이름 },
        기기: 기기,
        효과: 'R2 쓰기 전에 터졌으면 아무것도 안 바뀌었고, 쓰기 도중이면 그 달 파일만 영향을 받는다. '
          + '해당 달을 조회해 실제 상태를 확인할 것.',
      },
    });
    return safeError(e, env, { message: '근무기록 처리에 실패했습니다.' });
  }
}
