// _backup.js — 하루 1회 D1(학생·출결·성적·리포트·계정·질문)을 R2로 자동 백업.
//   목적: 실수 삭제·DB 사고 시 되돌릴 수단(현재 백업이 전혀 없음).
//   저장: backups/{YYYY-MM-DD}.json  (하루 1개, 같은 날 재실행은 덮어씀)
//   보관: 최근 30일. 그보다 오래된 backups/*.json은 자동 삭제.
//   게이트: backups/_last.json에 마지막 백업 날짜(KST)를 남겨 하루 1회만 실행.
//   호출: notices-flush 크론이 매 틱 runDailyBackup(env) — 내부에서 하루1회 게이트가 전담.
//
//   ※ 복구는 Cloudflare R2 대시보드에서 backups/{날짜}.json을 내려받아 사용.
//   ※ accounts에는 로그인 정보가 들어가지만, R2는 이미 모든 민감정보를 담는 같은 신뢰경계라
//      백업 포함이 노출을 키우지 않음(복구엔 필요). qna는 용량 큰 첨부이미지(image/images)만 빼고 저장.

const BK_PREFIX = 'backups/';
const STATE_KEY = 'backups/_last.json';
const KEEP_DAYS = 30;

// 백업 대상 테이블. strip: 백업에서 제외할 컬럼(용량 큰 base64 이미지 등). 없는 테이블은 조용히 건너뜀.
const TABLES = [
  { name: 'students' },
  { name: 'attendance' },
  { name: 'study_sessions' },
  { name: 'exam_scores' },
  { name: 'reports' },
  { name: 'accounts' },
  { name: 'qna', strip: ['image', 'images'] },   // 첨부 이미지(base64)는 너무 커서 제외 — 질문/답변 텍스트는 보존
];

function kstDayStr(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000 - offsetDays * 24 * 60 * 60 * 1000);
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}

async function dumpTable(env, spec) {
  try {
    const { results } = await env.DB.prepare('SELECT * FROM ' + spec.name).all();
    let rows = results || [];
    if (spec.strip && rows.length) {
      rows = rows.map((r) => {
        const c = { ...r };
        for (const k of spec.strip) delete c[k];
        return c;
      });
    }
    return { count: rows.length, rows };
  } catch (e) {
    // 테이블이 없거나 스키마가 다르면 그 테이블만 비워 두고 계속(백업 전체를 실패시키지 않음).
    return { count: 0, rows: [], error: String((e && e.message) || e) };
  }
}

export async function runDailyBackup(env) {
  try {
    if (!env || !env.DB || !env.BUCKET) return { ok: false, reason: 'no-binding' };
    const today = kstDayStr(0);

    // 하루 1회 게이트 — 오늘 이미 했으면 건너뜀.
    let last = null;
    try { const s = await env.BUCKET.get(STATE_KEY); if (s) last = JSON.parse(await s.text()); } catch (_) {}
    if (last && last.date === today) return { ok: true, skipped: true, date: today };

    // 전체 덤프.
    const data = { date: today, createdAt: new Date().toISOString(), tables: {} };
    for (const t of TABLES) data.tables[t.name] = await dumpTable(env, t);

    await env.BUCKET.put(BK_PREFIX + today + '.json', JSON.stringify(data), {
      httpMetadata: { contentType: 'application/json' },
    });
    await env.BUCKET.put(STATE_KEY, JSON.stringify({ date: today, at: new Date().toISOString() }), {
      httpMetadata: { contentType: 'application/json' },
    });

    // 30일 지난 백업 정리(_last.json은 정규식이 날짜 파일만 잡아 보존).
    let deleted = 0;
    try {
      const cutoff = kstDayStr(KEEP_DAYS);
      const listed = await env.BUCKET.list({ prefix: BK_PREFIX });
      for (const o of (listed.objects || [])) {
        const m = o.key.match(/^backups\/(\d{4}-\d{2}-\d{2})\.json$/);
        if (m && m[1] < cutoff) { try { await env.BUCKET.delete(o.key); deleted++; } catch (_) {} }
      }
    } catch (_) {}

    return { ok: true, date: today, deleted };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
