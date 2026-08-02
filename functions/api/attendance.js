// /api/attendance
// 출석 + 숙제 완료율 — Cloudflare D1 attendance 테이블 (Phase 4 전환, 이전엔 R2 attendance/{name}.json)
// 학생 명단/인증은 _auth(현재 Notion). 이름 → D1 student_id 변환 후 D1 attendance 사용.
//
// GET ?id=24 [&month=YYYY-MM]        — 특정 학생 기록 (권장 · admin/조교)
// GET ?name=홍길동 [&month=YYYY-MM]  — 구버전 호환 (동명이인이면 먼저 등록된 1명)
// GET ?all=1                         — 모든 학생 (admin only)
// POST { id | name, date, status?, homework?, homework_note?, note? } — 부분 업데이트 (admin only)
// DELETE { id | name, date }         — 그날 기록 삭제 (admin only)
//
// 🆔 2026-07-29 — 쓰기 경로에 id 수용. 이름만으로 저장하면 동명이인 시 남의 기록에 들어간다.
//    프론트(staff-students.html·admin.html)는 id를 보내고, name은 구버전 호환으로만 남긴다.
//
// status: '출석' / '지각' / '결석' / '병결' / '공결'   homework: 0~100

import { requireStudentAccess, normalizePhone } from './_auth.js';
import { getStudentsByPhone, resolveStudentDetailed, getAttendance, upsertAttendance, deleteAttendance, listAllAttendance, listStudents } from './_db.js';

// 👥 2026-07-31 — 이름으로 학생을 잡을 때 같은 이름이 2명 이상이면 아무도 고르지 않고 409로 되돌린다.
//   예전엔 resolveStudent 가 먼저 등록된 1명을 조용히 집어서, 엉뚱한 학생의 출결이 바뀌고도
//   화면엔 "저장됨"으로 보였다. 되돌리려면 로그를 뒤져야 하는데 로그도 정상으로 보인다 — 그래서 막는다.
function 동명이인409(r) {
  return Response.json({
    error: '같은 이름 학생이 ' + r.동명이인수 + '명이라 누구인지 확정할 수 없어요. 학생 목록에서 학생을 골라 주세요.',
    동명이인수: r.동명이인수, 후보목록: r.후보목록,
  }, { status: 409 });
}
import { staffScopeAcademy } from './_staff.js';
import { safeError } from './_errors.js';
import { createNotification } from './_notifications.js';
import { sendPushToUsers } from './_push.js';
import { logAudit, diffFields } from './_auditlog.js';

const VALID_STATUS = ['출석', '지각', '결석', '병결', '공결'];

// 조교(X-Staff-Phone)면 "맡은 학원" 학생의 id·이름 Set, 원장이면 null(제한 없음).
//   미배정 조교는 빈 Set → 아무 출결도 못 봄. POST/DELETE는 미들웨어가 이미 403으로 막음.
//   🆔 권한 판정은 ids로 한다(동명이인 안전). names는 listAllAttendance 구형 응답 대비용.
async function staffScope(env, request) {
  const academy = await staffScopeAcademy(env, request);
  if (academy === null) return null;                               // 원장 → 전체
  const roster = academy ? (await listStudents(env)).filter(s => (s.academy || '') === academy) : [];
  return { ids: new Set(roster.map(s => String(s.id))), names: new Set(roster.map(s => s.name)) };
}

// 출결 저장 후 자동 알림: 결석·지각·병결 또는 숙제 25%↓ → 알림함 적립 + 학부모 푸시(학생 제외).
//   지각·병결도 발송(2026-07-16 관우T 확정: "지각 병결 학부모한테 보내 — 나한테 물어보고 보내는 걸로"
//   → 결석과 동일하게 원장 확인창(notifyParent) 경유). 공결은 공식 인정이라 제외.
//   결석이면 숙제알림은 억제('해왔을 때'가 아님).
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
  if (updates.status === '지각' && opts.notifyParent !== false) {
    events.push({
      type: 'late',
      title: '🟡 지각 안내',
      body: st.name + ' 학생이 ' + date + ' 지각했습니다.',
      dedupKey: 'late:' + st.id + ':' + date,
      audience: 'parent',
    });
  }
  if (updates.status === '병결' && opts.notifyParent !== false) {
    events.push({
      type: 'sick',
      title: '🩺 병결 안내',
      body: st.name + ' 학생이 ' + date + ' 병결 처리되었습니다.',
      dedupKey: 'sick:' + st.id + ':' + date,
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
    // ⚠️ 하이픈형(010-1234-5678)으로 정규화 — 포털 푸시 구독키와 일치해야 토큰 조회됨(notifications.js와 동일).
    .map(p => normalizePhone(p)).filter(Boolean);
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
    const scope = isAdmin ? await staffScope(env, request) : null;

    // admin/조교 전체 (조교는 자기 학원만 필터)
    if (isAdmin && url.searchParams.get('all') === '1') {
      try {
        let out = await listAllAttendance(env);
        if (scope) out = out.filter(e => (e.id != null ? scope.ids.has(String(e.id)) : scope.names.has(e.name)));
        return Response.json(out);
      } catch (e) {
        return safeError(e, env, { message: '출결 기록을 불러오지 못했습니다.' });
      }
    }

    // 특정 학생 (admin/조교: ?id 권장 · ?name 구버전 / 학생·학부모: 본인·자녀)
    const queryId = (url.searchParams.get('id') || '').trim();
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
        if (!queryId && !targetName) return Response.json({ error: 'id 또는 name 필수' }, { status: 400 });
        const rs = await resolveStudentDetailed(env, queryId, targetName);
        // 동명이인이면 빈 달력을 보여 주면 안 된다("결석이 하나도 없네"로 잘못 읽힌다) — 이유를 말한다.
        if (!rs.ok && rs.reason === 'ambiguous') return 동명이인409(rs);
        const st = rs.ok ? rs.student : null;
        // 조교가 자기 학원 밖 학생을 조회하면 빈 기록 반환(존재 여부도 숨김)
        if (scope && (!st || !scope.ids.has(String(st.id)))) {
          return Response.json({ name: targetName, records: {}, updatedAt: null });
        }
        studentId = st ? st.id : null;
        if (st) targetName = st.name;
      }
    } catch (e) {
      return safeError(e, env, { message: '출결 기록을 불러오지 못했습니다.' });
    }
    if (!studentId) return Response.json({ name: targetName, records: {}, updatedAt: null });

    const month = (url.searchParams.get('month') || '').trim();
    try {
      const got = await getAttendance(env, studentId, month || undefined);
      return Response.json({ id: studentId, name: targetName, records: got.records, updatedAt: got.updatedAt });
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
    if (body.id === undefined && !name) return Response.json({ error: 'id 또는 name 필수' }, { status: 400 });
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

    try {
      const rs = await resolveStudentDetailed(env, body.id, name);
      if (!rs.ok && rs.reason === 'ambiguous') return 동명이인409(rs);
      const st = rs.ok ? rs.student : null;
      if (!st) return Response.json({ error: '학생을 D1에서 찾을 수 없습니다. (신규 등록 학생이면 마이그레이션 재실행 필요)' }, { status: 404 });
      // 조교는 자기 학원 학생만 입력 가능 (원장이면 scope=null → 통과) — 🆔 id로 판정
      const scope = await staffScope(env, request);
      if (scope && !scope.ids.has(String(st.id)))
        return Response.json({ error: '담당 학원 학생만 출결을 입력할 수 있어요.' }, { status: 403 });
      const r = await upsertAttendance(env, st.id, date, updates);
      if (!r.ok) return safeError(r.error || 'upsertAttendance failed', env, { message: '출결 저장에 실패했습니다.' });

      // 📓 2026-07-31 — 출결은 조교 여럿이 같은 학생을 만지는 대표적인 칸이다.
      //   "결석이었는데 왜 출석으로 바뀌었지"에 답하려면 누가·언제·무엇을 무엇으로 바꿨는지가 필요하다.
      //   actor_name 은 미들웨어가 실은 조교 실명으로 자동으로 채워진다.
      const d = diffFields(r.before, r.record, ['status', 'homework', 'homework_note', 'note', 'method']);
      await logAudit(env, request, {
        action: r.created ? 'attendance.create' : 'attendance.update',
        target: String(st.id), targetName: st.name || '',
        summary: '출결 ' + (r.created ? '입력' : '수정') + ' [' + (st.name || st.id) + ' · ' + date + '] — '
          + (d.요약 || '값 동일'),
        detail: {
          학생id: String(st.id), 이름: st.name || '', 학원: st.academy || '', 날짜: date,
          새로생성: !!r.created,
          바뀐칸: d.바뀐칸, 변경: d.변경,
          이전값: r.before || '(기록 없음)',
          보낸값: updates,
          학부모알림: body.notifyParent === false ? '끔(원장이 "아니오" 선택)' : '자동 판정(결석·숙제 25%↓면 발송)',
          지목방식: body.id !== undefined ? 'id(동명이인 안전)' : 'name 폴백',
        },
      });
      // 자동 알림(결석·숙제25%↓) — best-effort, 출결 저장 흐름과 분리(waitUntil).
      //   notifyParent=false(원장이 결석 확인창에서 "아니오")면 결석 학부모 알림 생략 — 기록 저장은 그대로.
      const _np = notifyOnAttendance(env, st, date, updates, { notifyParent: body.notifyParent !== false });
      if (context && typeof context.waitUntil === 'function') context.waitUntil(_np);
      else if (_np && typeof _np.catch === 'function') _np.catch(() => {});
      return Response.json({ ok: true, id: st.id, name: st.name, date, record: r.record });
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
    if ((body.id === undefined && !name) || !date) return Response.json({ error: '(id 또는 name) + date 필수' }, { status: 400 });

    try {
      const rs = await resolveStudentDetailed(env, body.id, name);
      if (!rs.ok && rs.reason === 'ambiguous') return 동명이인409(rs);   // 지우기 전에 멈춘다 — 삭제는 되돌릴 수 없다
      const st = rs.ok ? rs.student : null;
      if (!st) return Response.json({ ok: true, removed: 0 });
      // 조교는 자기 학원 학생만 삭제 가능 (원장이면 scope=null → 통과) — 🆔 id로 판정
      const scope = await staffScope(env, request);
      if (scope && !scope.ids.has(String(st.id)))
        return Response.json({ error: '담당 학원 학생만 출결을 수정할 수 있어요.' }, { status: 403 });
      const r = await deleteAttendance(env, st.id, date);

      // 🔴 출결 삭제는 "그날 결석이 없던 일"이 되는 일이다. 무엇을 지웠는지 반드시 남긴다.
      await logAudit(env, request, {
        action: 'attendance.delete',
        target: String(st.id), targetName: st.name || '',
        summary: '출결 삭제 [' + (st.name || st.id) + ' · ' + date + ']'
          + (r.before ? ' — ' + (r.before.status || '기록') + ' 이 없던 일이 됨' : ' — 원래 기록 없음') + ' (복구 불가)',
        detail: {
          학생id: String(st.id), 이름: st.name || '', 학원: st.academy || '', 날짜: date,
          지워진기록: r.before || '(기록 없음)',
          삭제건수: r.removed || 0,
          비고: '이미 나간 결석 알림·푸시는 되돌아가지 않음',
        },
      });
      return Response.json({ ok: true, removed: r.removed || 0 });
    } catch (e) {
      return safeError(e, env, { message: '출결 삭제에 실패했습니다.' });
    }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
