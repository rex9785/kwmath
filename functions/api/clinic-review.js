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
//         🔧 2026-07-30 (2-1): 메모 키가 (date, academy) — 조교는 자기 학원 행, 원장은 academy'' 행.
//         GET(원장)엔 staffMemos:[{academy,memo,updatedAt}]로 그날 학원별 조교 메모가 함께 온다.
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
  getClinicDayMemo, setClinicDayMemo, listClinicDayMemos,
} from './_db.js';
import { staffScopeAcademy } from './_staff.js';
import { sendPushToUsers } from './_push.js';
import { safeError } from './_errors.js';
import { createNotification } from './_notifications.js';
import { logAudit, actorOf, diffFields } from './_auditlog.js';

const VALID_DIFFICULTY = ['easy', 'normal', 'hard'];
const MAX_TEXT = 1000;   // 각 텍스트 칸 최대 길이(과다 입력 방지)
const MAX_WRONG = 200;   // 틀린 개수 상한(방어적)

function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 조교면 "맡은 학원" 학생 id Set, 원장이면 null(제한 없음). 미배정 조교는 빈 Set.
//   ⚠️ 이름이 아니라 id로 스코프 — 동명이인 안전(평생 규칙: student_id 식별).
//   academy 값은 staffScopeAcademy 결과를 그대로 받는다(호출측이 이미 갖고 있어 이중 조회 방지).
async function staffIdScope(env, academy) {
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
      const academy = await staffScopeAcademy(env, request);   // null=원장, ''=미배정 조교
      const idScope = await staffIdScope(env, academy);

      let reviews = await listClinicReviewsByDate(env, date);
      if (idScope) reviews = reviews.filter(r => idScope.has(String(r.studentId)));

      // 그날 클리닉 참석자(총평 추가용 후보). listClinicByDate 행 → {studentId,name,status,achieve,minutes}
      let clinicRows = await listClinicByDate(env, date);
      let clinicStudents = (clinicRows || []).map(r => ({
        studentId: r.student_id, name: r.name || '',
        status: r.status || '', achieve: r.achieve, minutes: r.minutes,
      }));
      if (idScope) clinicStudents = clinicStudents.filter(s => idScope.has(String(s.studentId)));

      // 메모 키 = (date, academy). 조교는 자기 학원 행, 원장(null)은 본인('') 행 + 학원별 조교 메모 목록.
      //   미배정 조교('')는 원장 행을 보여주지 않는다(빈 메모).
      const memoObj = (academy === null || academy)
        ? await getClinicDayMemo(env, date, academy || '')
        : { memo: '', updatedAt: null };
      const staffMemos = (academy === null) ? await listClinicDayMemos(env, date) : [];
      return Response.json({ date, reviews, clinicStudents, memo: memoObj.memo, staffMemos, isOwner: academy === null });
    }

    // ── POST ──
    if (request.method === 'POST') {
      if (!isAdmin) return Response.json({ error: 'admin 인증 필요' }, { status: 401 });
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const action = (body.action || '').trim();
      const academy = await staffScopeAcademy(env, request);   // null=원장, ''=미배정 조교
      const isOwner = (academy === null);
      const idScope = await staffIdScope(env, academy);

      // 하루 전체 메모 저장(원장님만 봄) — 조교·원장 모두 작성 가능. 키 = (date, academy).
      //   조교는 자기 학원 행에만 쓴다(다른 학원 메모를 덮어쓰던 2-1 버그 수정).
      //   미배정 조교('')가 원장('') 행에 쓰는 것을 막는다.
      if (action === 'saveMemo') {
        const date = (body.date || '').trim();
        if (!date) return Response.json({ error: 'date(YYYY-MM-DD) 필수' }, { status: 400 });
        if (!isOwner && !academy) return Response.json({ error: '학원 배정 후 메모를 쓸 수 있어요. 원장님께 배정을 요청해주세요.' }, { status: 403 });
        const memo = clampText(body.memo);
        const r = await setClinicDayMemo(env, date, memo, academy || '');
        if (!r.ok) return safeError(r.error || 'setClinicDayMemo failed', env, { message: '메모 저장에 실패했습니다.' });

        // 📓 2026-07-31 — 하루메모는 **덮어쓰기**다. 같은 (날짜·학원) 칸에 조교가 여럿 쓰면
        //   먼저 쓴 사람 글이 통째로 사라진다. 그래서 "전 → 후"를 통째로 남긴다.
        //   (2026-07-30 2-1 버그: 조교가 남의 학원 메모를 덮어쓰던 문제. 고쳤지만 증거는 계속 남긴다.)
        const 지워진글자 = (r.before || '').length - memo.length;
        await logAudit(env, request, {
          action: r.created ? 'clinic.memo.create' : 'clinic.memo.update',
          target: date + '/' + (academy || (isOwner ? '(원장)' : '(미배정)')),
          targetName: (academy || (isOwner ? '원장' : '')),
          summary: '클리닉 하루메모 ' + (r.created ? '작성' : '수정')
            + ' [' + date + ' · ' + (academy || (isOwner ? '원장' : '미배정')) + '] '
            + (r.before === null ? '(새로 씀)'
               : (r.before === memo ? '(내용 동일)'
                  : ((지워진글자 > 0 ? '기존 ' + (r.before || '').length + '자 → ' + memo.length + '자(줄어듦)'
                                     : '기존 ' + (r.before || '').length + '자 → ' + memo.length + '자')))),
          detail: {
            날짜: date,
            메모칸: academy || (isOwner ? '(원장 전용 행)' : '(미배정)'),
            작성자구분: isOwner ? '원장' : '조교',
            새로작성: !!r.created,
            전: r.before === null ? '(빈 칸이었음)' : r.before,
            후: memo,
            글자수: { 전: (r.before || '').length, 후: memo.length },
            내용바뀜: (r.before || '') !== memo,
            비고: (!r.created && (r.before || '') && (r.before || '') !== memo)
              ? '⚠️ 기존 메모를 덮어썼다 — 위 "전" 값이 사라진 원문의 유일한 기록'
              : '',
          },
        });
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
        // 📓 2026-07-31 — 예전엔 author_name 에 '조교' 두 글자만 넣었다. 조교가 여럿이면
        //   누가 쓴 총평인지 영영 알 수 없었다(homework.js checked_by 와 똑같은 문제).
        //   미들웨어가 검증해 실어 보낸 **실제 이름**을 쓴다. 이름을 못 얻으면 옛 표기로 폴백.
        const who = actorOf(request, env);
        const staffPhone = (request.headers.get('X-Staff-Phone') || '').replace(/\D/g, '');
        updates.author_phone = staffPhone || '';
        updates.author_name = isOwner
          ? '원장'
          : ((who.actorRole === 'staff' && who.actorName) ? who.actorName : '조교');

        if (Object.keys(updates).length <= 2)   // author_* 만 있고 실제 내용 없음
          return Response.json({ error: '저장할 내용이 없어요.' }, { status: 400 });

        const r = await upsertClinicReview(env, sid, date, updates);
        if (!r.ok) return safeError(r.error || 'upsertClinicReview failed', env, { message: '총평 저장에 실패했습니다.' });

        // 📓 총평은 학부모에게 나가는 글이다. 어느 문장이 어떻게 바뀌었는지 칸별로 남긴다.
        const stu = await getStudentById(env, sid).catch(() => null);
        const d = diffFields(r.before, r.after,
          ['asked', 'attitude', 'improvement', 'wrong_count', 'difficulty', 'summary', 'author_name']);
        await logAudit(env, request, {
          action: r.created ? 'clinic.review.create' : 'clinic.review.update',
          target: String(sid), targetName: (stu && stu.name) || '',
          summary: '클리닉 총평 ' + (r.created ? '작성' : '수정')
            + ' [' + ((stu && stu.name) || sid) + ' · ' + date + '] — ' + (d.요약 || '변경 없음'),
          detail: {
            학생id: String(sid), 이름: (stu && stu.name) || '', 학원: (stu && stu.academy) || '', 날짜: date,
            새로작성: !!r.created,
            작성자표기: updates.author_name,
            바뀐칸: d.바뀐칸, 변경: d.변경,
            이전전문: r.before || '(없음)',
            현재상태: (r.after && r.after.status) || '',
            비고: (r.before && r.before.status === 'sent')
              ? '⚠️ 이미 학부모에게 발송된 총평을 고쳤다 — 이미 간 알림 내용은 안 바뀜'
              : '',
          },
        });
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

        // 🔴 2026-07-31 — 여기는 **비가역**이다. 학부모 폰으로 나간 글은 회수할 수 없다.
        //   예전엔 sent 개수와 misses 코드('no-review' 같은 약어)만 응답으로 돌려주고 끝이었다.
        //   브라우저를 닫으면 "누구에게 무슨 문장이 갔는지"가 통째로 사라졌다.
        //   → 학생별 한 줄씩, 실제 나간 제목·본문까지 로그에 남긴다.
        let sent = 0; const misses = [];
        const pushPhones = new Set();
        const 발송내역 = [];       // 실제로 나간 사람들
        const 못보낸내역 = [];     // 왜 안 나갔는지(사람이 읽을 수 있는 말로)
        for (const it of items) {
          const sid = (it && it.id == null ? '' : String(it.id)).trim();
          if (!sid) {
            misses.push({ id: '', reason: 'no-id' });
            못보낸내역.push({ 학생id: '(없음)', 사유: '화면이 학생 id 없이 보냄 — 목록이 깨졌을 수 있음' });
            continue;
          }
          const rev = await getClinicReview(env, sid, date);
          if (!rev) {
            misses.push({ id: sid, reason: 'no-review' });
            못보낸내역.push({ 학생id: sid, 사유: '그 날짜에 저장된 총평이 없음(작성 안 했거나 방금 삭제됨)' });
            continue;
          }
          if (rev.status === 'sent') {
            misses.push({ id: sid, reason: 'already-sent' });
            못보낸내역.push({ 학생id: sid, 사유: '이미 발송 완료된 총평 — 중복 발송 막음', 이전발송시각: rev.sentAt || '' });
            continue;
          }
          const st = await getStudentById(env, sid);
          if (!st) {
            misses.push({ id: sid, reason: 'no-student' });
            못보낸내역.push({ 학생id: sid, 사유: '학생 레코드를 못 찾음(퇴원·삭제된 학생의 총평이 남아 있음)' });
            continue;
          }

          const 원장수정본 = !!(it && it.body);
          const bodyText = (it && it.body ? String(it.body) : composeBody(rev, st.name)).slice(0, 4000);
          const title = (it && it.title ? String(it.title) : ('🩺 ' + st.name + ' 클리닉 총평 (' + mmdd(date) + ')')).slice(0, 200);

          const created = await createNotification(env, {
            studentId: st.id, type: 'clinic_review', title, body: bodyText,
            url: '/portal', dedupKey: 'clinic_review:' + st.id + ':' + date, audience: 'parent',
          });
          if (!created.ok) {
            misses.push({ id: sid, reason: 'notif-failed' });
            못보낸내역.push({ 학생id: sid, 이름: st.name || '', 사유: '알림함 기록 실패 — 푸시도 안 나감', 오류: created.error || '' });
            continue;
          }

          const mk = await markClinicReviewSent(env, sid, date, bodyText);
          sent++;
          // 학부모 폰만(클리닉 총평은 학부모 대상). 하이픈형으로 정규화해야 푸시 구독키와 매칭됨.
          const pd = normalizePhone(st.parentPhone);
          if (pd) pushPhones.add(pd);
          발송내역.push({
            학생id: String(sid), 이름: st.name || '', 학원: st.academy || '', 반: st.className || '',
            학부모폰: pd || '(학부모 번호 없음 — 알림함엔 남지만 푸시는 못 감)',
            제목: title,
            본문: bodyText,                                   // 실제로 학부모가 읽은 그 문장
            본문출처: 원장수정본 ? '원장이 화면에서 고친 문구' : '저장된 총평으로 자동 조립(composeBody)',
            작성자표기: rev.authorName || '',
            작성자폰: rev.authorPhone || '',
            알림id: created.id || '',
            알림함기록: created.created === false
              ? '⚠️ 같은 중복키 알림이 이미 있어 새로 안 만듦(학부모 알림함엔 예전 문구가 그대로)'
              : '새로 기록됨',
            중복키: 'clinic_review:' + st.id + ':' + date,
            발송전상태: (mk && mk.before && mk.before.status) || rev.status || 'draft',
            발송시각: (mk && mk.sentAt) || '',
          });
        }

        // 푸시는 best-effort로 한 번에. 학부모 대상 → 밤(KST 23~7) 무음.
        const 푸시대상 = [...pushPhones];
        if (pushPhones.size) {
          const phones = 푸시대상;
          const p = sendPushToUsers(env, phones,
            { title: '🩺 클리닉 총평 도착', body: '오늘 클리닉 학습 총평이 도착했어요. 확인해 주세요.', url: '/portal', tag: 'kwmath-clinic-review' },
            { nightSilent: phones });
          if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
          else if (p && typeof p.catch === 'function') p.catch(() => {});
        }

        // detail 한도(20000자)를 넘기면 통째로 잘려 로그 JSON이 깨진다 → 인원이 많으면 본문만 줄인다.
        //   (본문 전문은 clinic_reviews.sent_body 에도 저장돼 있으니 완전히 잃지는 않는다.)
        let 내역 = 발송내역; let 줄임메모 = '';
        if (JSON.stringify(내역).length > 14000) {
          내역 = 발송내역.map(x => ({ ...x, 본문: String(x.본문).slice(0, 300) + (String(x.본문).length > 300 ? ' …(줄임)' : '') }));
          줄임메모 = '인원이 많아 본문을 앞 300자만 보관(전문은 clinic_reviews.sent_body)';
        }
        if (JSON.stringify(내역).length > 16000) {
          내역 = 내역.slice(0, 60);
          줄임메모 += (줄임메모 ? ' · ' : '') + '앞 60명만 보관';
        }

        await logAudit(env, request, {
          action: 'clinic.review.send',
          target: date, targetName: '클리닉 총평 발송',
          summary: '클리닉 총평 학부모 발송 [' + date + '] — ' + sent + '명 발송'
            + (misses.length ? ' · ' + misses.length + '명 못 보냄' : '')
            + ' · 푸시 대상 ' + 푸시대상.length + '대 (되돌릴 수 없음)',
          detail: {
            날짜: date,
            요청건수: items.length,
            발송성공: sent,
            못보냄: misses.length,
            발송범위: Array.isArray(body.items) ? '화면에서 고른 학생들' : '그 날짜 draft 전체 자동 선택',
            발송내역: 내역,
            못보낸내역: 못보낸내역.slice(0, 100),
            푸시대상폰: 푸시대상,
            푸시: pushPhones.size
              ? '학부모 ' + 푸시대상.length + '대에 푸시 시도(best-effort, KST 23~7시는 무음) — 성공 여부는 별도'
              : '푸시 대상 없음(학부모 번호가 없거나 구독 안 됨) — 알림함에만 남음',
            잘림: 줄임메모,
            비고: '⚠️ 비가역 — 학부모 폰에 이미 뜬 알림은 회수할 수 없다. 위 "본문"이 실제로 나간 문장.',
          },
        });
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

      // 🔴 2026-07-31 — 조교가 몇 분에 걸쳐 쓴 총평이 통째로 사라지는 자리인데 아무 기록이 없었다.
      //   "누가 지웠는지"뿐 아니라 **무슨 글이 사라졌는지**까지 남긴다(복구 시 이 로그가 원본).
      const gone = r.before || null;
      const stu = await getStudentById(env, sid).catch(() => null);
      await logAudit(env, request, {
        action: 'clinic.review.delete',
        target: String(sid), targetName: (stu && stu.name) || '',
        summary: '클리닉 총평 삭제 [' + ((stu && stu.name) || sid) + ' · ' + date + ']'
          + (gone ? ' — 작성자 ' + (gone.authorName || '(표기없음)')
                  + (gone.status === 'sent' ? ' · ⚠️ 이미 학부모에게 발송된 총평' : ' · 미발송 draft')
            : ' — 지울 총평이 이미 없었음')
          + ' · 삭제 ' + (r.removed || 0) + '건 (복구 불가)',
        detail: {
          학생id: String(sid), 이름: (stu && stu.name) || '', 학원: (stu && stu.academy) || '',
          반: (stu && stu.className) || '', 날짜: date,
          삭제건수: r.removed || 0,
          지운사람구분: isOwner ? '원장' : '조교',
          지워진총평: gone || '(삭제 시점에 해당 총평이 없었음 — 이미 지워졌거나 날짜/학생 오지정)',
          발송된적있나: !!(gone && gone.status === 'sent'),
          발송시각: (gone && gone.sentAt) || '',
          학부모에게간본문: (gone && gone.sentBody) ? String(gone.sentBody).slice(0, 3000) : '(발송 전이라 없음)',
          비고: (gone && gone.status === 'sent')
            ? '⚠️ 학부모 폰에 이미 뜬 알림과 알림함 기록은 이 삭제로 사라지지 않는다 — 학부모는 계속 볼 수 있고, 원장 화면에서만 사라진다'
            : '미발송 draft라 학부모에게는 아무 영향 없음',
        },
      });
      return Response.json({ ok: true, removed: r.removed || 0 });
    }

    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  } catch (e) {
    return safeError(e, env, { message: '클리닉 총평 처리 중 오류가 발생했습니다.' });
  }
}
