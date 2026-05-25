// /api/attendance
// 출석 기록 R2 저장. 학생별 1개 파일.
//
// 저장 경로: attendance/{학생이름}.json
// 구조: { name, records: { "2026-05-25": "출석"|"지각"|"결석", ... }, updatedAt }
//
// GET ?name=홍길동           — 특정 학생의 전체 기록 (admin 또는 본인)
// GET ?name=홍길동&month=2026-05  — 특정 월만
// GET ?all=1                 — 모든 학생 (admin only)
// POST { name, date, status, note? } — 출석 기록 (admin only)
// DELETE { name, date }      — 기록 삭제 (admin only)
//
// status: '출석' / '지각' / '결석' / '병결' / '공결'

import { requireStudentAccess } from './_auth.js';

const VALID_STATUS = ['출석', '지각', '결석', '병결', '공결'];

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  const url = new URL(request.url);

  // ── GET ──
  if (request.method === 'GET') {
    // admin 모드: ?all=1로 모든 학생
    if (isAdmin && url.searchParams.get('all') === '1') {
      try {
        const listed = await env.BUCKET.list({ prefix: 'attendance/', limit: 500 });
        const out = [];
        for (const obj of (listed.objects || [])) {
          try {
            const o = await env.BUCKET.get(obj.key);
            if (!o) continue;
            const rec = JSON.parse(await o.text());
            out.push(rec);
          } catch {}
        }
        return Response.json(out);
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    // 특정 학생
    let targetName = (url.searchParams.get('name') || '').trim();

    if (!isAdmin) {
      // 사용자 모드: 토큰 검증 + 학생 매칭
      const access = await requireStudentAccess(env, request);
      if (!access.ok) return access.response;
      targetName = access.student.name;
    }

    if (!targetName) return Response.json({ error: 'name 필수' }, { status: 400 });

    try {
      const obj = await env.BUCKET.get('attendance/' + encodeURIComponent(targetName) + '.json');
      if (!obj) return Response.json({ name: targetName, records: {}, updatedAt: null });
      const rec = JSON.parse(await obj.text());

      // ?month=2026-05면 그 달 기록만 필터
      const month = (url.searchParams.get('month') || '').trim();
      if (month && rec.records) {
        const filtered = {};
        for (const [date, status] of Object.entries(rec.records)) {
          if (date.startsWith(month)) filtered[date] = status;
        }
        rec.records = filtered;
      }
      return Response.json(rec);
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  // ── POST: 출석 기록 (admin only) ──
  if (request.method === 'POST') {
    if (!isAdmin) return Response.json({ error: 'admin 인증 필요' }, { status: 401 });

    let body = {};
    try { body = await request.json(); } catch {}
    const name = (body.name || '').trim();
    const date = (body.date || '').trim();
    const status = (body.status || '').trim();
    const note = (body.note || '').trim();

    if (!name)   return Response.json({ error: 'name 필수' }, { status: 400 });
    if (!date)   return Response.json({ error: 'date(YYYY-MM-DD) 필수' }, { status: 400 });
    if (!VALID_STATUS.includes(status))
      return Response.json({ error: 'status는 ' + VALID_STATUS.join('/') + ' 중 하나' }, { status: 400 });

    const key = 'attendance/' + encodeURIComponent(name) + '.json';
    let rec = { name, records: {}, notes: {}, updatedAt: '' };
    try {
      const obj = await env.BUCKET.get(key);
      if (obj) {
        const parsed = JSON.parse(await obj.text());
        if (parsed && typeof parsed === 'object') rec = parsed;
        if (!rec.records) rec.records = {};
        if (!rec.notes) rec.notes = {};
      }
    } catch {}

    rec.name = name;
    rec.records[date] = status;
    if (note) rec.notes[date] = note;
    else delete rec.notes[date];
    rec.updatedAt = new Date().toISOString();

    try {
      await env.BUCKET.put(key, JSON.stringify(rec), { httpMetadata: { contentType: 'application/json' } });
      return Response.json({ ok: true, name, date, status });
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
      if (rec.records && rec.records[date]) {
        delete rec.records[date];
        if (rec.notes) delete rec.notes[date];
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
