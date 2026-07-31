// /api/clinic
// 클리닉 출석 + 성취도 + 시간 — Cloudflare D1 clinic 테이블 (수업 출결 attendance와 완전 별도).
// 학생 명단/인증은 _auth(현재 Notion). 이름 → D1 student_id 변환 후 D1 clinic 사용.
// 구조는 /api/attendance를 그대로 미러링하되, 클리닉 전용 필드(achieve·minutes)를 더했다.
//
// GET ?id=24 [&month=YYYY-MM]        — 특정 학생 기록 (권장 · admin/조교)
// GET ?name=홍길동 [&month=YYYY-MM]  — 구버전 호환 (동명이인이면 먼저 등록된 1명)
// GET ?all=1                         — 모든 학생 (admin only, 조교는 자기 학원만)
// POST { id | name, date, status?, achieve?, minutes?, note? } — 부분 업데이트 (admin·조교)
// DELETE { id | name, date }         — 그날 기록 삭제 (admin·조교)
//
// 🆔 2026-07-29 — 쓰기 경로에 id 수용(attendance.js와 동일 규약). 이름만으로 저장하면 동명이인 시 남의 기록에 들어간다.
//
// status: '출석' / '지각' / '결석' / '병결' / '공결'
// achieve(성취도): 0 / 25 / 50 / 75 / 100   minutes(클리닉 시간, 분): 0~780 (시 0~12·분 0~60)

import { requireStudentAccess } from './_auth.js';
import { getStudentsByPhone, resolveStudent, getClinic, upsertClinic, deleteClinic, listAllClinic, listStudents } from './_db.js';
import { staffScopeAcademy } from './_staff.js';
import { safeError } from './_errors.js';
import { logAudit, diffFields } from './_auditlog.js';

const VALID_STATUS = ['출석', '지각', '결석', '병결', '공결'];
const VALID_ACHIEVE = [0, 25, 50, 75, 100];
const MAX_MINUTES = 12 * 60 + 60;   // 시 12 + 분 60 = 780

// 로그에 담을 때만 긴 메모를 자른다(저장되는 원본은 건드리지 않는다).
//   detail은 JSON 2만자에서 잘리는데, 잘리면 JSON 자체가 깨져 로그 1건을 통째로 못 읽게 된다.
//   ⚠️ 반드시 사본을 만든다 — 원본 객체를 그 자리에서 고치면 전/후가 똑같이 찍혀 로그가 무의미해진다.
function clipRec(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const o = Object.assign({}, rec);
  if (typeof o.note === 'string' && o.note.length > 3000) o.note = o.note.slice(0, 3000) + '…(잘림)';
  return o;
}

// 조교(X-Staff-Phone)면 "맡은 학원" 학생의 id·이름 Set, 원장이면 null(제한 없음).
//   미배정 조교는 빈 Set → 아무 기록도 못 봄. POST/DELETE는 미들웨어가 이미 403으로 막음.
//   🆔 권한 판정은 ids로 한다(동명이인 안전). names는 listAllClinic 구형 응답 대비용.
async function staffScope(env, request) {
  const academy = await staffScopeAcademy(env, request);
  if (academy === null) return null;                               // 원장 → 전체
  const roster = academy ? (await listStudents(env)).filter(s => (s.academy || '') === academy) : [];
  return { ids: new Set(roster.map(s => String(s.id))), names: new Set(roster.map(s => s.name)) };
}

export async function onRequest({ request, env }) {
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
        let out = await listAllClinic(env);
        if (scope) out = out.filter(e => (e.id != null ? scope.ids.has(String(e.id)) : scope.names.has(e.name)));
        return Response.json(out);
      } catch (e) {
        return safeError(e, env, { message: '클리닉 기록을 불러오지 못했습니다.' });
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
        const st = await resolveStudent(env, queryId, targetName);
        // 조교가 자기 학원 밖 학생을 조회하면 빈 기록 반환(존재 여부도 숨김)
        if (scope && (!st || !scope.ids.has(String(st.id)))) {
          return Response.json({ name: targetName, records: {}, updatedAt: null });
        }
        studentId = st ? st.id : null;
        if (st) targetName = st.name;
      }
    } catch (e) {
      return safeError(e, env, { message: '클리닉 기록을 불러오지 못했습니다.' });
    }
    if (!studentId) return Response.json({ name: targetName, records: {}, updatedAt: null });

    const month = (url.searchParams.get('month') || '').trim();
    try {
      const got = await getClinic(env, studentId, month || undefined);
      return Response.json({ id: studentId, name: targetName, records: got.records, updatedAt: got.updatedAt });
    } catch (e) {
      return safeError(e, env, { message: '클리닉 기록을 불러오지 못했습니다.' });
    }
  }

  // ── POST: 부분 업데이트 (admin·조교) ──
  if (request.method === 'POST') {
    if (!isAdmin) {
      // 🔒 인증 없는 쓰기 시도 — 앱 세션이 끊긴 건지 외부에서 두드린 건지는 흔적이 있어야 구분된다.
      await logAudit(env, request, {
        action: 'clinic.save.denied',
        summary: '클리닉 저장 거부(401) — 원장/조교 인증 없음',
        detail: { 결과: '아무것도 저장되지 않음', 비고: '토큰·비밀번호 원문은 로그에 담지 않는다' },
      });
      return Response.json({ error: 'admin 인증 필요' }, { status: 401 });
    }

    let body = {};
    try { body = await request.json(); } catch {}
    const name = (body.name || '').trim();
    const date = (body.date || '').trim();

    // 반려(400)도 남긴다 — "입력했는데 저장이 안 됐다"가 값 검증 실패인지 앱이 안 보낸 건지
    //   나중에 구분할 방법이 이 로그밖에 없다. 응답은 예전과 완전히 동일하다.
    const rejectPost = async (msg) => {
      await logAudit(env, request, {
        action: 'clinic.save.reject',
        target: body.id !== undefined ? String(body.id) : (name || ''),
        targetName: name || '',
        summary: '클리닉 저장 반려(400) — ' + msg,
        detail: {
          사유: msg,
          받은학생id: body.id !== undefined ? String(body.id) : '(없음)',
          받은이름: name || '(없음)',
          받은날짜: date || '(없음)',
          받은값: {
            상태: body.status === undefined ? '(안 보냄)' : String(body.status).slice(0, 60),
            성취도: body.achieve === undefined ? '(안 보냄)' : String(body.achieve).slice(0, 60),
            시간분: body.minutes === undefined ? '(안 보냄)' : String(body.minutes).slice(0, 60),
            메모길이: typeof body.note === 'string' ? body.note.length : '(안 보냄)',
          },
          결과: '아무것도 저장되지 않음',
        },
      });
      return Response.json({ error: msg }, { status: 400 });
    };

    if (body.id === undefined && !name) return await rejectPost('id 또는 name 필수');
    if (!date) return await rejectPost('date(YYYY-MM-DD) 필수');

    const updates = {};
    if (typeof body.status === 'string' && body.status) {
      if (!VALID_STATUS.includes(body.status))
        return await rejectPost('status는 ' + VALID_STATUS.join('/') + ' 중 하나');
      updates.status = body.status;
    }
    if (body.achieve !== undefined && body.achieve !== null && body.achieve !== '') {
      const a = Number(body.achieve);
      if (!VALID_ACHIEVE.includes(a))
        return await rejectPost('achieve(성취도)는 ' + VALID_ACHIEVE.join('/') + ' 중 하나');
      updates.achieve = a;
    }
    if (body.minutes !== undefined && body.minutes !== null && body.minutes !== '') {
      const m = Number(body.minutes);
      if (!Number.isFinite(m) || m < 0 || m > MAX_MINUTES || Math.round(m) !== m)
        return await rejectPost('minutes(시간)는 0~' + MAX_MINUTES + '분 사이 정수');
      updates.minutes = m;
    }
    if (typeof body.note === 'string') updates.note = body.note;

    if (!Object.keys(updates).length)
      return await rejectPost('업데이트할 필드 없음(status/achieve/minutes/note)');

    try {
      const st = await resolveStudent(env, body.id, name);
      if (!st) {
        // 학생을 못 찾은 것도 사건이다 — 퇴원 처리된 학생을 조교가 계속 입력하고 있는 상황이 여기서 드러난다.
        await logAudit(env, request, {
          action: 'clinic.save.miss',
          target: body.id !== undefined ? String(body.id) : (name || ''),
          targetName: name || '',
          summary: '클리닉 저장 실패(404) — 학생을 찾을 수 없음 [' + (name || body.id) + ' · ' + date + ']',
          detail: {
            받은학생id: body.id !== undefined ? String(body.id) : '(없음)',
            받은이름: name || '(없음)', 날짜: date,
            지목방식: body.id !== undefined ? 'id(동명이인 안전)' : 'name 폴백(동명이인이면 먼저 등록된 학생이 잡힘)',
            추정원인: '퇴원·삭제된 학생이거나 화면이 옛 id를 들고 있음',
            결과: '아무것도 저장되지 않음',
          },
        });
        return Response.json({ error: '학생을 D1에서 찾을 수 없습니다.' }, { status: 404 });
      }
      // 조교는 자기 학원 학생만 입력 가능 (원장이면 scope=null → 통과) — 🆔 id로 판정
      const scope = await staffScope(env, request);
      if (scope && !scope.ids.has(String(st.id))) {
        // 🔴 원장이 가장 보고 싶어 하는 기록 — 어느 조교가 담당 학원 밖 학생을 건드리려 했는가.
        //    actor(조교 번호)·actor_name(조교 이름)은 logAudit이 미들웨어 헤더에서 자동으로 채운다.
        await logAudit(env, request, {
          action: 'clinic.save.denied',
          target: String(st.id), targetName: st.name || '',
          summary: '클리닉 저장 거부(403) — 담당 학원 밖 학생 [' + (st.name || st.id) + ' · '
            + (st.academy || '학원 미배정') + ' · ' + date + ']',
          detail: {
            학생id: String(st.id), 이름: st.name || '',
            학생의학원: st.academy || '(미배정)', 반: st.className || st.class_name || '', 날짜: date,
            담당학원학생수: scope.ids.size,
            시도한값: {
              상태: updates.status === undefined ? '(안 보냄)' : updates.status,
              성취도: updates.achieve === undefined ? '(안 보냄)' : updates.achieve,
              시간분: updates.minutes === undefined ? '(안 보냄)' : updates.minutes,
              메모길이: typeof updates.note === 'string' ? updates.note.length : '(안 보냄)',
            },
            결과: '거부됨 — 아무것도 저장되지 않음',
            비고: '미배정 조교(담당 학원 없음)면 모든 학생이 여기서 걸린다',
          },
        });
        return Response.json({ error: '담당 학원 학생만 클리닉을 입력할 수 있어요.' }, { status: 403 });
      }
      const r = await upsertClinic(env, st.id, date, updates);
      if (!r.ok) {
        await logAudit(env, request, {
          action: 'clinic.save.fail',
          target: String(st.id), targetName: st.name || '',
          summary: '클리닉 저장 실패(DB 오류) [' + (st.name || st.id) + ' · ' + date + ']',
          detail: {
            학생id: String(st.id), 이름: st.name || '', 학원: st.academy || '', 날짜: date,
            시도한값: clipRec(updates),
            DB오류: String(r.error || '알 수 없는 오류').slice(0, 300),
            결과: '저장 안 됨 — 클리닉 기록은 예전 값 그대로',
          },
        });
        return safeError(r.error || 'upsertClinic failed', env, { message: '클리닉 저장에 실패했습니다.' });
      }

      // 📓 2026-07-31 — 클리닉은 조교가 매일 만지는 화면인데 지금까지 아무 기록도 안 남았다.
      //   "성취도가 왜 25로 바뀌었지 / 시간이 왜 0분이지"에 답하려면
      //   누가·언제·무엇을 무엇으로 바꿨는지가 필요하다. actor_name은 조교 실명으로 자동으로 찍힌다.
      const d = diffFields(r.before, r.record, ['status', 'achieve', 'minutes', 'note']);
      await logAudit(env, request, {
        action: r.created ? 'clinic.create' : 'clinic.update',
        target: String(st.id), targetName: st.name || '',
        summary: '클리닉 ' + (r.created ? '입력' : '수정') + ' [' + (st.name || st.id) + ' · ' + date + '] — '
          + (d.요약 || '값 동일'),
        detail: {
          학생id: String(st.id), 이름: st.name || '', 학원: st.academy || '',
          반: st.className || st.class_name || '', 날짜: date,
          새로생성: !!r.created,
          바뀐칸: d.바뀐칸, 변경: d.변경,
          이전값: r.before ? clipRec(r.before) : '(기록 없음)',
          보낸값: clipRec(updates),
          효과: '이 값은 학생·학부모 포털의 클리닉 기록과 리포트 통계에 그대로 반영된다. '
            + '수업 출결(attendance)과는 별개 표라 서로 영향을 주지 않는다.',
          지목방식: body.id !== undefined ? 'id(동명이인 안전)' : 'name 폴백(동명이인이면 먼저 등록된 학생이 잡힘)',
          비고: '메모가 3000자를 넘으면 로그에서만 잘린다(저장된 원본은 온전함)',
        },
      });
      return Response.json({ ok: true, id: st.id, name: st.name, date, record: r.record });
    } catch (e) {
      return safeError(e, env, { message: '클리닉 저장에 실패했습니다.' });
    }
  }

  // ── DELETE: 특정 날짜 삭제 (admin·조교) ──
  if (request.method === 'DELETE') {
    if (!isAdmin) {
      await logAudit(env, request, {
        action: 'clinic.delete.denied',
        summary: '클리닉 삭제 거부(401) — 원장/조교 인증 없음',
        detail: { 결과: '아무것도 삭제되지 않음', 비고: '토큰·비밀번호 원문은 로그에 담지 않는다' },
      });
      return Response.json({ error: 'admin 인증 필요' }, { status: 401 });
    }
    let body = {};
    try { body = await request.json(); } catch {}
    const name = (body.name || '').trim();
    const date = (body.date || '').trim();
    if ((body.id === undefined && !name) || !date) {
      await logAudit(env, request, {
        action: 'clinic.delete.reject',
        target: body.id !== undefined ? String(body.id) : (name || ''),
        targetName: name || '',
        summary: '클리닉 삭제 반려(400) — (id 또는 name) + date 필수',
        detail: {
          받은학생id: body.id !== undefined ? String(body.id) : '(없음)',
          받은이름: name || '(없음)', 받은날짜: date || '(없음)',
          결과: '아무것도 삭제되지 않음',
        },
      });
      return Response.json({ error: '(id 또는 name) + date 필수' }, { status: 400 });
    }

    try {
      const st = await resolveStudent(env, body.id, name);
      if (!st) {
        // 학생이 없으면 조용히 ok:true가 나간다 — 화면상 "지워졌다"로 보이므로 흔적을 남겨야 오해를 푼다.
        await logAudit(env, request, {
          action: 'clinic.delete.noop',
          target: body.id !== undefined ? String(body.id) : (name || ''),
          targetName: name || '',
          summary: '클리닉 삭제 요청이 왔지만 학생을 찾을 수 없음 [' + (name || body.id) + ' · ' + date + ']',
          detail: {
            받은학생id: body.id !== undefined ? String(body.id) : '(없음)',
            받은이름: name || '(없음)', 날짜: date,
            지목방식: body.id !== undefined ? 'id(동명이인 안전)' : 'name 폴백(동명이인이면 먼저 등록된 학생이 잡힘)',
            결과: '아무것도 삭제 안 됨. 다만 화면에는 성공(ok:true, removed:0)으로 응답함',
          },
        });
        return Response.json({ ok: true, removed: 0 });
      }
      // 조교는 자기 학원 학생만 삭제 가능 (원장이면 scope=null → 통과) — 🆔 id로 판정
      const scope = await staffScope(env, request);
      if (scope && !scope.ids.has(String(st.id))) {
        await logAudit(env, request, {
          action: 'clinic.delete.denied',
          target: String(st.id), targetName: st.name || '',
          summary: '클리닉 삭제 거부(403) — 담당 학원 밖 학생 [' + (st.name || st.id) + ' · '
            + (st.academy || '학원 미배정') + ' · ' + date + ']',
          detail: {
            학생id: String(st.id), 이름: st.name || '',
            학생의학원: st.academy || '(미배정)', 반: st.className || st.class_name || '', 날짜: date,
            담당학원학생수: scope.ids.size,
            결과: '거부됨 — 아무것도 삭제되지 않음',
            비고: '미배정 조교(담당 학원 없음)면 모든 학생이 여기서 걸린다',
          },
        });
        return Response.json({ error: '담당 학원 학생만 클리닉을 수정할 수 있어요.' }, { status: 403 });
      }
      const r = await deleteClinic(env, st.id, date);

      // 🔴 삭제는 "그날 클리닉이 없던 일"이 되는 일이다 — 지운 값을 통째로 남겨야 되돌릴 수 있다.
      await logAudit(env, request, {
        action: 'clinic.delete',
        target: String(st.id), targetName: st.name || '',
        summary: '클리닉 삭제 [' + (st.name || st.id) + ' · ' + date + ']'
          + (r.before ? ' — ' + (r.before.status || '기록') + ' 이 없던 일이 됨' : ' — 원래 기록 없음') + ' (복구 불가)',
        detail: {
          학생id: String(st.id), 이름: st.name || '', 학원: st.academy || '',
          반: st.className || st.class_name || '', 날짜: date,
          지워진기록: r.before ? clipRec(r.before) : '(기록 없음)',
          삭제건수: r.removed || 0,
          결과: r.ok ? 'ok' : String(r.error || '삭제 실패').slice(0, 300),
          효과: '학생·학부모 포털의 그날 클리닉 칸이 빈칸이 되고, 클리닉 통계·리포트에서도 빠진다',
          지목방식: body.id !== undefined ? 'id(동명이인 안전)' : 'name 폴백(동명이인이면 먼저 등록된 학생이 잡힘)',
        },
      });
      return Response.json({ ok: true, removed: r.removed || 0 });
    } catch (e) {
      return safeError(e, env, { message: '클리닉 삭제에 실패했습니다.' });
    }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
