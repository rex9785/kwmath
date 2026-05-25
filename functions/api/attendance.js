// /api/attendance
// 출석 + 숙제 완료율 기록 R2 저장. 학생별 1개 파일.
//
// 저장 경로: attendance/{학생이름}.json
// records[date] 는 다음 둘 중 하나:
//   - string (옛 데이터)            예: "출석"
//   - object {status, homework?, homework_note?, note?, method?, ...}
// 응답은 항상 object 로 정규화해서 내려줌.
//
// GET ?name=홍길동                  — 특정 학생의 전체 기록 (admin 또는 본인)
// GET ?name=홍길동&month=2026-05    — 특정 월만
// GET ?all=1                        — 모든 학생 (admin only)
// POST { name, date, status?, homework?, homework_note?, note? } — 부분 업데이트 가능 (admin only)
// DELETE { name, date }             — 그날 기록 통째로 삭제 (admin only)
//
// status: '출석' / '지각' / '결석' / '병결' / '공결'
// homework: 0~100 (5단계 권장: 0, 25, 50, 75, 100)

import { requireStudentAccess } from './_auth.js';

const VALID_STATUS = ['출석', '지각', '결석', '병결', '공결'];

function normalizeRecord(v) {
  if (v == null) return null;
  if (typeof v === 'string') return { status: v };
  if (typeof v === 'object') return v;
  return null;
}
function normalizeRecords(records) {
  const out = {};
  if (records && typeof records === 'object') {
    for (const [d, v] of Object.entries(records)) {
      const n = normalizeRecord(v);
      if (n) out[d] = n;
    }
  }
  return out;
}

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  const url = new URL(request.url);

  // ── GET ──
  if (request.method === 'GET') {
    if (isAdmin && url.searchParams.get('all') === '1') {
      try {
        const listed = await env.BUCKET.list({ prefix: 'attendance/', limit: 500 });
        const out = [];
        for (const obj of (listed.objects || [])) {
          try {
            const o = await env.BUCKET.get(obj.key);
            if (!o) continue;
            const rec = JSON.parse(await o.text());
            rec.records = normalizeRecords(rec.records);
            out.push(rec);
          } catch {}
        }
        return Response.json(out);
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    let targetName = (url.searchParams.get('name') || '').trim();
    if (!isAdmin) {
      const access = await requireStudentAccess(env, request);
      if (!access.ok) return access.response;
      targetName = access.student.name;
    }
    if (!targetName) return Response.json({ error: 'name 필수' }, { status: 400 });

    try {
      const obj = await env.BUCKET.get('attendance/' + encodeURIComponent(targetName) + '.json');
      if (!obj) return Response.json({ name: targetName, records: {}, updatedAt: null });
      const rec = JSON.parse(await obj.text());
      rec.records = normalizeRecords(rec.records);

      const month = (url.searchParams.get('month') || '').trim();
      if (month) {
        const filtered = {};
        for (const [date, r] of Object.entries(rec.records)) {
          if (date.startsWith(month)) filtered[date] = r;
        }
        rec.records = filtered;
      }
      return Response.json(rec);
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  // ── POST: 부분 업데이트 (status 또는 homework 등 일부만) — admin only ──
  if (request.method === 'POST') {
    if (!isAdmin) return Response.json({ error: 'admin 인증 필요' }, { status: 401 });

    let body = {};
    try { body = await request.json(); } catch {}
    const name = (body.name || '').trim();
    const date = (body.date || '').trim();
    if (!name) return Response.json({ error: 'name 필수' }, { status: 400 });
    if (!date) return Response.json({ error: 'date(YYYY-MM-DD) 필수' }, { status: 400 });

    const updates = {};
    if (typeof body.status === 'string' && body.status) {
      if (!VALID_STATUS.includes(body.status))
        return Response.json({ error: 'status는 ' + VALID_STATUS.join('/') + ' 중 하나' }, { status: 400 });
      updates.status = body.status;
    }
    if (body.homework !== undefined && body.homework !== null && body.homework !== '') {
      const pct = Number(body.homework);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100)
        return Response.json({ error: 'homework는 0~100' }, { status: 400 });
      updates.homework = Math.round(pct);
    }
    if (typeof body.homework_note === 'string') updates.homework_note = body.homework_note;
    if (typeof body.note === 'string') updates.note = body.note;

    if (!Object.keys(updates).length)
      return Response.json({ error: '업데이트할 필드 없음(status/homework/homework_note/note)' }, { status: 400 });

    const key = 'attendance/' + encodeURIComponent(name) + '.json';
    let rec = { name, records: {}, updatedAt: '' };
    try {
      const obj = await env.BUCKET.get(key);
      if (obj) {
        const parsed = JSON.parse(await obj.text());
        if (parsed && typeof parsed === 'object') rec = parsed;
        if (!rec.records) rec.records = {};
      }
    } catch {}
    rec.records = normalizeRecords(rec.records);
    rec.name = name;

    const prev = rec.records[date] || {};
    const merged = { ...prev, ...updates };
    rec.records[date] = merged;
    rec.updatedAt = new Date().toISOString();

    try {
      await env.BUCKET.put(key, JSON.stringify(rec), { httpMetadata: { contentType: 'application/json' } });
      return Response.json({ ok: true, name, date, record: merged });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  // ── DELETE: 특정 날짜 기록 삭제 (admin only) ──
  if (request.method === 'DELETE') {
    if (!isAdmin) return Response.json({ error: 'admin 인증 필요' }, { status: 401 });
    let body = {};
    try { body = await request.json(); } catch {}
    const name = (body.name || '').trim();
    const date = (body.date || '').trim();
    if (!name || !date) return Response.json({ error: 'name + date 필수' }, { status: 400 });

    const key = 'attendance/' + encodeURIComponent(name) + '.json';
    try {
      const obj = await env.BUCKET.get(key);
      if (!obj) return Response.json({ ok: true, removed: 0 });
      const rec = JSON.parse(await obj.text());
      rec.records = normalizeRecords(rec.records);
      if (rec.records[date]) {
        delete rec.records[date];
        rec.updatedAt = new Date().toISOString();
        await env.BUCKET.put(key, JSON.stringify(rec), { httpMetadata: { contentType: 'application/json' } });
        return Response.json({ ok: true, removed: 1 });
      }
      return Response.json({ ok: true, removed: 0 });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
