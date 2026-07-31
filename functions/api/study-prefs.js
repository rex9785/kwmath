// /api/study-prefs — KW-Study 개인 설정 (목표 시간 + 개인 디데이)
// ───────────────────────────────────────────────────────────
// D1 table: study_prefs (student_id PK). 학생 1명당 1행.
// 인증: requireStudentAccess. GET=학생·학부모(자녀 ?name=), POST=학생 본인만.
//
//  GET  ?name=홍길동  → { ok, weeklyGoal, dailyGoal, ddays:[{label,date}] }
//  POST { weeklyGoal?, dailyGoal?, ddays? }  (학생 본인) → 저장
//     weeklyGoal: 0~6000(분, 0=해제) · dailyGoal: 0~960 · ddays: [{label(≤20), date 'YYYY-MM-DD'}] 최대 10개
// ───────────────────────────────────────────────────────────
import { requireStudentAccess } from './_auth.js';
import { getStudentsByPhone } from './_db.js';
import { logAudit, diffFields } from './_auditlog.js';

const MAX_WEEKLY = 6000;   // 100시간
const MAX_DAILY  = 960;    // 16시간
const MAX_DDAYS  = 10;

async function ensureTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS study_prefs (' +
    'student_id INTEGER PRIMARY KEY, weekly_goal INTEGER, daily_goal INTEGER, ' +
    'ddays_json TEXT, updated_at TEXT)'
  ).run();
}

async function resolveStudentId(env, phone, name) {
  const list = await getStudentsByPhone(env, phone);
  const me = list.find(s => s.name === name) || (list.length === 1 ? list[0] : null);
  return me ? me.id : null;
}

function parseDdays(raw) {
  let arr = [];
  try { arr = JSON.parse(raw || '[]'); } catch (_) { arr = []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(d => d && d.date)
    .map(d => ({ label: String(d.label || '').slice(0, 20), date: String(d.date).slice(0, 10) }))
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    .slice(0, MAX_DDAYS);
}

// 로그 전용 — 디데이 목록을 사람이 읽는 한 줄로. ("수능 2026-11-19 · 기말고사 2026-06-30")
//   JSON 원문을 그대로 남기면 나중에 눈으로 비교가 안 된다.
function ddaysText(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return '(없음)';
  return arr.map(d => (d.label || '(제목없음)') + ' ' + d.date).join(' · ').slice(0, 400);
}

function clampInt(v, min, max, dflt) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

export async function onRequest({ request, env }) {
  const access = await requireStudentAccess(env, request);
  if (!access.ok) return access.response;

  try { await ensureTable(env); }
  catch (e) { return Response.json({ error: '설정 DB 초기화 실패' }, { status: 500 }); }

  let studentId;
  try { studentId = await resolveStudentId(env, access.phone, access.student.name); }
  catch (e) { return Response.json({ error: '학생 식별 실패' }, { status: 500 }); }
  if (!studentId) return Response.json({ error: '학생 정보를 찾을 수 없습니다.' }, { status: 404 });

  // ── GET ──
  if (request.method === 'GET') {
    try {
      const row = await env.DB.prepare(
        'SELECT weekly_goal, daily_goal, ddays_json FROM study_prefs WHERE student_id=?'
      ).bind(studentId).first();
      return Response.json({
        ok: true,
        weeklyGoal: row && row.weekly_goal != null ? row.weekly_goal : 0,
        dailyGoal:  row && row.daily_goal  != null ? row.daily_goal  : 0,
        ddays: row ? parseDdays(row.ddays_json) : [],
      });
    } catch (e) {
      return Response.json({ error: '설정을 불러오지 못했습니다.' }, { status: 500 });
    }
  }

  // ── POST (학생 본인만) ──
  if (request.method === 'POST') {
    if (access.student.role !== 'student') {
      // ⚠️ 2026-07-31 — 학부모가 자녀 목표를 대신 설정하려다 막힌 경우가 아무 데도 안 남았다.
      //   "목표를 설정했는데 저장이 안 된다"는 문의가 오면 권한 때문에 막힌 건지 앱 오류인지 구분할 근거가 없었다.
      await logAudit(env, request, {
        action: 'study.prefs.update.reject',
        actor: access.phone,
        actorRole: access.student.role === 'parent' ? 'parent' : 'other',
        actorName: (access.student.name || '') + ' ' + (access.student.role === 'parent' ? '학부모' : '보호자'),
        target: String(studentId), targetName: access.student.name || '',
        summary: '[' + (access.student.name || studentId) + '] 학습 목표 설정 거부(403) — 학생 본인 계정이 아님',
        detail: {
          학생id: String(studentId), 이름: access.student.name || '',
          시도한계정관계: access.student.role || '(알 수 없음)',
          결과: '저장 안 됨 — 기존 목표/디데이 그대로 유지',
        },
      });
      return Response.json({ error: '학생 본인 계정에서만 목표를 설정할 수 있어요.' }, { status: 403 });
    }
    let body = {};
    try { body = await request.json(); } catch (_) {}

    // 기존값 로드 (부분 업데이트 지원)
    let cur = { weekly_goal: 0, daily_goal: 0, ddays_json: '[]' };
    let hadRow = false;      // 로그용 — 이번이 첫 저장인지, 있던 값을 덮어쓰는 건지
    let curReadErr = '';     // 로그용 — 전(前)값을 못 읽은 것과 "원래 없었음"은 전혀 다른 사건이다
    try {
      const row = await env.DB.prepare(
        'SELECT weekly_goal, daily_goal, ddays_json FROM study_prefs WHERE student_id=?'
      ).bind(studentId).first();
      if (row) { cur = row; hadRow = true; }
    } catch (e) { curReadErr = String((e && e.message) || e).slice(0, 120); }

    const weeklyGoal = body.weeklyGoal !== undefined ? clampInt(body.weeklyGoal, 0, MAX_WEEKLY, 0) : (cur.weekly_goal || 0);
    const dailyGoal  = body.dailyGoal  !== undefined ? clampInt(body.dailyGoal,  0, MAX_DAILY,  0) : (cur.daily_goal  || 0);
    let ddaysJson = cur.ddays_json || '[]';
    if (body.ddays !== undefined) {
      const cleaned = parseDdays(JSON.stringify(Array.isArray(body.ddays) ? body.ddays : []));
      ddaysJson = JSON.stringify(cleaned);
    }
    const now = new Date().toISOString();

    // 🔎 2026-07-31 — 아래 upsert는 이전 값을 그대로 덮어쓴다(study_prefs는 학생당 1행, 현재 상태만 보관).
    //   덮기 전 값을 여기서 숫자·문자열로 떠 둔다. 저장이 실패해도 "무엇을 무엇으로 바꾸려 했는지"가 남는다.
    const logBefore = {
      '주간 목표(분)': cur.weekly_goal || 0,
      '하루 목표(분)': cur.daily_goal || 0,
      '개인 디데이': ddaysText(parseDdays(cur.ddays_json)),
    };
    const logAfter = {
      '주간 목표(분)': weeklyGoal,
      '하루 목표(분)': dailyGoal,
      '개인 디데이': ddaysText(parseDdays(ddaysJson)),
    };
    const d = diffFields(logBefore, logAfter);
    const sentFields = [];
    if (body.weeklyGoal !== undefined) sentFields.push('주간 목표');
    if (body.dailyGoal !== undefined) sentFields.push('하루 목표');
    if (body.ddays !== undefined) sentFields.push('개인 디데이');

    try {
      await env.DB.prepare(
        'INSERT INTO study_prefs (student_id, weekly_goal, daily_goal, ddays_json, updated_at) VALUES (?,?,?,?,?) ' +
        'ON CONFLICT(student_id) DO UPDATE SET weekly_goal=excluded.weekly_goal, daily_goal=excluded.daily_goal, ' +
        'ddays_json=excluded.ddays_json, updated_at=excluded.updated_at'
      ).bind(studentId, weeklyGoal, dailyGoal, ddaysJson, now).run();

      // 📓 2026-07-31 — study_prefs는 학생당 1행짜리 "현재 상태" 표라 덮어쓰면 옛 목표가 그냥 사라진다.
      //   "지난달엔 주간 목표가 몇 분이었지 / 디데이를 언제 지웠지"를 되짚을 방법이 아예 없었다.
      //   아무것도 안 바뀐 저장도 남긴다 — 학생이 누른 저장 버튼이 서버까지 닿았는지 확인할 유일한 근거다.
      await logAudit(env, request, {
        action: 'study.prefs.update',
        actor: String(studentId), actorRole: 'student', actorName: access.student.name || '',
        target: String(studentId), targetName: access.student.name || '',
        summary: '[' + (access.student.name || studentId) + '] 공부 목표·디데이 저장 — '
          + (d.요약 || '바뀐 값 없음(같은 값을 다시 저장)'),
        detail: {
          학생id: String(studentId), 이름: access.student.name || '',
          이전기록: hadRow ? '있었음(덮어씀)' : '없었음(이번이 첫 저장)',
          보낸칸: sentFields.length ? sentFields : ['(없음 — 기존값 그대로 다시 저장)'],
          바뀐칸: d.바뀐칸, 변경: d.변경,
          전값읽기: curReadErr ? '실패 — ' + curReadErr + ' (전 값은 0/빈칸으로 간주됐으니 이 로그의 전값은 못 믿음)' : '정상',
          저장시각: now,
          비고: d.바뀐칸.length ? '' : '값은 그대로지만 updated_at은 갱신됨',
        },
      });
      return Response.json({ ok: true, weeklyGoal, dailyGoal, ddays: parseDdays(ddaysJson) });
    } catch (e) {
      // ⚠️ 2026-07-31 — 저장 실패가 화면 에러 한 줄로만 뜨고 사라졌다. 학생이 "목표 설정했는데 없어졌다"고 해도
      //   시도 자체가 없었던 것과 구분이 안 됐다. 무엇을 저장하려다 실패했는지 통째로 남긴다.
      await logAudit(env, request, {
        action: 'study.prefs.update.fail',
        actor: String(studentId), actorRole: 'student', actorName: access.student.name || '',
        target: String(studentId), targetName: access.student.name || '',
        summary: '[' + (access.student.name || studentId) + '] 공부 목표·디데이 저장 실패(500) — 기존값 유지됨',
        detail: {
          학생id: String(studentId), 이름: access.student.name || '',
          저장하려던값: logAfter, 기존값: logBefore,
          이전기록: hadRow ? '있었음' : '없었음',
          보낸칸: sentFields.length ? sentFields : ['(없음)'],
          DB오류: String((e && e.message) || e).slice(0, 300),
          결과: '저장 안 됨 — 학생 화면엔 "설정 저장에 실패했습니다."만 표시됨',
        },
      });
      return Response.json({ error: '설정 저장에 실패했습니다.' }, { status: 500 });
    }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
}
