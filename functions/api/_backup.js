// _backup.js — 하루 1회 D1 주요 테이블 전체(학생·출결·성적·리포트·계정·질문·상담문의·
//   클리닉·인강·과제·설문·알림·퇴원생보관·변경이력 등 23개)를 R2로 자동 백업.
//   목적: 실수 삭제·DB 사고 시 되돌릴 수단(현재 백업이 전혀 없음).
//   저장: backups/{YYYY-MM-DD}.json  (하루 1개, 같은 날 재실행은 덮어씀)
//   보관: 최근 30일. 그보다 오래된 backups/*.json은 자동 삭제.
//   게이트: backups/_last.json에 마지막 백업 날짜(KST)를 남겨 하루 1회만 실행.
//   호출: notices-flush 크론이 매 틱 runDailyBackup(env) — 내부에서 하루1회 게이트가 전담.
//
//   ※ 복구는 Cloudflare R2 대시보드에서 backups/{날짜}.json을 내려받아 사용.
//   ※ accounts에는 로그인 정보가 들어가지만, R2는 이미 모든 민감정보를 담는 같은 신뢰경계라
//      백업 포함이 노출을 키우지 않음(복구엔 필요). qna는 용량 큰 첨부이미지(image/images)만 빼고 저장.

//   ※ 감사로그(2026-07-31): 이 파일은 request 를 받지 않는 헬퍼지만, "호출측이 로그를 남긴다"는
//      프로젝트 규칙의 예외다. 유일한 호출측(notices-flush 크론)은 fire-and-forget 으로 결과를 버리고,
//      무엇보다 이 백업은 그 요청을 보낸 사람의 행위가 아니라 **하루 1회 자동 실행**이다.
//      사람에게 귀속시키면 오히려 거짓 기록이 된다 → actor='system' 으로 여기서 직접 남긴다.
//      또한 5분마다 오는 대부분의 틱은 '오늘 이미 함'으로 그냥 돌아가므로, 그건 로그로 남기지 않는다
//      (남기면 하루 288건이 쌓여 변경이력이 하트비트로 뒤덮인다). 실제로 백업을 뜬 날만 1건.
import { logAudit } from './_auditlog.js';

const BK_PREFIX = 'backups/';
const STATE_KEY = 'backups/_last.json';
const KEEP_DAYS = 30;
const MAX_RETRY = 3;   // 불완전 백업을 같은 날 다시 뜨는 최대 횟수(그 이상이면 일시 장애가 아니다)

// 백업 대상 테이블. strip: 백업에서 제외할 컬럼(용량 큰 base64 이미지 등). 없는 테이블은 조용히 건너뜀.
const TABLES = [
  { name: 'students' },
  { name: 'attendance' },
  { name: 'study_sessions' },
  { name: 'exam_scores' },
  { name: 'reports' },
  { name: 'accounts' },
  { name: 'qna', strip: ['image', 'images'] },   // 첨부 이미지(base64)는 너무 커서 제외 — 질문/답변 텍스트는 보존
  // ── 2026-07-29 확대 ── 위 7개만 담고 있어서, 아래 것들은 날아가면 되돌릴 방법이 없었습니다.
  { name: 'inquiries' },              // 홈페이지 상담 문의 = 신규 리드. 잃으면 복구 불가·매출 직결(최우선)
  { name: 'clinic' },                 // 클리닉 출석·성취도·시간
  { name: 'clinic_roster' },          // 클리닉 필수명단
  { name: 'clinic_reviews' },         // 클리닉 총평(초안·발송본)
  { name: 'clinic_day_memo' },        // 클리닉 하루 메모(구형 — v2 이관 후에도 보존분 백업)
  { name: 'clinic_day_memo2' },       // 클리닉 하루 메모 v2 (date,academy) — 2026-07-30 학원별 분리
  { name: 'makeup_grants' },          // 인강(보충영상) 신청·승인 이력
  { name: 'homework_assignments' },   // 과제
  { name: 'homework_submissions' },   // 과제 제출(사진 자체는 R2, 여기엔 photo_keys만이라 가벼움)
  { name: 'surveys' },                // 설문·퀴즈 문항
  { name: 'survey_responses' },       // 설문·퀴즈 응답/채점
  { name: 'notifications' },          // 알림함
  { name: 'student_archive' },        // 퇴원생 보관 기록(성적·출결 스냅샷 포함)
  { name: 'study_prefs' },            // 학생 학습 목표·D-day
  { name: 'app_config' },             // 앱 설정(강제업데이트 최소버전 등)
  { name: 'qna_settings' },           // 질문방 AI 한도 설정
  // ── 2026-07-31 추가 ──
  //   변경이력(감사) 로그. "누가 언제 무엇을 지웠나"가 여기밖에 없으므로 백업에서 빼면 안 된다.
  //   다만 한 파일에 통째로 담는 구조라 무한정 커지면 백업 자체가 터진다.
  //   → 최신 10만 건까지만. D1 원본은 자동삭제가 없으므로 그 이전 것도 DB에는 그대로 남아 있다.
  { name: 'audit_log', limit: 100000 },
  // 일부러 뺀 것: access_events(접근로그 — 대용량이고 복구 가치 낮음)
  //   · login_lockouts(일시적 잠금 상태)
  //   · gate_lockouts(2026-08-03 §11-16 신설. 위와 같은 이유 — 잃어버려도 다음 실패부터 다시 세면 되고,
  //     오히려 복원하면 옛 잠금이 되살아나 정상 학부모가 막힌다. 빠뜨린 게 아니라 뺀 것.)
];

function kstDayStr(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000 - offsetDays * 24 * 60 * 60 * 1000);
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}

async function dumpTable(env, spec) {
  try {
    // limit 이 있으면 최신 것부터 그만큼만(id 내림차순 → 다시 오름차순으로 되돌려 저장).
    const sql = spec.limit
      ? 'SELECT * FROM ' + spec.name + ' ORDER BY id DESC LIMIT ' + Number(spec.limit)
      : 'SELECT * FROM ' + spec.name;
    const { results } = await env.DB.prepare(sql).all();
    let rows = results || [];
    if (spec.limit) rows = rows.slice().reverse();
    if (spec.strip && rows.length) {
      rows = rows.map((r) => {
        const c = { ...r };
        for (const k of spec.strip) delete c[k];
        return c;
      });
    }
    return { count: rows.length, rows };
  } catch (e) {
    // 그 테이블만 비워 두고 계속(백업 전체를 멈추지 않는다). 다만 아래 두 가지는 성격이 전혀 다르다:
    //   missing=true  — 아직 만들어진 적 없는 표(no such table). 정상이다. 재시도해도 똑같다.
    //   missing=false — D1 장애·스키마 오류 등 진짜 실패. **이 표는 오늘 백업에 없다.**
    //     2026-08-03 이전에는 둘을 구분하지 않아, D1이 잠깐 죽은 날에도 「빈 표들의 정상 백업」이
    //     저장되고 하루1회 게이트까지 잠겨 그날은 재시도조차 하지 않았다. 그래서 구분한다.
    const msg = String((e && e.message) || e);
    return { count: 0, rows: [], error: msg, missing: /no such table/i.test(msg) };
  }
}

export async function runDailyBackup(env) {
  try {
    if (!env || !env.DB || !env.BUCKET) return { ok: false, reason: 'no-binding' };
    const today = kstDayStr(0);

    // 하루 1회 게이트 — 오늘 이미 했으면 건너뜀.
    //   단 오늘 백업이 **불완전**(표 일부가 D1 오류로 못 담김)했다면 게이트를 잠그지 않고 다음 틱에서 다시 뜬다.
    //   무한 재시도는 막는다 — 같은 날 MAX_RETRY 번까지만(그 이상은 일시 장애가 아니므로 사람이 봐야 한다).
    let last = null;
    try { const s = await env.BUCKET.get(STATE_KEY); if (s) last = JSON.parse(await s.text()); } catch (_) {}
    const 오늘기록 = last && last.date === today ? last : null;
    if (오늘기록 && !오늘기록.incomplete) return { ok: true, skipped: true, date: today };
    if (오늘기록 && (오늘기록.attempts || 0) >= MAX_RETRY) {
      return { ok: false, skipped: true, date: today, reason: 'incomplete-retry-exhausted', attempts: 오늘기록.attempts };
    }

    // 전체 덤프.
    const 시작 = Date.now();
    const data = { date: today, createdAt: new Date().toISOString(), tables: {} };
    for (const t of TABLES) data.tables[t.name] = await dumpTable(env, t);

    // 로그용 요약 — 표별 건수와 "덤프에 실패한 표"를 뽑아 둔다(추가 조회 없음, 위 결과 재사용).
    //   실패는 두 갈래로 나눈다. 없는표(no such table)는 정상, 진짜실패는 백업이 불완전하다는 뜻이다.
    const 표별건수 = {};
    const 진짜실패 = {};
    const 없는표 = [];
    for (const [k, v] of Object.entries(data.tables)) {
      표별건수[k] = (v && v.count) || 0;
      if (v && v.error) { if (v.missing) 없는표.push(k); else 진짜실패[k] = v.error; }
    }
    const 불완전 = Object.keys(진짜실패).length > 0;
    const 시도 = 불완전 ? ((오늘기록 && 오늘기록.attempts) || 0) + 1 : 0;

    // 백업 파일 자체에도 표식을 남긴다 — 나중에 이 파일을 열어 복구할 때 "이거 온전한가"를 파일만 보고 알 수 있어야 한다.
    data.incomplete = 불완전;
    if (불완전) { data.failedTables = 진짜실패; data.attempt = 시도; }
    const 본문 = JSON.stringify(data);

    // 불완전해도 저장은 한다(없는 것보다 낫다). 대신 아래 게이트를 잠그지 않아 다음 틱에서 다시 뜬다.
    await env.BUCKET.put(BK_PREFIX + today + '.json', 본문, {
      httpMetadata: { contentType: 'application/json' },
    });
    await env.BUCKET.put(STATE_KEY, JSON.stringify({
      date: today, at: new Date().toISOString(),
      incomplete: 불완전, attempts: 시도,
    }), {
      httpMetadata: { contentType: 'application/json' },
    });

    // 30일 지난 백업 정리(_last.json은 정규식이 날짜 파일만 잡아 보존).
    //   ⚠️ 오늘 백업이 불완전한 날에는 정리를 건너뛴다 — 오늘 것이 성치 않은데 과거 것까지 지우면
    //      방어선이 두 겹으로 무너진다. 하루 미뤄도 잃는 건 없다.
    let deleted = 0;
    const 지운백업키 = [];   // 되돌릴 수 없는 삭제 — 어떤 날짜가 사라졌는지 남긴다
    try {
      if (불완전) throw new Error('불완전 백업 — 오래된 백업 정리 보류');
      const cutoff = kstDayStr(KEEP_DAYS);
      const listed = await env.BUCKET.list({ prefix: BK_PREFIX });
      for (const o of (listed.objects || [])) {
        const m = o.key.match(/^backups\/(\d{4}-\d{2}-\d{2})\.json$/);
        if (m && m[1] < cutoff) {
          try {
            await env.BUCKET.delete(o.key);
            deleted++;
            if (지운백업키.length < 60) 지운백업키.push(o.key);
          } catch (_) {}
        }
      }
    } catch (_) {}

    // 📓 하루 1건 — 실제로 백업을 뜬 날만. (크론이 조용히 멈춰 백업이 며칠 비면 이 로그의 공백이 증거가 된다)
    await logAudit(env, null, {
      action: 불완전 ? 'backup.daily.incomplete' : 'backup.daily',
      actor: 'system', actorRole: 'system', actorName: '자동 백업(하루 1회)',
      target: BK_PREFIX + today + '.json',
      path: 'cron runDailyBackup() ← /api/notices-flush',
      // 🔴 불완전은 summary 맨 앞에서 바로 보이게 한다 — detail을 펼쳐야 알 수 있으면 아무도 모른다.
      summary: (불완전
          ? '⚠️ 불완전 백업 — ' + Object.keys(진짜실패).length + '개 표를 못 담음('
            + Object.keys(진짜실패).join(', ') + ') · ' + 시도 + '/' + MAX_RETRY + '차 시도 · '
          : '')
        + 'D1 전체 백업 저장 [' + today + '] — 표 ' + Object.keys(표별건수).length + '개 · 총 '
        + Object.values(표별건수).reduce((a, b) => a + b, 0) + '행 · '
        + Math.round(본문.length / 1024) + 'KB'
        + (deleted ? ' · 30일 지난 백업 ' + deleted + '개 삭제' : ''),
      detail: {
        저장위치: BK_PREFIX + today + '.json',
        온전한백업인가: 불완전 ? '아니오 — 아래 「덤프실패표」의 표들이 이 백업에 없다' : '예',
        표별건수: 표별건수,
        총행수: Object.values(표별건수).reduce((a, b) => a + b, 0),
        크기KB: Math.round(본문.length / 1024),
        덤프실패표: 불완전 ? 진짜실패 : '없음',
        아직만들어지지않은표: 없는표.length ? 없는표 : '없음',
        재시도: 불완전
          ? { 이번시도: 시도, 최대: MAX_RETRY, 다음: 시도 >= MAX_RETRY
              ? '⚠️ 재시도 소진 — 오늘은 더 시도하지 않는다. 사람이 D1 상태를 확인해야 한다.'
              : '하루1회 게이트를 잠그지 않았으므로 다음 크론 틱에서 다시 뜬다.' }
          : '해당 없음',
        오래된백업삭제: { 건수: deleted, 보관일수: KEEP_DAYS, 지운키: 지운백업키, 키잘림: deleted > 60 },
        걸린시간초: Math.round((Date.now() - 시작) / 100) / 10,
        효과: 불완전
          ? '⚠️ 이 백업 파일에는 위 「덤프실패표」의 표들이 들어 있지 않다(파일 안에도 incomplete:true 표식을 남겼다). '
            + '오늘 그 표들에서 사고가 나면 이 파일로는 되돌릴 수 없다 — 어제 백업까지 거슬러야 한다. '
            + '오래된 백업 정리는 오늘 건너뛰었다(방어선을 두 겹 무너뜨리지 않기 위해).'
          : '오늘 시점의 D1 전체(학생·출결·성적·리포트·계정·문의·변경이력 등)를 R2 한 파일에 굳혔다. '
            + '실수로 지운 데이터는 이 파일에서 되돌릴 수 있다. 같은 날 다시 돌리면 이 파일을 덮어쓴다. '
            + (deleted ? '동시에 ' + KEEP_DAYS + '일보다 오래된 백업 ' + deleted + '개는 영구 삭제됐다 — 그 날짜로는 더 이상 복구할 수 없다.' : ''),
        비고: 'accounts 표에는 로그인 비밀번호 해시가 들어가지만 이 로그에는 건수만 남기고 값은 담지 않는다. '
          + 'qna 첨부이미지·access_events·login_lockouts·gate_lockouts 는 백업 대상에서 일부러 뺐다.',
      },
    });

    return { ok: !불완전, date: today, deleted, incomplete: 불완전,
      failed: Object.keys(진짜실패), attempts: 시도 };
  } catch (e) {
    // 백업이 실패한 날은 반드시 남는다 — "그날 백업이 없다"를 나중에 설명할 수 있는 유일한 근거.
    await logAudit(env, null, {
      action: 'backup.daily.fail',
      actor: 'system', actorRole: 'system', actorName: '자동 백업(하루 1회)',
      target: BK_PREFIX + kstDayStr(0) + '.json',
      path: 'cron runDailyBackup() ← /api/notices-flush',
      summary: 'D1 자동 백업 실패 [' + kstDayStr(0) + '] — ' + String((e && e.message) || e).slice(0, 120),
      detail: {
        오류: String((e && e.message) || e),
        효과: '⚠️ 오늘 날짜 백업 파일이 없거나 불완전하다. 오늘 사고가 나면 되돌릴 지점이 어제 백업까지다. '
          + '하루 1회 게이트(backups/_last.json)가 갱신되지 않았다면 다음 크론 틱에서 자동 재시도된다.',
      },
    });
    return { ok: false, error: String((e && e.message) || e) };
  }
}
