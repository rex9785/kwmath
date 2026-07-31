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
// 엔드포인트:
//   GET  ?month=YYYY-MM                 → 본인(조교) 그 달 기록 + 합계
//   GET  ?phone=010...&month=YYYY-MM    → (원장) 특정 조교 그 달 기록 + 합계
//   GET  ?all=1&month=YYYY-MM           → (원장) 전체 조교 그 달 합계 요약
//   POST { date, hours? | start?,end?, memo? }  → (조교 본인) 그 날 upsert
//   DELETE ?date=YYYY-MM-DD             → (조교 본인) 그 날 삭제
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
export async function staffMonthSummary(env, phoneDigits, month, hourlyWage) {
  const md = await readMonth(env, onlyDigits(phoneDigits), month);
  return summarize(md, hourlyWage);
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
      const month = isMonth(url.searchParams.get('month')) ? url.searchParams.get('month') : thisMonth();

      // 원장 전체 요약
      if (!isStaff && url.searchParams.get('all') === '1') {
        const staff = await listStaff(env);
        const out = [];
        for (const s of staff) {
          const d = onlyDigits(s.phone);
          const md = await readMonth(env, d, month);
          const sum = summarize(md, s.hourlyWage);
          out.push({
            phone: s.phone, name: s.name || '', academy: s.academy || '',
            hourlyWage: s.hourlyWage || 0, approved: !!s.approved,
            totalHours: sum.totalHours, totalPay: sum.totalPay, dayCount: sum.dayCount,
          });
        }
        return Response.json({ ok: true, month, staff: out });
      }

      // 대상 조교: 본인(조교) 또는 ?phone=(원장)
      const targetDigits = isStaff ? selfDigits : onlyDigits(url.searchParams.get('phone') || '');
      if (!targetDigits) return Response.json({ error: '조회할 조교(phone)가 필요합니다.' }, { status: 400 });

      const rec = await getStaffRecord(env, normalizePhone(targetDigits) || targetDigits);
      const wage = rec ? (rec.hourlyWage || 0) : 0;
      const md = await readMonth(env, targetDigits, month);
      const sum = summarize(md, wage);
      return Response.json({
        ok: true, phone: targetDigits, month,
        name: rec ? (rec.name || '') : '', academy: rec ? (rec.academy || '') : '',
        hourlyWage: wage, account: rec ? (rec.account || '') : '',
        totalHours: sum.totalHours, totalPay: sum.totalPay, dayCount: sum.dayCount,
        entries: sum.rows,
        locked: !!md.locked, lockedAt: md.lockedAt || null,
      });
    }

    // ───────── POST ─────────
    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (_) {}

      // 원장: 특정 조교의 그 달을 잠금/해제(정산 확정). 잠그면 그 조교는 그 달 기록을 못 고침.
      //   원장(adm_)은 X-Staff-Phone이 없어 isStaff=false. body.lock 있으면 근무입력이 아니라 잠금 처리.
      if (!isStaff && body.lock !== undefined) {
        const ld = onlyDigits(body.phone || '');
        const lm = String(body.month || '');
        if (!ld || !isMonth(lm)) {
          await logAudit(env, request, {
            action: 'staff.worklog.lock.reject',
            summary: '근무기록 잠금 요청 거부 — 조교 번호 또는 달(month)이 빠졌다',
            detail: {
              결과: '거부(400). 어떤 달의 잠금 상태도 바뀌지 않았다.',
              보낸값: {
                phone: String(body.phone || '').slice(0, 30) || '(빈칸)',
                month: lm || '(빈칸)',
                lock: !!body.lock,
              },
              기기: 기기,
              효과: '없음.',
            },
          });
          return Response.json({ error: '조교(phone)와 달(month)이 필요합니다.' }, { status: 400 });
        }
        const lmd = await readMonth(env, ld, lm);
        // 🔎 lmd 를 그 자리에서 뜯어고치므로(in-place) 손대기 **전에** 이전 잠금 상태를 떠 둔다.
        //   안 그러면 로그의 "전/후"가 똑같이 찍혀 아무 의미가 없다(선례: staff-approve.js).
        const 이전 = { locked: !!lmd.locked, lockedAt: lmd.lockedAt || null };
        const 그달합계 = summarize(lmd, 0);   // 이미 읽은 데이터로 계산 — 추가 조회 없음
        lmd.locked = !!body.lock;
        lmd.lockedAt = lmd.locked ? new Date().toISOString() : null;
        await writeMonth(env, ld, lm, lmd);

        // 📓 잠금 = "이 달 정산 확정". 잠긴 뒤엔 그 조교가 자기 근무기록을 못 고친다(423).
        //   해제는 반대로 확정했던 금액이 다시 움직일 수 있다는 뜻이라 더 중요하게 남긴다.
        await logAudit(env, request, {
          action: lmd.locked ? 'staff.worklog.lock' : 'staff.worklog.unlock',
          target: ld, targetName: '',
          summary: '[' + ld + '] ' + lm + ' 근무기록 ' + (lmd.locked ? '잠금(정산 확정)' : '잠금 해제')
            + (이전.locked === lmd.locked ? ' — 상태 변화 없음(이미 ' + (lmd.locked ? '잠김' : '풀림') + ')' : '')
            + ' · 그 달 기록 ' + 그달합계.dayCount + '일 ' + 그달합계.totalHours + '시간',
          detail: {
            대상조교번호: ld,
            대상월: lm,
            잠금: { 전: 이전.locked ? '잠김' : '풀림', 후: lmd.locked ? '잠김' : '풀림' },
            잠금시각: { 전: 이전.lockedAt || '(없음)', 후: lmd.lockedAt || '(없음)' },
            변화없음: 이전.locked === lmd.locked,
            그시점기록: { 일수: 그달합계.dayCount, 총시간: 그달합계.totalHours },
            기기: 기기,
            효과: lmd.locked
              ? '이제 그 조교는 이 달 근무기록을 추가·수정·삭제할 수 없다(423). 정산 금액이 굳는다.'
              : '그 조교가 이 달 근무기록을 다시 고칠 수 있게 됐다 — 이미 확정했던 정산액이 바뀔 수 있다.',
            비고: '이 요청은 번호만 받으므로 조교 이름은 알 수 없다(이름을 알려면 조회가 한 번 더 필요해 넣지 않았다). '
              + '번호로 대조할 것.',
          },
        });
        return Response.json({ ok: true, phone: ld, month: lm, locked: lmd.locked });
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
      if (md.locked) {
        await logAudit(env, request, {
          action: 'staff.worklog.locked',
          target: selfDigits + ' / ' + date, targetName: 내이름,
          summary: '[' + 내이름 + '] ' + date + ' 근무기록 입력 거부 — ' + month + ' 정산이 확정(잠금)된 달',
          detail: {
            결과: '거부(423). 근무기록이 저장되지 않았다.',
            사유: month + ' 은 원장이 정산 확정(잠금)한 달이라 조교가 고칠 수 없다.',
            잠근시각: md.lockedAt || '(기록 없음)',
            넣으려던값: {
              날짜: date, 출근: entry.start || '', 퇴근: entry.end || '',
              직접입력시간: entry.hours === undefined ? '' : entry.hours,
              계산된시간: entryHours(entry), 메모: entry.memo || '',
            },
            기기: 기기,
            효과: '없음. 확정된 달의 지급액이 뒤늦게 바뀌는 것을 막는다. '
              + '정말 고쳐야 하면 원장이 그 달 잠금을 풀어야 한다(staff.worklog.unlock 으로 남는다).',
            비고: '조교가 "입력이 안 된다"고 하면 이 로그로 잠금 때문인지 바로 확인된다.',
          },
        });
        return Response.json({ error: '이 달은 정산이 확정(잠금)되어 수정할 수 없어요. 원장님께 문의해주세요.' }, { status: 423 });
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
          효과: '이 달(' + month + ') 급여 계산에 바로 반영된다. 시급 × 총시간이 월급이므로 '
            + (이전항목 ? '이 수정폭만큼 지급액이 달라진다.' : '이 시간만큼 지급액이 늘어난다.'),
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
      if (md.locked) {
        await logAudit(env, request, {
          action: 'staff.worklog.locked',
          target: selfDigits + ' / ' + date, targetName: 내이름,
          summary: '[' + 내이름 + '] ' + date + ' 근무기록 삭제 거부 — ' + month + ' 정산이 확정(잠금)된 달',
          detail: {
            결과: '거부(423). 아무것도 지워지지 않았다.',
            사유: month + ' 은 원장이 정산 확정(잠금)한 달이라 조교가 지울 수 없다.',
            잠근시각: md.lockedAt || '(기록 없음)',
            지우려던날짜: date,
            기기: 기기,
            효과: '없음. 확정된 달의 지급액이 뒤늦게 줄어드는 것을 막는다.',
          },
        });
        return Response.json({ error: '이 달은 정산이 확정(잠금)되어 삭제할 수 없어요. 원장님께 문의해주세요.' }, { status: 423 });
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
            효과: '이 달(' + month + ') 총 근무시간이 ' + 지운시간 + '시간 줄어 그만큼 월급이 줄어든다. '
              + 'R2에서 완전히 사라지므로 복구하려면 이 로그의 「지운항목」을 보고 다시 입력해야 한다.',
            비고: '조교 본인이 지웠다. 정산 확정(잠금) 전이라 삭제가 허용된 것이다.',
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
