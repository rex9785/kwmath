// POST /api/admin-bulk-move (admin only) — Cloudflare D1 (이전엔 Notion)
// body: { moves: [{ sourceStudentId, targetAcademy, targetClassName }], mode: 'add-only' }
//   add-only : 새 enrollment 생성만. 옛 등록은 손대지 않는다.
//
// 🔴 2026-08-10 — 'transition' 모드를 제거했다 (관우T 지시: "안 쓸 거면 없앤다").
//   무엇이었나: 새 반에 행을 만들고 **옛 반 학생 행을 삭제**하던 모드. 화면엔 "옛 시즌 데이터는
//   archived로 보존"이라 적혀 있었지만 거짓이었다 — archiveEnrollment() 가
//   DELETE FROM attendance → DELETE FROM study_sessions → deleteStudent() 순으로 돌고
//   student_archive(퇴원 아카이브)를 거치지 않았다. 성적(exam_scores)은 student_id 기준이라
//   새 행에 안 딸려와 고아가 됐다. 즉 반 이동 한 번에 몇 달치 출결이 통째로 사라지는 버튼이었다.
//   게다가 화면 라디오 기본값도, 이 파일의 mode 기본값도 둘 다 'transition' 이었다.
//   왜 없앴나: 옛 반 정리는 이제 「반 종강」(class-options.js action:'archive-class')이 맡는다.
//   종강하면 그 반 학생은 '수료'로 바뀌고 행은 남는다 — 지우지 않고도 반이 접힌다.
//   되살리려면: 이 파일의 git 이력에 archiveEnrollment() 원본이 남아 있다. 다만 되살리기 전에
//   "출결·학습기록을 student_archive 없이 지워도 되는가"를 먼저 답해야 한다. 답은 아니오였다.
//   근거·설계: 인수인계/현재상태_수료상태_반종강_설계_20260810.md §3
import { getStudentById, createStudent } from './_db.js';
import { safeError } from './_errors.js';
import { logAudit } from './_auditlog.js';

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = 'KW';
  for (let i = 0; i < 6; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

function isAdmin(request, env) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  return !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
}

// 👥 2026-07-31 — 예전엔 `name + academy + class_name … LIMIT 1` 한 줄로 "이미 등록"을 판정했다.
//   그래서 그 반에 같은 이름 학생이 이미 있으면, **전혀 다른 학생**을 옮기려 해도
//   "이미 [학원 · 반]에 등록"이라며 막혔다. 원장님 입장에선 아무리 눌러도 안 옮겨지는데
//   화면엔 이미 등록됐다고 나오니 원인을 알 수 없다.
//   이름이 같아도 전화번호가 다르면 다른 사람이다 — 전화로 갈라서 판단한다.
//   (admin-add-enrollment.js 에 이미 넣은 것과 같은 방식)
//   반환에 붙는 값: 판정 = 'duplicate'(같은 사람) | 'ambiguous'(전화가 없어 판별 불가) | 'namesake'(동명이인, 진행)
async function copyEnrollment(env, sourceId, academy, className) {
  const src = await getStudentById(env, sourceId);
  if (!src) return { ok: false, error: '원본 학생을 찾을 수 없음' };
  const name = src.name;
  if (!name) return { ok: false, error: '원본 학생 이름 없음' };

  const d = (v) => String(v || '').replace(/\D/g, '');
  const 원본전화 = [d(src.studentPhone), d(src.parentPhone)].filter(Boolean);
  const { results: 동명행 } = await env.DB.prepare(
    'SELECT id, name, student_phone, parent_phone FROM students WHERE name = ? AND academy = ? AND class_name = ?'
  ).bind(name, academy, className).all();
  const 후보 = 동명행 || [];
  const 전화of = (r) => [d(r.student_phone), d(r.parent_phone)].filter(Boolean);
  const 같은사람 = 후보.find((r) => 전화of(r).some((x) => 원본전화.includes(x)));
  // 양쪽 다 전화가 없으면 같은 사람인지 다른 사람인지 알 방법이 없다 → 옮기지 않고 멈춘다.
  //   (여기서 그냥 진행하면 같은 학생이 한 반에 두 줄로 들어가고, 출결·리포트가 갈라진다.)
  const 판별불가 = !원본전화.length || 후보.some((r) => !전화of(r).length);

  if (같은사람) {
    return { ok: false, 판정: 'duplicate', name,
      error: '이미 [' + academy + ' · ' + className + ']에 등록 (전화번호가 일치하는 동일 학생)',
      existingId: String(같은사람.id) };
  }
  if (후보.length && 판별불가) {
    return { ok: false, 판정: 'ambiguous', name,
      error: '[' + academy + ' · ' + className + ']에 같은 이름 학생이 ' + 후보.length + '명 있는데, '
        + '전화번호가 비어 있어 같은 학생인지 동명이인인지 확정할 수 없어요. '
        + '학생 정보에 전화번호를 채우거나 이름을 「' + name + '2」처럼 구분해 주세요.',
      동명이인수: 후보.length,
      후보목록: 후보.map((r) => ({ id: String(r.id), 이름: r.name })) };
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
  if (!r.ok) return { ok: false, error: r.error || '생성 실패' };
  // 이름이 같은데 전화가 달랐던 경우 — 진행은 하되, 나중에 "왜 같은 반에 같은 이름이 둘이지?" 할 때
  //   근거가 남도록 표시해 둔다(호출부에서 감사로그로 남긴다).
  return { ok: true, newEnrollmentId: String(r.id), name,
    판정: 후보.length ? 'namesake' : 'new',
    동명이인수: 후보.length || undefined,
    동명이인목록: 후보.length ? 후보.map((x) => ({ id: String(x.id), 이름: x.name })) : undefined };
}

// 🗑️ archiveEnrollment() 는 2026-08-10 삭제됐다. 위 헤더 주석 참고 — 이름은 archive였지만 실제로는
//    출결·학습기록·학생 행을 통째로 지우는 함수였다. 이 자리에 다시 만들지 말 것.

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용' }, { status: 405 });
  if (!isAdmin(request, env)) return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const moves = Array.isArray(body.moves) ? body.moves : [];
  // 🔴 기본값이 'transition'(삭제 모드)이었다 → 'add-only'로 바꿨다. mode를 안 보내는 옛 호출부가
  //    있어도 이제는 아무것도 지우지 않는다. 안전한 쪽이 기본값이어야 한다.
  const mode  = (body.mode || 'add-only').toString();
  if (mode === 'transition') {
    return Response.json({
      error: '「시즌 전환(옛 등록 삭제)」 모드는 2026-08-10 제거됐습니다. 옛 반은 지우지 말고 「반 종강」으로 접어 주세요 — '
        + '종강하면 그 반 학생은 수료로 바뀌고 출결·학습기록은 그대로 남습니다.',
      removedMode: 'transition',
    }, { status: 400 });
  }
  if (mode !== 'add-only') return Response.json({ error: "mode는 'add-only'만 허용됩니다" }, { status: 400 });
  if (!moves.length) return Response.json({ error: 'moves 비어있음' }, { status: 400 });

  const results = [];
  let succeeded = 0, failed = 0;

  try {
    for (const m of moves) {
      const src  = Number((m.sourceStudentId || '').toString().trim());
      const acad = (m.targetAcademy || '').trim();
      const cls  = (m.targetClassName || '').trim();
      if (!Number.isFinite(src) || !acad || !cls) {
        results.push({ sourceStudentId: String(m.sourceStudentId || ''), ok: false, error: '필수 값 누락' });
        failed++; continue;
      }

      const copyResult = await copyEnrollment(env, src, acad, cls);
      if (!copyResult.ok) {
        // 👥 동명이인 때문에 멈춘 건 "실패"라기보다 판단이 필요한 상황이다 — 로그에 왜 멈췄는지 남긴다.
        //   (여기서 멈춰도 옛 등록은 그대로 살아 있다. 이 API는 이제 아무것도 지우지 않는다.)
        if (copyResult.판정 === 'ambiguous') {
          await logAudit(env, request, {
            action: 'student.move.ambiguous',
            target: String(src),
            targetName: copyResult.name || '',
            summary: '[' + (copyResult.name || src) + '] 반 이동 중단 — ' + acad + ' · ' + cls
              + '에 같은 이름 학생이 ' + (copyResult.동명이인수 || 0) + '명인데 전화번호가 없어 확정 못 함',
            detail: { 원본학생id: src, 이동후학원: acad, 이동후반: cls,
              동명이인수: copyResult.동명이인수, 후보목록: copyResult.후보목록,
              효과: '아무것도 옮기지 않았다. 옛 등록은 그대로 살아 있다',
              조치: '학생 정보에 전화번호를 채우거나 이름 뒤 숫자 별칭으로 구분한 뒤 다시 시도' },
          });
        }
        results.push({ sourceStudentId: String(src), ok: false, error: copyResult.error,
          판정: copyResult.판정, 동명이인수: copyResult.동명이인수, 후보목록: copyResult.후보목록 });
        failed++; continue;
      }
      if (copyResult.판정 === 'namesake') {
        await logAudit(env, request, {
          action: 'student.move.namesake',
          target: String(copyResult.newEnrollmentId),
          targetName: copyResult.name || '',
          summary: '[' + copyResult.name + '] ' + acad + ' · ' + cls + '에 같은 이름 학생이 이미 '
            + copyResult.동명이인수 + '명 있지만 전화번호가 달라 다른 학생으로 보고 이동 진행',
          detail: { 원본학생id: src, 새등록id: copyResult.newEnrollmentId, 이동후학원: acad, 이동후반: cls,
            동명이인수: copyResult.동명이인수, 동명이인목록: copyResult.동명이인목록,
            권장: '이름 뒤 숫자 별칭(' + copyResult.name + '1 · ' + copyResult.name + '2)으로 구분해 두면 '
              + '리포트·출결 화면에서 헷갈리지 않는다' },
        });
      }

      // 한 명 옮길 때마다 1건씩 남긴다 — 나중에 "누가 언제 이 학생을 어디서 어디로 옮겼나"를 찾을 때
      //   전체 배치 1건만 남아 있으면 학생 이름으로 검색이 안 된다.
      await logAudit(env, request, {
        action: 'student.move',
        target: String(src),
        targetName: copyResult.name || '',
        summary: '[' + (copyResult.name || src) + '] 반 배정 → ' + acad + ' · ' + cls + ' (기존 등록 유지)',
        detail: { 방식: mode, 원본학생id: src, 새등록id: copyResult.newEnrollmentId, 이동후학원: acad, 이동후반: cls },
      });

      results.push({ sourceStudentId: String(src), name: copyResult.name, ok: true,
        newEnrollmentId: copyResult.newEnrollmentId,
        판정: copyResult.판정,
        경고: copyResult.판정 === 'namesake'
          ? (acad + ' · ' + cls + '에 같은 이름 학생이 ' + copyResult.동명이인수 + '명 더 있어요. '
             + '이름 뒤 숫자(' + copyResult.name + '1 · ' + copyResult.name + '2)로 구분해 두시면 좋습니다.')
          : undefined });
      succeeded++;
    }

    return Response.json({ ok: true, mode, total: moves.length, succeeded, failed, results });
  } catch (e) {
    return safeError(e, env, { message: '반 이동 처리 중 오류가 발생했습니다.' });
  }
}
