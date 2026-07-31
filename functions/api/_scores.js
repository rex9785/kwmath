// /api/_scores.js — exam_scores 테이블 스키마 보장 + '테스트' 퀴즈 점수 자동 반영(공용 헬퍼)
// ───────────────────────────────────────────────────────────
// scores.js(수동 내신·모의 입력)와 surveys.js(테스트 퀴즈 자동 채점)가 같은
// exam_scores 테이블을 쓰므로, 스키마 정의를 여기 한 곳에 둔다(중복·드리프트 방지).
//
//  · 테스트 퀴즈(테스트 종류가 지정된 퀴즈)를 채점하면 그 점수를 100점 만점(%)으로
//    환산해 exam_scores에 자동 upsert 한다. examType = 테스트 종류(일일/주간/월말테스트).
//  · dedup 키 = source_key('quiz:<surveyId>'). 같은 학생·같은 테스트는 항상 1행 —
//    재제출·재채점(장문형 O·X) 시 덮어쓴다(중복 성적 안 쌓임).
//  · 수동 내신·모의(scores.js POST)는 source_key=NULL 이라 이 자동 흐름과 안 섞인다.
//
// 📓 2026-07-31 — 로그를 여기서 남기지 않는 이유 (관우T 지시: "어떤 조교가 뭘 만졌는지도 로그에 남겨")
//   이 파일은 request 를 모른다. 여기서 logAudit 을 부르면 행위자·기기·경로·IP가 전부 NULL 로 박혀
//   "누가 이 성적을 바꿨나"를 영영 못 읽는 로그가 쌓인다.
//   → **로그는 request 를 들고 있는 부르는 쪽(surveys.js)이 남긴다.** 대신 이 헬퍼는
//     존재확인 SELECT의 읽는 칸만 넓혀 before 를 붙잡고, before/after/created/removed/skipped 를 돌려준다.
//     (_db.js 의 upsertClinicReview / deleteClinicReview 와 같은 방식)
//   반환값은 전부 **덤**이다 — 예전처럼 무시해도 동작은 똑같다(절대 throw 안 함).
// ───────────────────────────────────────────────────────────
import { getStudentByName } from './_db.js';

// 퀴즈 빌더에서 고를 수 있는 '테스트 종류' — 이 값만 성적에 자동 반영한다.
export const TEST_KINDS = new Set(['일일테스트', '주간테스트', '월말테스트']);

let _examScoresReady = false;

// exam_scores 테이블 + 인덱스 + source_key 컬럼 보장 (idempotent).
export async function ensureExamScoresTable(env) {
  if (_examScoresReady) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS exam_scores (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, ' +
    'exam_type TEXT NOT NULL, grade_level TEXT, label TEXT NOT NULL, sort_key TEXT, ' +
    'raw_score INTEGER, grade INTEGER, exam_date TEXT, memo TEXT, ' +
    'source_key TEXT, created_at TEXT, updated_at TEXT)'
  ).run();
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_exam_scores_student ON exam_scores(student_id)').run(); } catch (_) { /* 비치명적 */ }
  // 구버전 테이블(컬럼 없던 시절) 대비 — 이미 있으면 무시.
  try { await env.DB.prepare('ALTER TABLE exam_scores ADD COLUMN source_key TEXT').run(); } catch (_) {}
  _examScoresReady = true;
}

// 테스트 퀴즈 채점 결과 → exam_scores 자동 upsert.
//   best-effort: 절대 throw 하지 않는다(응답 제출·채점을 막지 않기 위함).
//   opts = { survey:{ id, title, testKind, anonymous }, respondentName, score, maxScore }
export async function upsertTestScore(env, opts) {
  try {
    const survey = (opts && opts.survey) || {};
    const kind = String(survey.testKind || '').trim();
    // 🔎 2026-07-31 — 예전엔 전부 그냥 `return;` 이라 **왜 성적표에 안 올라갔는지**가 아무 데도 안 남았다.
    //   ("분명 시험 봤는데 성적표에 없어요"의 원인이 이름 오타인지 익명 설정인지 알 수 없었다.)
    //   → 스킵 사유를 돌려줘서 부르는 쪽이 로그로 남기게 한다. 흐름은 예전과 동일(그냥 반환).
    if (!TEST_KINDS.has(kind)) return { ok: false, skipped: '테스트 종류 미지정(일반 퀴즈) — 성적표 반영 대상 아님' };
    if (survey.anonymous) return { ok: false, skipped: '익명 설문 — 누구 점수인지 특정 불가' };
    const score = Number(opts.score), maxScore = Number(opts.maxScore);
    if (!Number.isFinite(maxScore) || maxScore <= 0) return { ok: false, skipped: '채점 가능한 문항이 없음(만점 0) — 환산 불가' };
    if (!Number.isFinite(score)) return { ok: false, skipped: '점수가 숫자가 아님' };
    const name = String(opts.respondentName || '').trim();
    if (!name) return { ok: false, skipped: '응답자 이름이 비어 있음' };
    const st = await getStudentByName(env, name);
    if (!st || !st.id) {                            // 등록 학생과 이름 매칭 안 되면 스킵
      return { ok: false, skipped: '등록 학생 명단에 [' + name + ']이(가) 없음 — 이름 표기가 다르면 성적표에 안 올라간다', respondentName: name };
    }

    const pct = Math.max(0, Math.min(100, Math.round(score / maxScore * 100)));  // 100점 만점 환산
    const sourceKey = 'quiz:' + survey.id;
    const now = new Date().toISOString();
    const examDate = now.slice(0, 10);              // YYYY-MM-DD
    const label = (String(survey.title || '').trim() || kind).slice(0, 120);

    await ensureExamScoresTable(env);
    // 🔎 읽는 칸만 넓혀 before 확보 — 어차피 하던 존재확인 SELECT라 쿼리 수는 그대로다(1회).
    //   성적은 덮어쓰기라 이전 점수가 그 자리에서 사라진다. "80점이 95점으로 바뀌었다"를
    //   증명할 근거는 이 before 뿐이다(재채점 분쟁·이의제기 때 유일한 자료).
    const existing = await env.DB.prepare(
      'SELECT id, exam_type, label, raw_score, exam_date, created_at, updated_at ' +
      'FROM exam_scores WHERE student_id=? AND source_key=?'
    ).bind(st.id, sourceKey).first();

    // 부르는 쪽이 diffFields(before, after) 를 그대로 돌릴 수 있게 칸 이름을 한글로 맞춰 둔다.
    //   (수정시각은 항상 달라져서 "바뀐 칸"을 더럽히므로 diff 대상에서 빼고 따로 돌려준다)
    const before = existing ? {
      종류: existing.exam_type || '',
      제목: existing.label || '',
      점수: existing.raw_score,
      시험일: existing.exam_date || '',
    } : null;
    const after = { 종류: kind, 제목: label, 점수: pct, 시험일: examDate };

    if (existing) {
      // 재채점(장문형 O·X 확정 등) → 같은 행 덮어쓰기.
      await env.DB.prepare(
        'UPDATE exam_scores SET exam_type=?, label=?, raw_score=?, exam_date=?, updated_at=? WHERE id=?'
      ).bind(kind, label, pct, examDate, now, existing.id).run();
    } else {
      // sort_key = 시험일(YYYY-MM-DD) → 테스트 탭에서 시간순 정렬. grade(등급)는 테스트에 없음(NULL).
      await env.DB.prepare(
        'INSERT INTO exam_scores (student_id, exam_type, grade_level, label, sort_key, raw_score, grade, exam_date, memo, source_key, created_at, updated_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(st.id, kind, '', label, examDate, pct, null, examDate, '', sourceKey, now, now).run();
    }
    return {
      ok: true,
      created: !existing,
      before, after,
      rowId: existing ? existing.id : null,
      studentId: st.id,
      studentName: (st && st.name) || name,
      examType: kind, label, sourceKey,
      rawScore: score, maxScore, pct,
      previousUpdatedAt: existing ? (existing.updated_at || '') : '',
      updatedAt: now,
    };
  } catch (e) {
    /* best-effort — 성적 반영 실패가 제출·채점을 막지 않게 (throw 안 함).
       단, 조용히 사라지면 안 되므로 사유는 돌려준다 — 부르는 쪽이 로그로 남긴다. */
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 응답 삭제(재제출 허용) 시 성적표 잔재 정리 — best-effort, 절대 throw 하지 않는다.
//   upsertTestScore가 만든 행(source_key='quiz:<surveyId>')을 같은 이름 매칭으로 지운다.
//   opts = { surveyId, respondentName }
export async function deleteTestScore(env, opts) {
  try {
    const surveyId = opts && opts.surveyId;
    const name = String((opts && opts.respondentName) || '').trim();
    if (!surveyId || !name) return { ok: false, skipped: 'surveyId 또는 응답자 이름이 없음' };
    const st = await getStudentByName(env, name);
    if (!st || !st.id) {
      return { ok: false, skipped: '등록 학생 명단에 [' + name + ']이(가) 없음 — 지울 성적 행도 없음', respondentName: name };
    }
    await ensureExamScoresTable(env);
    const sourceKey = 'quiz:' + surveyId;
    // ⚠️ 2026-07-31 — 삭제는 되돌릴 수 없다. 지우기 전에 그 행을 먼저 읽어 before 로 돌려준다.
    //   (이 파일은 request 가 없어 직접 로그를 못 남긴다 → 로그는 surveys.js 가 남긴다.)
    //   이게 없으면 "성적표에서 그 테스트 점수가 왜 사라졌지"에 답할 근거가 하나도 없다.
    const row = await env.DB.prepare(
      'SELECT id, exam_type, label, raw_score, exam_date, created_at, updated_at ' +
      'FROM exam_scores WHERE student_id=? AND source_key=?'
    ).bind(st.id, sourceKey).first();
    const res = await env.DB.prepare('DELETE FROM exam_scores WHERE student_id=? AND source_key=?')
      .bind(st.id, sourceKey).run();
    return {
      ok: true,
      removed: (res && res.meta && res.meta.changes) || 0,
      before: row ? {
        종류: row.exam_type || '',
        제목: row.label || '',
        점수: row.raw_score,
        시험일: row.exam_date || '',
        등록시각: row.created_at || '',
      } : null,
      rowId: row ? row.id : null,
      studentId: st.id,
      studentName: (st && st.name) || name,
      sourceKey,
    };
  } catch (e) {
    /* best-effort — 절대 throw 하지 않는다. 사유만 돌려주고 부르는 쪽이 로그로 남긴다. */
    return { ok: false, error: String((e && e.message) || e) };
  }
}
