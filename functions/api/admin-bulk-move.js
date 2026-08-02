// POST /api/admin-bulk-move (admin only) — Cloudflare D1 (이전엔 Notion)
// body: { moves: [{ sourceStudentId, targetAcademy, targetClassName }], mode: 'transition'|'add-only' }
//   transition: 새 enrollment 생성 + 옛 enrollment 삭제(그 출결/공부 포함)
//   add-only  : 새 enrollment 생성만
import { getStudentById, createStudent, deleteStudent } from './_db.js';
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

// ⚠️ 이름은 archive지만 실제로는 **삭제**다 — 출결·학습기록·학생 레코드가 통째로 사라진다.
//    (퇴원 아카이브(student_archive)로 가지 않는다.) 반 이동 한 번에 몇 달치 출결이 없어질 수 있으므로,
//    지우기 전에 몇 건이 사라지는지 세고, 지워진 학생 레코드 전체를 로그에 남긴다.
async function archiveEnrollment(env, request, studentId) {
  try {
    let attCount = 0, studyCount = 0, attRows = [];
    try {
      const { results } = await env.DB.prepare(
        'SELECT date, status, homework, homework_note, note, method FROM attendance WHERE student_id = ? ORDER BY date'
      ).bind(studentId).all();
      attRows = results || [];
      attCount = attRows.length;
    } catch (_) {}
    try {
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM study_sessions WHERE student_id = ?').bind(studentId).first();
      studyCount = (c && c.n) || 0;
    } catch (_) {}

    await env.DB.prepare('DELETE FROM attendance WHERE student_id = ?').bind(studentId).run();
    await env.DB.prepare('DELETE FROM study_sessions WHERE student_id = ?').bind(studentId).run();
    const d = await deleteStudent(env, studentId);

    await logAudit(env, request, {
      action: 'enrollment.delete',
      target: String(studentId),
      targetName: (d.before && d.before.name) || '',
      summary: '반 이동(transition) — 옛 등록 삭제: 출결 ' + attCount + '건 · 학습 ' + studyCount + '건 · 학생레코드 1건',
      // 출결 원본은 200건까지만 담는다(로그 1건이 지나치게 커지는 걸 막되, 건수는 위에 정확히 남김).
      detail: {
        studentId, 출결삭제: attCount, 학습삭제: studyCount,
        지워진학생: d.before || null,
        지워진출결: attRows.slice(0, 200),
        출결일부만저장: attCount > 200,
        결과: d.ok ? 'ok' : (d.error || '삭제 실패'),
      },
    });
    return d.ok ? { ok: true, attCount, studyCount } : { ok: false, error: d.error || '삭제 실패' };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return Response.json({ error: 'POST만 허용' }, { status: 405 });
  if (!isAdmin(request, env)) return Response.json({ error: '인증 실패' }, { status: 401 });

  let body = {};
  try { body = await request.json(); } catch {}
  const moves = Array.isArray(body.moves) ? body.moves : [];
  const mode  = (body.mode || 'transition').toString();
  if (!['transition', 'add-only'].includes(mode)) return Response.json({ error: 'mode는 transition 또는 add-only' }, { status: 400 });
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
        //   (transition 모드에서 여기서 멈추면 옛 등록은 그대로 살아 있다. 데이터가 사라지진 않는다.)
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

      if (mode === 'transition') {
        const archiveResult = await archiveEnrollment(env, request, src);
        if (!archiveResult.ok) {
          results.push({ sourceStudentId: String(src), name: copyResult.name, ok: false, partial: true,
            newEnrollmentId: copyResult.newEnrollmentId,
            error: '새 enrollment 생성됐지만 옛 enrollment 삭제 실패: ' + archiveResult.error });
          failed++; continue;
        }
      }

      // 한 명 옮길 때마다 1건씩 남긴다 — 나중에 "누가 언제 이 학생을 어디서 어디로 옮겼나"를 찾을 때
      //   전체 배치 1건만 남아 있으면 학생 이름으로 검색이 안 된다.
      await logAudit(env, request, {
        action: 'student.move',
        target: String(src),
        targetName: copyResult.name || '',
        summary: '[' + (copyResult.name || src) + '] 반 이동 → ' + acad + ' · ' + cls
          + (mode === 'transition' ? ' (옛 등록 삭제)' : ' (기존 등록 유지)'),
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
