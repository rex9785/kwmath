// /api/homework — 학생 과제 사진 제출 (R2 저장 · 장수 사실상 무제한)
// ──────────────────────────────────────────────────────────────────────
// ▸ 왜 R2인가: 질의응답(qna) 사진은 base64로 D1 '한 행'에 넣어 2MB/행 제약 때문에
//   최대 4장이었다. 과제는 사진을 D1이 아니라 R2에 '장당 개별 객체'로 저장하므로
//   그 한계가 사라진다 → 20장, 50장도 가능. D1엔 사진의 R2 키 목록(작은 문자열)만 둔다.
//
// ▸ 인증
//   - 학생/학부모: Bearer 포털토큰 → requireStudentAccess → student.id 로 스코프.
//     (식별은 반드시 student.id — 동명이인 안전. 이름은 표시용으로만 저장.)
//   - 원장(admin): Bearer ADMIN_PASSWORD (미들웨어가 adm_/ast_ 세션을 번역).
//     ※ 과제 생성/열람/삭제는 원장만. 조교 스코프는 v1에선 원장 전용으로 단순화.
//
// ▸ 데이터
//   homework_assignments(id, title, detail, due_date, target_academy, target_class,
//                        active, created_by, created_at)
//   homework_submissions(id, assignment_id, student_id, student_name, author_phone,
//                        photo_keys(JSON 배열), photo_count, note, status,
//                        created_at, updated_at)   UNIQUE(assignment_id, student_id)
//   R2 키: homework/{assignment_id}/{student_id}/{ts}_{rand}_{safeName}
//
// ▸ 라우트
//   GET   ?name=..                        학생: 활성 과제 목록 + 내 제출상태
//   GET   ?mine=1&assignment_id=..        학생: 내 제출 상세(사진 키 목록)
//   GET   ?admin=1                        원장: 전체 과제 + 제출 학생수
//   GET   ?admin=1&assignment_id=..       원장: 그 과제의 제출 목록(학생별)
//   GET   ?photo=1&key=..                 사진 스트림(학생=본인 것만 · 원장=전부)
//   POST  (multipart, file[])            학생: assignment_id에 사진 제출(≤50/회)
//   POST  ?admin=1 (json)                원장: 과제 생성 {title, detail, due_date, ...}
//   POST  ?admin=1&action=toggle&id=..   원장: 활성/마감 토글
//   DELETE?key=..                        학생: 내 사진 1장 삭제
//   DELETE?admin=1&id=..                 원장: 과제 삭제(+제출행+R2 사진 정리)

import { requireStudentAccess } from './_auth.js';

// ── 상한(관우T 결정: 한 번에 안전상한 50장) ──
const MAX_PER_UPLOAD = 50;      // 한 번 업로드에 올릴 수 있는 최대 장수
const MAX_TOTAL_PER_STUDENT = 300; // 한 학생이 한 과제에 쌓을 수 있는 총 상한(폭주 방지·사실상 무제한)
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 사진 1장 최대 15MB (휴대폰 원본 여유)

function jsonOk(data, status = 200) { return Response.json(data, { status }); }
function jsonErr(msg, status = 400) { return Response.json({ error: msg }, { status }); }

function nowIso() { return new Date().toISOString(); }

function safeName(name) {
  return String(name || 'photo').replace(/[^a-zA-Z0-9가-힣.\-_]/g, '_').slice(0, 80) || 'photo';
}

function isImage(file) {
  const t = (file && file.type || '').toLowerCase();
  if (t.startsWith('image/')) return true;
  // 일부 브라우저가 HEIC를 빈 타입으로 넘김 → 확장자로 보조 판정
  const n = (file && file.name || '').toLowerCase();
  return /\.(jpg|jpeg|png|gif|webp|heic|heif|bmp)$/.test(n);
}

function parseKeys(row) {
  if (!row || !row.photo_keys) return [];
  try { const a = JSON.parse(row.photo_keys); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}

// homework/{aid}/{studentId}/{file} → {aid, studentId}
function parseHwKey(key) {
  const parts = String(key || '').split('/');
  if (parts[0] !== 'homework' || parts.length < 4) return null;
  return { aid: parts[1], studentId: parts[2] };
}

async function ensureTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS homework_assignments (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'title TEXT NOT NULL, detail TEXT, due_date TEXT, ' +
    'target_academy TEXT, target_class TEXT, ' +
    'active INTEGER DEFAULT 1, created_by TEXT, created_at TEXT)'
  ).run();
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS homework_submissions (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'assignment_id INTEGER NOT NULL, student_id INTEGER NOT NULL, ' +
    'student_name TEXT, author_phone TEXT, ' +
    'photo_keys TEXT, photo_count INTEGER DEFAULT 0, ' +
    'note TEXT, status TEXT, created_at TEXT, updated_at TEXT)'
  ).run();
  try { await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_hw_sub_uniq ON homework_submissions(assignment_id, student_id)').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_hw_sub_aid ON homework_submissions(assignment_id)').run(); } catch (_) {}
}

// 과제가 이 학생에게 보이는지(스코프). target 비었으면 전체 공개.
function visibleToStudent(a, student) {
  const ta = (a.target_academy || '').trim();
  const tc = (a.target_class || '').trim();
  if (ta && ta !== (student.academy || '')) return false;
  if (tc && tc !== (student.className || '')) return false;
  return true;
}

async function listAllUnder(env, prefix, cap = 5000) {
  const out = [];
  let cursor;
  do {
    const listed = await env.BUCKET.list({ prefix, limit: 1000, cursor });
    for (const o of (listed.objects || [])) out.push(o.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor && out.length < cap);
  return out;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;

  try { await ensureTable(env); }
  catch (e) { return jsonErr('과제방 DB 초기화에 실패했습니다.', 500); }

  try {
    // ═══════════════════════════ GET ═══════════════════════════
    if (method === 'GET') {
      // 사진 스트림 — 학생은 본인 것만, 원장은 전부
      if (url.searchParams.get('photo') === '1') {
        const key = url.searchParams.get('key') || '';
        const meta = parseHwKey(key);
        if (!meta) return jsonErr('잘못된 사진 키입니다.', 400);
        if (!isAdmin) {
          const access = await requireStudentAccess(env, request);
          if (!access.ok) return access.response;
          if (String(meta.studentId) !== String(access.student.id)) {
            return jsonErr('본인 과제 사진만 볼 수 있어요.', 403);
          }
        }
        const object = await env.BUCKET.get(key);
        if (!object) return jsonErr('사진을 찾을 수 없어요.', 404);
        const fileName = (key.split('/').pop() || 'photo').replace(/[\r\n"]/g, '');
        const contentType = object.httpMetadata?.contentType || 'image/jpeg';
        return new Response(object.body, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'private, max-age=3600',
          },
        });
      }

      // 원장 — 전체 과제 목록(+제출 학생수) 또는 특정 과제 제출 현황
      if (url.searchParams.get('admin') === '1') {
        if (!isAdmin) return jsonErr('관리자 인증이 필요합니다.', 401);
        const aid = url.searchParams.get('assignment_id');
        if (aid) {
          const { results } = await env.DB.prepare(
            'SELECT * FROM homework_submissions WHERE assignment_id=? AND photo_count>0 ORDER BY updated_at DESC, id DESC'
          ).bind(aid).all();
          const subs = (results || []).map(r => ({
            id: r.id, studentId: r.student_id, studentName: r.student_name || '',
            photoCount: r.photo_count || 0, photoKeys: parseKeys(r),
            note: r.note || '', updatedAt: r.updated_at || r.created_at || '',
          }));
          const a = await env.DB.prepare('SELECT * FROM homework_assignments WHERE id=?').bind(aid).first();
          return jsonOk({ ok: true, assignment: a || null, submissions: subs });
        }
        const { results } = await env.DB.prepare(
          'SELECT a.*, ' +
          '(SELECT COUNT(*) FROM homework_submissions s WHERE s.assignment_id=a.id AND s.photo_count>0) AS submit_count, ' +
          '(SELECT COALESCE(SUM(s.photo_count),0) FROM homework_submissions s WHERE s.assignment_id=a.id) AS photo_total ' +
          'FROM homework_assignments a ORDER BY a.active DESC, a.created_at DESC, a.id DESC'
        ).all();
        const list = (results || []).map(r => ({
          id: r.id, title: r.title, detail: r.detail || '', dueDate: r.due_date || '',
          targetAcademy: r.target_academy || '', targetClass: r.target_class || '',
          active: r.active === 1, createdAt: r.created_at || '',
          submitCount: r.submit_count || 0, photoTotal: r.photo_total || 0,
        }));
        return jsonOk({ ok: true, assignments: list });
      }

      // 학생/학부모 — 토큰 필요
      const access = await requireStudentAccess(env, request);
      if (!access.ok) return access.response;
      const student = access.student;

      // 내 제출 상세(사진 목록)
      if (url.searchParams.get('mine') === '1') {
        const aid = url.searchParams.get('assignment_id');
        if (!aid) return jsonErr('assignment_id가 필요합니다.', 400);
        const row = await env.DB.prepare(
          'SELECT * FROM homework_submissions WHERE assignment_id=? AND student_id=?'
        ).bind(aid, student.id).first();
        const keys = parseKeys(row);
        return jsonOk({
          ok: true,
          photoCount: keys.length,
          photoKeys: keys,
          note: (row && row.note) || '',
          maxTotal: MAX_TOTAL_PER_STUDENT,
          maxPerUpload: MAX_PER_UPLOAD,
        });
      }

      // 활성 과제 목록 + 내 제출상태
      const { results } = await env.DB.prepare(
        'SELECT a.*, s.photo_count AS my_count, s.updated_at AS my_updated ' +
        'FROM homework_assignments a ' +
        'LEFT JOIN homework_submissions s ON s.assignment_id=a.id AND s.student_id=? ' +
        'WHERE a.active=1 ORDER BY a.created_at DESC, a.id DESC'
      ).bind(student.id).all();
      const list = (results || [])
        .filter(a => visibleToStudent(a, student))
        .map(a => ({
          id: a.id, title: a.title, detail: a.detail || '', dueDate: a.due_date || '',
          myPhotoCount: a.my_count || 0,
          submitted: (a.my_count || 0) > 0,
          myUpdatedAt: a.my_updated || '',
        }));
      return jsonOk({
        ok: true, assignments: list,
        student: { id: student.id, name: student.name },
        maxPerUpload: MAX_PER_UPLOAD, maxTotal: MAX_TOTAL_PER_STUDENT,
      });
    }

    // ═══════════════════════════ POST ═══════════════════════════
    if (method === 'POST') {
      // 원장 — 과제 생성 / 토글
      if (url.searchParams.get('admin') === '1') {
        if (!isAdmin) return jsonErr('관리자 인증이 필요합니다.', 401);
        const action = url.searchParams.get('action');
        if (action === 'toggle') {
          const id = url.searchParams.get('id');
          if (!id) return jsonErr('id가 필요합니다.', 400);
          const cur = await env.DB.prepare('SELECT active FROM homework_assignments WHERE id=?').bind(id).first();
          if (!cur) return jsonErr('과제를 찾을 수 없어요.', 404);
          const next = cur.active === 1 ? 0 : 1;
          await env.DB.prepare('UPDATE homework_assignments SET active=? WHERE id=?').bind(next, id).run();
          return jsonOk({ ok: true, id: Number(id), active: next === 1 });
        }
        const b = await request.json().catch(() => ({}));
        const title = (b.title || '').trim();
        if (!title) return jsonErr('과제 제목을 입력해 주세요.', 400);
        const res = await env.DB.prepare(
          'INSERT INTO homework_assignments (title, detail, due_date, target_academy, target_class, active, created_by, created_at) ' +
          'VALUES (?,?,?,?,?,1,?,?)'
        ).bind(
          title,
          (b.detail || '').trim() || null,
          (b.dueDate || b.due_date || '').trim() || null,
          (b.targetAcademy || b.target_academy || '').trim() || null,
          (b.targetClass || b.target_class || '').trim() || null,
          'admin', nowIso()
        ).run();
        const newId = res.meta && res.meta.last_row_id;
        return jsonOk({ ok: true, id: newId });
      }

      // 학생 — 사진 제출(multipart)
      const access = await requireStudentAccess(env, request);
      if (!access.ok) return access.response;
      const student = access.student;

      let form;
      try { form = await request.formData(); }
      catch (e) { return jsonErr('업로드 형식이 올바르지 않습니다.', 400); }

      const aid = (form.get('assignment_id') || '').toString().trim();
      if (!aid) return jsonErr('assignment_id가 필요합니다.', 400);

      const assignment = await env.DB.prepare(
        'SELECT * FROM homework_assignments WHERE id=?'
      ).bind(aid).first();
      if (!assignment) return jsonErr('과제를 찾을 수 없어요.', 404);
      if (assignment.active !== 1) return jsonErr('마감된 과제입니다. 선생님께 문의해 주세요.', 400);
      if (!visibleToStudent(assignment, student)) return jsonErr('제출 대상이 아닌 과제입니다.', 403);

      const files = form.getAll('file').filter(f => f && typeof f !== 'string');
      if (!files.length) return jsonErr('사진을 한 장 이상 선택해 주세요.', 400);
      if (files.length > MAX_PER_UPLOAD) {
        return jsonErr('한 번에 최대 ' + MAX_PER_UPLOAD + '장까지 올릴 수 있어요.', 400);
      }

      // 기존 제출 사진
      const existing = await env.DB.prepare(
        'SELECT * FROM homework_submissions WHERE assignment_id=? AND student_id=?'
      ).bind(aid, student.id).first();
      const existingKeys = parseKeys(existing);
      if (existingKeys.length + files.length > MAX_TOTAL_PER_STUDENT) {
        return jsonErr('이 과제에 올릴 수 있는 총 장수(' + MAX_TOTAL_PER_STUDENT + '장)를 넘었어요. 필요 없는 사진을 지운 뒤 올려 주세요.', 400);
      }

      // 각 파일 R2 업로드
      const newKeys = [];
      for (const file of files) {
        if (!isImage(file)) return jsonErr('이미지 파일만 올릴 수 있어요.', 400);
        if (file.size > MAX_FILE_BYTES) {
          return jsonErr('사진 한 장이 너무 큽니다(최대 15MB): ' + (file.name || ''), 400);
        }
        const key = 'homework/' + aid + '/' + student.id + '/' +
          Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + safeName(file.name);
        await env.BUCKET.put(key, file.stream(), {
          httpMetadata: { contentType: file.type || 'image/jpeg' },
        });
        newKeys.push(key);
      }

      const allKeys = existingKeys.concat(newKeys);
      const note = (form.get('note') || '').toString().slice(0, 500);
      const ts = nowIso();
      if (existing) {
        await env.DB.prepare(
          'UPDATE homework_submissions SET photo_keys=?, photo_count=?, note=?, status=?, updated_at=? WHERE id=?'
        ).bind(JSON.stringify(allKeys), allKeys.length, note || existing.note || '', 'submitted', ts, existing.id).run();
      } else {
        await env.DB.prepare(
          'INSERT INTO homework_submissions (assignment_id, student_id, student_name, author_phone, photo_keys, photo_count, note, status, created_at, updated_at) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?)'
        ).bind(
          aid, student.id, student.name || '', access.phone || '',
          JSON.stringify(allKeys), allKeys.length, note, 'submitted', ts, ts
        ).run();
      }
      return jsonOk({ ok: true, added: newKeys.length, photoCount: allKeys.length });
    }

    // ═══════════════════════════ DELETE ═══════════════════════════
    if (method === 'DELETE') {
      // 원장 — 과제 삭제(+제출행 + R2 사진 정리)
      if (url.searchParams.get('admin') === '1') {
        if (!isAdmin) return jsonErr('관리자 인증이 필요합니다.', 401);
        const id = url.searchParams.get('id');
        if (!id) return jsonErr('id가 필요합니다.', 400);
        // R2 사진 일괄 정리
        try {
          const keys = await listAllUnder(env, 'homework/' + id + '/');
          for (let i = 0; i < keys.length; i += 1000) {
            await env.BUCKET.delete(keys.slice(i, i + 1000));
          }
        } catch (_) {}
        await env.DB.prepare('DELETE FROM homework_submissions WHERE assignment_id=?').bind(id).run();
        await env.DB.prepare('DELETE FROM homework_assignments WHERE id=?').bind(id).run();
        return jsonOk({ ok: true, deleted: Number(id) });
      }

      // 학생 — 내 사진 1장 삭제
      const key = url.searchParams.get('key') || '';
      const meta = parseHwKey(key);
      if (!meta) return jsonErr('잘못된 사진 키입니다.', 400);
      const access = await requireStudentAccess(env, request);
      if (!access.ok) return access.response;
      const student = access.student;
      if (String(meta.studentId) !== String(student.id)) {
        return jsonErr('본인 과제 사진만 삭제할 수 있어요.', 403);
      }
      const row = await env.DB.prepare(
        'SELECT * FROM homework_submissions WHERE assignment_id=? AND student_id=?'
      ).bind(meta.aid, student.id).first();
      if (!row) return jsonErr('제출 내역을 찾을 수 없어요.', 404);
      const keys = parseKeys(row).filter(k => k !== key);
      try { await env.BUCKET.delete(key); } catch (_) {}
      await env.DB.prepare(
        'UPDATE homework_submissions SET photo_keys=?, photo_count=?, updated_at=? WHERE id=?'
      ).bind(JSON.stringify(keys), keys.length, nowIso(), row.id).run();
      return jsonOk({ ok: true, photoCount: keys.length });
    }

    return jsonErr('허용되지 않은 메서드입니다.', 405);
  } catch (e) {
    return jsonErr('처리 중 오류가 발생했습니다: ' + (e && e.message ? e.message : e), 500);
  }
}
