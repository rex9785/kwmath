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
import { listStaff, getStaffRecord } from './_staff.js';
import { normalizePhone } from './_auth.js';
import { safeError } from './_errors.js';

const WKEY = (digits, month) => 'staff-worklog/' + digits + '/' + month + '.json';
const onlyDigits = (p) => String(p || '').replace(/\D/g, '');
const isMonth = (m) => /^\d{4}-\d{2}$/.test(String(m || ''));
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const isHHMM = (t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(t || ''));

function thisMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
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
  if (!isAdminTok) return Response.json({ error: '인증이 필요합니다.' }, { status: 401 });

  const url = new URL(request.url);
  const selfDigits = onlyDigits(request.headers.get('X-Staff-Phone') || '');   // 조교면 값 있음, 원장이면 ''
  const isStaff = !!selfDigits;

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
        hourlyWage: wage,
        totalHours: sum.totalHours, totalPay: sum.totalPay, dayCount: sum.dayCount,
        entries: sum.rows,
      });
    }

    // ───────── POST (조교 본인만) ─────────
    if (request.method === 'POST') {
      if (!isStaff) return Response.json({ error: '근무기록은 조교 본인만 입력할 수 있어요.' }, { status: 403 });
      let body = {};
      try { body = await request.json(); } catch (_) {}

      const date = String(body.date || '').trim();
      if (!isDate(date)) return Response.json({ error: 'date(YYYY-MM-DD)가 필요합니다.' }, { status: 400 });

      const entry = { updatedAt: new Date().toISOString() };
      const hasStart = body.start !== undefined && body.start !== '';
      const hasEnd = body.end !== undefined && body.end !== '';
      if (hasStart || hasEnd) {
        if (!isHHMM(body.start) || !isHHMM(body.end))
          return Response.json({ error: '출근/퇴근 시각을 HH:MM 형식으로 둘 다 입력해주세요.' }, { status: 400 });
        const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
        if (toMin(body.end) <= toMin(body.start))
          return Response.json({ error: '퇴근 시각이 출근 시각보다 늦어야 해요.' }, { status: 400 });
        entry.start = body.start; entry.end = body.end;
      } else {
        const h = Number(body.hours);
        if (!Number.isFinite(h) || h <= 0 || h > 24)
          return Response.json({ error: '근무시간(시간)을 0~24 사이로 입력하거나, 출퇴근 시각을 넣어주세요.' }, { status: 400 });
        entry.hours = Math.round(h * 100) / 100;
      }
      if (typeof body.memo === 'string') entry.memo = body.memo.slice(0, 500);

      const month = date.slice(0, 7);
      const md = await readMonth(env, selfDigits, month);
      md.entries = md.entries || {};
      md.entries[date] = entry;
      await writeMonth(env, selfDigits, month, md);

      return Response.json({ ok: true, date, hours: entryHours(entry), entry });
    }

    // ───────── DELETE (조교 본인만) ─────────
    if (request.method === 'DELETE') {
      if (!isStaff) return Response.json({ error: '근무기록은 조교 본인만 삭제할 수 있어요.' }, { status: 403 });
      const date = String(url.searchParams.get('date') || '').trim();
      if (!isDate(date)) return Response.json({ error: 'date(YYYY-MM-DD)가 필요합니다.' }, { status: 400 });
      const month = date.slice(0, 7);
      const md = await readMonth(env, selfDigits, month);
      if (md.entries && md.entries[date]) {
        delete md.entries[date];
        await writeMonth(env, selfDigits, month, md);
        return Response.json({ ok: true, removed: 1, date });
      }
      return Response.json({ ok: true, removed: 0, date });
    }

    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  } catch (e) {
    return safeError(e, env, { message: '근무기록 처리에 실패했습니다.' });
  }
}
