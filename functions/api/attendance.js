// /api/attendance
// 출석 + 숙제 완료율 — Cloudflare D1 attendance 테이블 (Phase 4 전환, 이전엔 R2 attendance/{name}.json)
// 학생 명단/인증은 _auth(현재 Notion). 이름 → D1 student_id 변환 후 D1 attendance 사용.
//
// GET ?name=홍길동 [&month=YYYY-MM]  — 특정 학생 기록 (admin 또는 본인/자녀)
// GET ?all=1                         — 모든 학생 (admin only)
// POST { name, date, status?, homework?, homework_note?, note? } — 부분 업데이트 (admin only)
// DELETE { name, date }              — 그날 기록 삭제 (admin only)
//
// status: '출석' / '지각' / '결석' / '병결' / '공결'   homework: 0~100

import { requireStudentAccess } from './_auth.js';
import { getStudentByName, getStudentsByPhone, getAttendance, upsertAttendance, deleteAttendance, listAllAttendance, listStudents } from './_db.js';
import { staffScopeAcademy } from './_staff.js';
import { safeError } from './_errors.js';
import { createNotification } from './_notifications.js';
import { sendPushToUsers } from './_push.js';

const VALID_STATUS = ['출석', '지각', '결석', '병결', '공결'];

// 조교(X-Staff-Phone)면 "맡은 학원" 학생 이름 Set, 원장이면 null(제한 없음).
//   미배정 조교는 빈 Set → 아무 출결도 못 봄. POST/DELETE는 미들웨어가 이미 403으로 막음.
async function staffNameScope(env, request) {
  const academy = await staffScopeAcademy(env, request);
  if (academy === null) return null;                               // 원장 → 전체
  const roster = academy ? (await listStudents(env)).filter(s => (s.academy || '') === academy) : [];
  return new Set(roster.map(s => s.name));
}

// 출결 저장 후 자동 알림: 결석 또는 (지각 아닌) 숙제 25%↓ → 알림함 적립 + 학부모 푸시(학생 제외).
//   지각은 제외(관우T 확정: "결석했을 때만"). 결석이면 숙제알림은 억제('해왔을 때'가 아님).
//   audience:'parent' — 보고성 알림이라 학부모만. 학생 본인은 푸시·알림함 모두 안 받음(관우T 확정).
//   best-effort — 알림/푸시 실패가 출결 저장을 절대 막지 않는다(호출부에서 waitUntil로 분리).
async function notifyOnAttendance(env, st, date, updates, opts = {}) {
  const events = [];
  // 결석 학부모 알림은 원장이 "예"를 눌렀을 때만(admin.html이 notifyParent 전달).
  //   기본(플래그 없음)=발송 → 기존 동작·다른 호출부 보존. notifyParent===false일 때만 결석 알림 생략.
  if (updates.status === '결석' && opts.notifyParent !== false) {
    events.push({
      type: 'absence',
      title: '🔴 결석 안내',
      body: st.name + ' 학생이 ' + date + ' 결석했습니다.',
      dedupKey: 'absence:' + st.id + ':' + date,
      audience: 'parent',
    });
  }
  if (updates.status !== '결석' && updates.homework !== undefined && updates.homework <= 25) {
    events.push({
      type: 'homework_low',
      title: '📝 숙제 미흡 안내',
      body: st.name + ' 학생이 ' + date + ' 숙제를 ' + updates.homework + '% 해왔습니다. (25% 이하)',
      dedupKey: 'homework_low:' + st.id + ':' + date,
      audience: 'parent',
    });
  }
  if (!events.length) return;

  const fresh = [];
  for (const ev of events) {
    try {
      const res = await createNotification(env, {
        studentId: st.id, type: ev.type, title: ev.title, body: ev.body, url: '/portal', dedupKey: ev.dedupKey, audience: ev.audience,
      });
      if (res && res.ok && res.created) fresh.push(ev);   // 같은 날 재저장 → created:false면 푸시 생략(중복 방지)
    } catch (_) { /* best-effort */ }
  }
  if (!fresh.length) return;

  const phones = [st.parentPhone]   // 결석·숙제 알림은 학부모 전용 — 학생폰 푸시 제외
    .map(p => String(p || '').replace(/\D/g, '')).filter(Boolean);
  if (!phones.length) return;
  const payload = fresh.length === 1
    ? { title: fresh[0].title, body: fresh[0].body, url: '/portal', tag: 'kwmath-att-' + fresh[0].type }
    : { title: '📌 출결 알림', body: fresh.map(e => e.body).join('\n'), url: '/portal', tag: 'kwmath-att' };
  try { await sendPushToUsers(env, phones, payload, { nightSilent: true }); } catch (_) { /* best-effort */ }
  // ↑ 전원 학부모 → 밤(KST 23~7)엔 발송 건너뜀
}

export async function onRequest(context) {
  const { request, env } = context;
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  const url = new URL(request.url);

  // ── GET ──
  if (request.method === 'GET') {
    // 조교 학원 스코프 (원장이면 null). isAdmin일 때만 의미 있음(학생/학부모는 자기 것만).
    const allowedNames = isAdmin ? await staffNameScope(env, request) : null;

    // admin/조교 전체 (조교는 자기 학원만 필터)
    if (isAdmin && url.searchParams.get('all') === '1') {
      try {
        let out = await listAllAttendance(env);
        if (allowedNames) out = out.filter(e => allowedNames.has(e.name));
        return Response.json(out);
      } catch (e) {
        return safeError(e, env, { message: '출결 기록을 불러오지 못했습니다.' });
      }
    }

    // 특정 학생 (admin: ?name / 학생·학부모: 본인·자녀)
    let targetName = (url.searchParams.get('name') || '').trim();
    let studentId = null;
    try {
      if (!isAdmin) {
        const access = await requireStudentAccess(env, request);
        if (!access.ok) return access.response;
        targetName = access.student.name;
        const list = await getStudentsByPhone(env, access.phone);
        const me = list.find(s => s.name === targetName) || (list.length === 1 ? list[0] : null);
        studentId = me ? me.id : null;
      } else {
        if (!targetName) return Response.json({ error: 'name 필수' }, { status: 400 });
        // 조교가 자기 학원 밖 학생을 조회하면 빈 기록 반환(존재 여부도 숨김)
        if (allowedNames && !allowedNames.has(targetName)) {
          return Response.json({ name: targetName, records: {}, updatedAt: null });
        }
        const st = await getStudentByName(env, targetName);
        studentId = st ? st.id : null;
      }
    } catch (e) {
      return safeError(e, env, { message: '출결 기록을 불러오지 못했습니다.' });
    }
    if (!targetName) return Response.json({ error: 'name 필수' }, { status: 400 });
    if (!studentId) return Response.json({ name: targetName, records: {}, updatedAt: null });

    const month = (url.searchParams.get('month') || '').trim();
    try {
      const got = await getAttendance(env, studentId, month || undefined);
      return Response.json({ name: targetName, records: got.records, updatedAt: got.updatedAt });
    } catch (e) {
      return safeError(e, env, { message: '출결 기록을 불러오지 못했습니다.' });
    }
  }

  // ── POST: 부분 업데이트 (admin only) ──
  if (request.method === 'POST') {
    if (!isAdmin) return Response.json({ error: 'admin 인증 필요' }, { status: 401 });

    let body = {};
    try { body = await request.json(); } catch {}
    const name = (body.name || '').trim();
    const date = (body.date || '').trim();
    if (!name) return Response.json({ error: 'name 필수' }, { status: 400 });
    if (!date) return Response.json({ error: 'date(YYYY-MM-DD) 필수' }, { status: 400 });

    // 조교는 자기 학원 학생만 입력 가능 (원장이면 allowedNames=null → 통과)
    const allowedNames = await staffNameScope(env, request);
    if (allowedNames && !allowedNames.has(name))
      return Response.json({ error: '담당 학원 학생만 출결을 입력할 수 있어요.' }, { status: 403 });

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

    try {
      const st = await getStudentByName(env, name);
      if (!st) return Response.json({ error: '학생을 D1에서 찾을 수 없습니다. (신규 등록 학생이면 마이그레이션 재실행 필요)' }, { status: 404 });
      const r = await upsertAttendance(env, st.id, date, updates);
      if (!r.ok) return safeError(r.error || 'upsertAttendance failed', env, { message: '출결 저장에 실패했습니다.' });
      // 자동 알림(결석·숙제25%↓) — best-effort, 출결 저장 흐름과 분리(waitUntil).
      //   notifyParent=false(원장이 결석 확인창에서 "아니오")면 결석 학부모 알림 생략 — 기록 저장은 그대로.
      const _np = notifyOnAttendance(env, st, date, updates, { notifyParent: body.notifyParent !== false });
      if (context && typeof context.waitUntil === 'function') context.waitUntil(_np);
      else if (_np && typeof _np.catch === 'function') _np.catch(() => {});
      return Response.json({ ok: true, name, date, record: r.record });
    } catch (e) {
      return safeError(e, env, { message: '출결 저장에 실패했습니다.' });
    }
  }

  // ── DELETE: 특정 날짜 삭제 (admin only) ──
  if (request.method === 'DELETE') {
    if (!isAdmin) return Response.json({ error: 'admin 인증 필요' }, { status: 401 });
    let body = {};
    try { body = await request.json(); } catch {}
    const name = (body.name || '').trim();
    const date = (body.date || '').trim();
    if (!name || !date) return Response.json({ error: 'name + date 필수' }, { status: 400 });

    // 조교는 자기 학원 학생만 삭제 가능 (원장이면 allowedNames=null → 통과)
    const allowedNames = await staffNameScope(env, request);
    if (allowedNames && !allowedNames.has(name))
      return Response.json({ error: '담당 학원 학생만 출결을 수정할 수 있어요.' }, { status: 403 });

    try {
      const st = await getStudentByName(env, name);
      if (!st) return Response.json({ ok: true, removed: 0 });
      const r = await deleteAttendance(env, st.id, date);
      return Response.json({ ok: true, removed: r.removed || 0 });
    } catch (e) {
      return safeError(e, env, { message: '출결 삭제에 실패했습니다.' });
    }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
