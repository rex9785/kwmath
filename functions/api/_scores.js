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
    if (!TEST_KINDS.has(kind)) return;              // 테스트 종류 없으면(=일반 퀴즈) 성적 반영 안 함
    if (survey.anonymous) return;                   // 익명이면 누구 점수인지 특정 불가
    const score = Number(opts.score), maxScore = Number(opts.maxScore);
    if (!Number.isFinite(maxScore) || maxScore <= 0) return;   // 채점 가능한 문항이 없으면 스킵
    if (!Number.isFinite(score)) return;
    const name = String(opts.respondentName || '').trim();
    if (!name) return;
    const st = await getStudentByName(env, name);
    if (!st || !st.id) return;                      // 등록 학생과 이름 매칭 안 되면 스킵

    const pct = Math.max(0, Math.min(100, Math.round(score / maxScore * 100)));  // 100점 만점 환산
    const sourceKey = 'quiz:' + survey.id;
    const now = new Date().toISOString();
    const examDate = now.slice(0, 10);              // YYYY-MM-DD
    const label = (String(survey.title || '').trim() || kind).slice(0, 120);

    await ensureExamScoresTable(env);
    const existing = await env.DB.prepare(
      'SELECT id FROM exam_scores WHERE student_id=? AND source_key=?'
    ).bind(st.id, sourceKey).first();

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
  } catch (_) { /* best-effort — 성적 반영 실패가 제출·채점을 막지 않게 */ }
}

// 응답 삭제(재제출 허용) 시 성적표 잔재 정리 — best-effort, 절대 throw 하지 않는다.
//   upsertTestScore가 만든 행(source_key='quiz:<surveyId>')을 같은 이름 매칭으로 지운다.
//   opts = { surveyId, respondentName }
export async function deleteTestScore(env, opts) {
  try {
    const surveyId = opts && opts.surveyId;
    const name = String((opts && opts.respondentName) || '').trim();
    if (!surveyId || !name) return;
    const st = await getStudentByName(env, name);
    if (!st || !st.id) return;
    await ensureExamScoresTable(env);
    await env.DB.prepare('DELETE FROM exam_scores WHERE student_id=? AND source_key=?')
      .bind(st.id, 'quiz:' + surveyId).run();
  } catch (_) { /* best-effort */ }
}
