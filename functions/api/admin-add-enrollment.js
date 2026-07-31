// POST /api/admin-add-enrollment (admin only) — Cloudflare D1 (이전엔 Notion)
// body: { sourceStudentId (D1 id), academy, className }
// 기존 학생 정보 복사 + 학원/반만 새로 지정 + 새 개인키. 새 enrollment는 '승인' 상태.
import { getStudentById, createStudent } from './_db.js';
import { safeError } from './_errors.js';
import { logAudit } from './_auditlog.js';

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = 'KW';
  for (let i = 0; i < 6; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

// 새로 만들어진 학생 레코드를 로그용으로 다듬는다.
//   ① 개인키(personal_key)는 로그에 넣지 않는다 — 값 자체는 students 표에 그대로 남아 있어 언제든 확인 가능.
//   ② 원장 메모(notes)는 셀프수정 이력이 계속 붙어 길어지므로 3000자에서 자른다(detail 2만자 상한 보호).
//   ⚠️ 반드시 사본을 만든다 — 원본을 그 자리에서 고치면 실제 저장값과 로그가 어긋난다.
function forLog(cols) {
  if (!cols || typeof cols !== 'object') return cols;
  const o = Object.assign({}, cols);
  if ('personal_key' in o) o.personal_key = '(로그에 안 남김 · students 표에 저장됨)';
  if (typeof o.notes === 'string' && o.notes.length > 3000) o.notes = o.notes.slice(0, 3000) + '…(잘림)';
  return o;
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용' }, { status: 405 });
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) {
    // 🔒 인증 없는 등록 시도 — 반 배정은 학생이 보는 공지·영상·과제를 통째로 바꾸는 일이라 시도 자체를 남긴다.
    await logAudit(env, request, {
      action: 'enrollment.add.denied',
      summary: '반 등록 추가 거부(401) — 관리자 인증 없음',
      detail: { 결과: '아무것도 만들어지지 않음', 비고: '토큰·비밀번호 원문은 로그에 담지 않는다' },
    });
    return Response.json({ error: '인증 실패' }, { status: 401 });
  }

  let body = {};
  try { body = await request.json(); } catch {}
  const sourceId  = Number((body.sourceStudentId || '').toString().trim());
  const academy   = (body.academy   || '').toString().trim();
  const className = (body.className || '').toString().trim();

  // 반려(400)도 남긴다 — 화면이 값을 제대로 안 보내는 버그인지 사람이 빈칸으로 눌렀는지 구분해야 한다.
  const rejectAdd = async (msg) => {
    await logAudit(env, request, {
      action: 'enrollment.add.reject',
      target: body.sourceStudentId != null ? String(body.sourceStudentId).slice(0, 200) : '',
      summary: '반 등록 추가 반려(400) — ' + msg,
      detail: {
        받은원본학생id: body.sourceStudentId != null ? String(body.sourceStudentId) : '(없음)',
        받은학원: academy || '(없음)', 받은반: className || '(없음)',
        사유: msg, 결과: '아무것도 만들어지지 않음',
      },
    });
    return Response.json({ error: msg }, { status: 400 });
  };

  if (!body.sourceStudentId || !Number.isFinite(sourceId)) return await rejectAdd('sourceStudentId 필수');
  if (!academy || !className) return await rejectAdd('academy, className 둘 다 필요');

  try {
    const src = await getStudentById(env, sourceId);
    if (!src) {
      await logAudit(env, request, {
        action: 'enrollment.add.miss',
        target: String(sourceId),
        summary: '반 등록 추가 실패(404) — 원본 학생(id ' + sourceId + ')을 찾을 수 없음',
        detail: {
          원본학생id: String(sourceId), 넣으려던학원: academy, 넣으려던반: className,
          추정원인: '퇴원·삭제된 학생이거나 화면이 옛 id를 들고 있음',
          결과: '아무것도 만들어지지 않음',
        },
      });
      return Response.json({ error: '원본 학생을 찾을 수 없습니다' }, { status: 404 });
    }
    const name = src.name;
    if (!name) return await rejectAdd('원본 학생 이름 없음');

    const dup = await env.DB.prepare(
      'SELECT id FROM students WHERE name = ? AND academy = ? AND class_name = ? LIMIT 1'
    ).bind(name, academy, className).first();
    if (dup) {
      // ⚠️ 중복 판정을 **이름**으로 한다 — 동명이인이면 남의 등록 때문에 막힐 수 있다(아래 지목방식 참고).
      await logAudit(env, request, {
        action: 'enrollment.add.duplicate',
        target: String(sourceId), targetName: name,
        summary: '반 등록 추가 중단(409) — [' + name + ']은 이미 ' + academy + ' · ' + className + '에 등록돼 있음',
        detail: {
          원본학생id: String(sourceId), 이름: name,
          넣으려던학원: academy, 넣으려던반: className,
          이미있는등록id: String(dup.id),
          중복판정방식: '이름+학원+반으로 검사 — 동명이인이면 남의 등록 때문에 막힐 수 있음(현 코드 그대로 둠)',
          결과: '아무것도 만들어지지 않음',
        },
      });
      return Response.json({ error: '이미 [' + academy + ' · ' + className + ']에 등록돼있습니다.' }, { status: 409 });
    }

    const newKey = generateKey();
    const r = await createStudent(env, {
      name, school: src.school, grade: src.grade,
      parentPhone4: src.parentPhone4, studentPhone: src.studentPhone,
      parentPhone: src.parentPhone, parentRelation: src.parentRelation,
      goals: src.goals, level: src.level, academy, className,
      mathMockGrade: src.mathMockGrade, mathMockScore: src.mathMockScore,
      korMockGrade: src.korMockGrade, engMockGrade: src.engMockGrade,
      schoolMathGrade: src.schoolMathGrade, advanceProgress: src.advanceProgress,
      availableDays: src.availableDays, weakness: src.weakness, dreamUniv: src.dreamUniv, notes: src.notes,
      personalKey: newKey, approvalStatus: '승인',
    });
    if (!r.ok) {
      await logAudit(env, request, {
        action: 'enrollment.add.fail',
        target: String(sourceId), targetName: name,
        summary: '반 등록 추가 실패(DB 오류) — [' + name + '] → ' + academy + ' · ' + className,
        detail: {
          원본학생id: String(sourceId), 이름: name, 넣으려던학원: academy, 넣으려던반: className,
          DB오류: String(r.error || '알 수 없는 오류').slice(0, 300),
          결과: '새 등록이 안 만들어짐 — 학생은 기존 반에 그대로 있음',
        },
      });
      return safeError(r.error || 'createStudent failed', env, { message: 'enrollment 추가에 실패했습니다.' });
    }

    // 📓 2026-07-31 — 반 배정 추가는 지금까지 아무 기록도 안 남았다.
    //   등록이 하나 늘면 그 학생 화면에 새 반의 공지·수업영상·과제가 함께 뜨고, 출결·리포트도 반별로 따로 쌓인다.
    //   "누가 이 학생을 여기에 넣었지"를 나중에 물으면 답할 근거가 이 로그밖에 없다.
    //   🆔 target은 원장이 화면에서 누른 **원본 학생 id** — admin-bulk-move의 student.move와 같은 규칙.
    //      새로 생긴 등록 id는 요약과 detail(새등록id)에 함께 남긴다.
    await logAudit(env, request, {
      action: 'enrollment.add',
      target: String(sourceId), targetName: name,
      summary: '반 등록 추가 [' + name + '] → ' + academy + ' · ' + className
        + ' (원본 id ' + sourceId + ' → 새 등록 id ' + r.id + ' · 기존 등록 유지)',
      detail: {
        원본학생id: String(sourceId), 새등록id: String(r.id), 이름: name,
        원본학원: src.academy || '', 원본반: src.className || '',
        새학원: academy, 새반: className,
        승인상태: '승인(바로 사용 가능 — 대기중 단계 없음)',
        복사된정보: forLog(r.after),
        효과: '이 학생은 이제 두 반에 동시에 속한다. 새 반의 공지·수업영상·과제가 학생 화면에 함께 뜨고, '
          + '출결·클리닉·리포트는 등록별로 따로 쌓인다. 기존 반 등록과 그 기록은 그대로 남는다.',
        비고: '새 개인키가 발급됐지만 로그에는 남기지 않는다(students 표에서 확인). 비밀번호·토큰도 담지 않는다.',
      },
    });

    return Response.json({
      ok: true, newStudentId: String(r.id), personalKey: newKey,
      copiedFrom: String(sourceId), name, academy, className,
    });
  } catch (e) {
    return safeError(e, env, { message: 'enrollment 추가에 실패했습니다.' });
  }
}
