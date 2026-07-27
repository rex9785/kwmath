// /api/clinic-review — 클리닉 총평(조교 코멘트 → 원장 검토 → 학부모 푸시)
// ───────────────────────────────────────────────────────────
// 흐름: 클리닉이 끝나면 조교가 학생별로 "물어본 것·태도·개선방향·틀린개수·난이도·한줄총평"을
//   draft로 저장 → 원장이 한 화면에서 검토(문구 개별 수정 가능) → 발송 버튼 → 각 학부모 폰에 푸시.
//   발송된 총평은 status='sent'로 잠기고 본문 스냅샷(sent_body)이 남아 me.html 아카이브에 노출.
//
// 인증(_middleware가 조교 토큰 → Bearer ADMIN_PASSWORD + X-Staff-Phone로 번역):
//   isAdmin=true 는 원장·조교 공통. 원장/조교 구분은 staffScopeAcademy(null=원장).
//   학생·학부모(토큰)는 발송 완료된 자녀 총평 아카이브만 GET.
//
//  GET  ?date=YYYY-MM-DD           (admin) → 그 날짜 총평 목록 + 클리닉 참석자 + 하루메모
//  GET  (토큰, date 없음)           (학부모)  → 자녀에게 발송 완료된 총평 아카이브(최신순)
//  POST { action:'save', id, date, asked?, attitude?, improvement?, wrong_count?, difficulty?, summary? }
//         (admin·조교) → 학생 1명 draft 저장/수정. 조교는 자기 학원 학생만. 발송 완료건은 잠금.
//  POST { action:'saveMemo', date, memo }        (admin·조교) → 하루 전체 메모(원장님만 봄) 저장
//  POST { action:'send', date, items:[{id, body?, title?}] }  (원장 전용) → 학부모 푸시 발송(비가역)
//  DELETE { id, date }             (admin·조교) → draft 삭제. 발송 완료건은 원장만.
//
// difficulty: 'easy'(쉬움)/'normal'(적절)/'hard'(어려움).  student_id로 식별(동명이인 안전).
// ───────────────────────────────────────────────────────────
import { requireStudentAccess, normalizePhone } from './_auth.js';
import {
  getStudentById, listStudents, listClinicByDate,
  getClinicReview, upsertClinicReview, markClinicReviewSent, deleteClinicReview,
  listClinicReviewsByDate, listSentReviewsForStudentIds,
  getClinicDayMemo, setClinicDayMemo,
} from './_db.js';
import { staffScopeAcademy } from './_staff.js';
import { sendPushToUsers } from './_push.js';
import { safeError } from './_errors.js';
import { createNotification } from './_notifications.js';

const VALID_DIFFICULTY = ['easy', 'normal', 'hard'];
const MAX_TEXT = 1000;   // 각 텍스트 칸 최대 길이(과다 입력 방지)
const MAX_WRONG = 200;   // 틀린 개수 상한(방어적)

function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 조교면 "맡은 학원" 학생 id Set, 원장이면 null(제한 없음). 미배정 조교는 빈 Set.
//   ⚠️ 이름이 아니라 id로 스코프 — 동명이인 안전(평생 규칙: student_id 식별).
async function staffIdScope(env, request) {
  const academy = await staffScopeAcademy(env, request);
  if (academy === null) return null;                                // 원장 → 전체
  const roster = academy ? (await listStudents(env)).filter(s => (s.academy || '') === academy) : [];
  // ⚠️ id는 반드시 String으로 — D1 PK는 INTEGER(number)지만 클라이언트/POST는 문자열 id를 보냄.
  //    Set을 문자열로 통일하고 비교값도 String()으로 맞춰야 조교 스코프가 정상 동작한다.
  return new Set(roster.map(s => String(s.id)));
}

// 학부모/학생 GET에서 자녀 스코프(부모로 매칭된 학생 id만). 학생 본인 로그인이면 빈 배열 → 아카이브 미노출.
//   (관우T 결정: 클리닉 총평 노출 대상은 '학부모만'.)
function parentIdsFrom(students) {
  const ids = [];
  for (const s of (students || [])) {
    if (!s || !s.id) continue;
    if (s.role !== 'student') ids.push(s.id);   // 'parent' 또는 그 외 = 부모 뷰
  }
  return ids;
}

function clampText(v) {
  return String(v == null ? '' : v).slice(0, MAX_TEXT);
}

function mmdd(date) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date || '');
  return m ? (m[1] + '/' + m[2]) : (date || '');
}

// 저장된 총평 필드 → 학부모용 본문(원장이 화면에서 수정 안 하면 이 문구가 발송됨).
function composeBody(rev, name) {
  const nm = name || rev.name || '학생';
  const lines = [];
  if (rev.asked) lines.push('· 오늘 다룬 것/질문: ' + rev.asked);
  if (rev.attitude) lines.push('· 수업 태도: ' + rev.attitude);
  if (rev.wrongCount !== null && rev.wrongCount !== undefined && rev.wrongCount !== '')
    lines.push('· 틀린 문제 수: ' + rev.wrongCount + '개');
  if (rev.difficulty === 'easy') lines.push('· 난이도: 오늘 문제는 비교적 수월하게 소화했습니다.');
  else if (rev.difficulty === 'hard') lines.push('· 난이도: 오늘 문제를 다소 어려워했습니다.');
  else if (rev.difficulty === 'normal') lines.push('· 난이도: 적절한 수준으로 학습했습니다.');
  if (rev.improvement) lines.push('· 개선 방향: ' + rev.improvement);
  const blocks = [nm + ' 학생의 오늘 클리닉 학습 내용입니다.'];
  if (rev.summary) blocks.push(rev.summary);           // 자유 총평이 상세보다 먼저
  if (lines.length) blocks.push(lines.join('\n'));     // 상세 항목은 그 아래
  return blocks.join('\n\n');
}

export async function onRequest(context) {
  const { request, env } = context;
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  const url = new URL(request.url);

  try {
    // ── GET ──
    if (request.method === 'GET') {
      // 학부모/학생: 발송 완료된 자녀 총평 아카이브(최신순)
      if (!isAdmin) {
        const access = await requireStudentAccess(env, request);
        if (!access.ok) return access.response;
        const ids = parentIdsFrom(access.students);
        const reviews = await listSentReviewsForStudentIds(env, ids);
        return Response.json({ reviews });
      }

      // 원장·조교: 특정 날짜 검토 화면
      const date = (url.searchParams.get('date') || '').trim() || todayKST();
      const idScope = await staffIdScope(env, request);   // null=원장

      let reviews = await listClinicReviewsByDate(env, date);
      if (idScope) reviews = reviews.filter(r => idScope.has(String(r.studentId)));

      // 그날 클리닉 참석자(총평 추가용 후보). listClinicByDate 행 → {studentId,name,status,achieve,minutes}
      let clinicRows = await listClinicByDate(env, date);
      let clinicStudents = (clinicRows || []).map(r => ({
        studentId: r.student_id, name: r.name || '',
        status: r.status || '', achieve: r.achieve, minutes: r.minutes,
      }));
      if (idScope) clinicStudents = clinicStudents.filter(s => idScope.has(String(s.studentId)));

      const memoObj = await getClinicDayMemo(env, date);
      return Response.json({ date, reviews, clinicStudents, memo: memoObj.memo, isOwner: idScope === null });
    }

    // ── POST ──
    if (request.method === 'POST') {
      if (!isAdmin) return Response.json({ error: 'admin 인증 필요' }, { status: 401 });
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const action = (body.action || '').trim();
      const academy = await staffScopeAcademy(env, request);   // null=원장
      const isOwner = (academy === null);
      const idScope = isOwner ? null
        : new Set((academy ? (await listStudents(env)).filter(s => (s.academy || '') === academy) : []).map(s => String(s.id)));

      // 하루 전체 메모 저장(원장님만 봄) — 조교·원장 모두 작성 가능
      if (action === 'saveMemo') {
        const date = (body.date || '').trim();
        if (!date) return Response.json({ error: 'date(YYYY-MM-DD) 필수' }, { status: 400 });
        const memo = clampText(body.memo);
        const r = await setClinicDayMemo(env, date, memo);
        if (!r.ok) return safeError(r.error || 'setClinicDayMemo failed', env, { message: '메모 저장에 실패했습니다.' });
        return Response.json({ ok: true, date, memo });
      }

      // 학생 1명 draft 저장/수정
      if (action === 'save') {
        const sid = (body.id == null ? '' : String(body.id)).trim();
        const date = (body.date || '').trim();
        if (!sid) return Response.json({ error: 'id(학생) 필수' }, { status: 400 });
        if (!date) return Response.json({ error: 'date(YYYY-MM-DD) 필수' }, { status: 400 });
        if (idScope && !idScope.has(sid))
          return Response.json({ error: '담당 학원 학생만 총평을 쓸 수 있어요.' }, { status: 403 });

        const st = await getStudentById(env, sid);
        if (!st) return Response.json({ error: '학생을 찾을 수 없습니다.' }, { status: 404 });

        // 이미 발송된 총평은 수정 잠금(비가역 발송 이후 변경 방지)
        const existing = await getClinicReview(env, sid, date);
        if (existing && existing.status === 'sent')
          return Response.json({ error: '이미 발송된 총평은 수정할 수 없어요.' }, { status: 409 });

        const updates = {};
        if (body.asked !== undefined) updates.asked = clampText(body.asked);
        if (body.attitude !== undefined) updates.attitude = clampText(body.attitude);
        if (body.improvement !== undefined) updates.improvement = clampText(body.improvement);
        if (body.summary !== undefined) updates.summary = clampText(body.summary);
        if (body.difficulty !== undefined) {
          const d = String(body.difficulty || '').trim();
          if (d && !VALID_DIFFICULTY.includes(d))
            return Response.json({ error: 'difficulty는 easy/normal/hard 중 하나' }, { status: 400 });
          updates.difficulty = d;
        }
        if (body.wrong_count !== undefined && body.wrong_count !== null && body.wrong_count !== '') {
          const w = Number(body.wrong_count);
          if (!Number.isFinite(w) || w < 0 || w > MAX_WRONG || Math.round(w) !== w)
            return Response.json({ error: 'wrong_count(틀린 개수)는 0~' + MAX_WRONG + ' 정수' }, { status: 400 });
          updates.wrong_count = w;
        } else if (body.wrong_count === '' || body.wrong_count === null) {
          updates.wrong_count = null;   // 비우기 허용
        }
        // 작성자 흔적(추적용) — 조교 폰(X-Staff-Phone) 또는 원장
        const staffPhone = (request.headers.get('X-Staff-Phone') || '').replace(/\D/g, '');
        updates.author_phone = staffPhone || '';
        updates.author_name = isOwner ? '원장' : '조교';

        if (Object.keys(updates).length <= 2)   // author_* 만 있고 실제 내용 없음
          return Response.json({ error: '저장할 내용이 없어요.' }, { status: 400 });

        const r = await upsertClinicReview(env, sid, date, updates);
        if (!r.ok) return safeError(r.error || 'upsertClinicReview failed', env, { message: '총평 저장에 실패했습니다.' });
        return Response.json({ ok: true, id: sid, date, record: r.record });
      }

      // 발송(원장 전용) — 비가역. 각 학부모 폰으로 푸시 + 알림함 기록.
      if (action === 'send') {
        if (!isOwner) return Response.json({ error: '발송은 원장만 할 수 있어요.' }, { status: 403 });
        const date = (body.date || '').trim();
        if (!date) return Response.json({ error: 'date(YYYY-MM-DD) 필수' }, { status: 400 });

        // items 없으면 그 날짜 draft 전체 발송
        let items = Array.isArray(body.items) ? body.items : null;
        if (!items) {
          const all = await listClinicReviewsByDate(env, date);
          items = all.filter(r => r.status === 'draft').map(r => ({ id: r.studentId }));
        }
        if (!items.length) return Response.json({ error: '보낼 총평이 없어요.' }, { status: 400 });

        let sent = 0; const misses = [];
        const pushPhones = new Set();
        for (const it of items) {
          const sid = (it && it.id == null ? '' : String(it.id)).trim();
          if (!sid) { misses.push({ id: '', reason: 'no-id' }); continue; }
          const rev = await getClinicReview(env, sid, date);
          if (!rev) { misses.push({ id: sid, reason: 'no-review' }); continue; }
          if (rev.status === 'sent') { misses.push({ id: sid, reason: 'already-sent' }); continue; }
          const st = await getStudentById(env, sid);
          if (!st) { misses.push({ id: sid, reason: 'no-student' }); continue; }

          const bodyText = (it && it.body ? String(it.body) : composeBody(rev, st.name)).slice(0, 4000);
          const title = (it && it.title ? String(it.title) : ('🩺 ' + st.name + ' 클리닉 총평 (' + mmdd(date) + ')')).slice(0, 200);

          const created = await createNotification(env, {
            studentId: st.id, type: 'clinic_review', title, body: bodyText,
            url: '/portal', dedupKey: 'clinic_review:' + st.id + ':' + date, audience: 'parent',
          });
          if (!created.ok) { misses.push({ id: sid, reason: 'notif-failed' }); continue; }

          await markClinicReviewSent(env, sid, date, bodyText);
          sent++;
          // 학부모 폰만(클리닉 총평은 학부모 대상). 하이픈형으로 정규화해야 푸시 구독키와 매칭됨.
          const pd = normalizePhone(st.parentPhone);
          if (pd) pushPhones.add(pd);
        }

        // 푸시는 best-effort로 한 번에. 학부모 대상 → 밤(KST 23~7) 무음.
        if (pushPhones.size) {
          const phones = [...pushPhones];
          const p = sendPushToUsers(env, phones,
            { title: '🩺 클리닉 총평 도착', body: '오늘 클리닉 학습 총평이 도착했어요. 확인해 주세요.', url: '/portal', tag: 'kwmath-clinic-review' },
            { nightSilent: phones });
          if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
          else if (p && typeof p.catch === 'function') p.catch(() => {});
        }
        return Response.json({ ok: true, sent, misses });
      }

      return Response.json({ error: '지원하지 않는 action 입니다.' }, { status: 400 });
    }

    // ── DELETE: draft 삭제 (발송 완료건은 원장만) ──
    if (request.method === 'DELETE') {
      if (!isAdmin) return Response.json({ error: 'admin 인증 필요' }, { status: 401 });
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const sid = (body.id == null ? '' : String(body.id)).trim();
      const date = (body.date || '').trim();
      if (!sid || !date) return Response.json({ error: 'id + date 필수' }, { status: 400 });

      const academy = await staffScopeAcademy(env, request);   // null=원장
      const isOwner = (academy === null);
      if (!isOwner) {
        const scope = new Set((academy ? (await listStudents(env)).filter(s => (s.academy || '') === academy) : []).map(s => String(s.id)));
        if (!scope.has(sid)) return Response.json({ error: '담당 학원 학생만 삭제할 수 있어요.' }, { status: 403 });
      }
      const existing = await getClinicReview(env, sid, date);
      if (existing && existing.status === 'sent' && !isOwner)
        return Response.json({ error: '발송 완료된 총평은 원장만 삭제할 수 있어요.' }, { status: 403 });

      const r = await deleteClinicReview(env, sid, date);
      return Response.json({ ok: true, removed: r.removed || 0 });
    }

    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  } catch (e) {
    return safeError(e, env, { message: '클리닉 총평 처리 중 오류가 발생했습니다.' });
  }
}
