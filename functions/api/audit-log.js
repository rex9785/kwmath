// /api/audit-log — 변경이력(감사로그) 열람 · **원장 전용**
// ═══════════════════════════════════════════════════════════════════════════
// 왜 만들었나 (2026-07-31)
//   지난 며칠간 60여 개 API에 logAudit을 심어 "누가 · 언제 · 무엇을 · 어떻게 바꿨는지"를
//   audit_log 표에 쌓기 시작했다. 그런데 **읽는 방법이 없었다.**
//   아무도 못 읽는 로그는 로그가 아니다. 이 파일이 그 유일한 창구다.
//
// 🔴 왜 원장 전용인가
//   이 표에는 조교가 무엇을 만졌는지, 학생 비밀번호가 언제 초기화됐는지,
//   관리자 로그인이 언제 성공했는지, 삭제된 데이터의 원본값(before)이 전부 들어 있다.
//   조교에게 열면 (a) 다른 조교의 근무·행동을 서로 들여다보게 되고
//   (b) before 값에 담긴 학생 개인정보가 통째로 새어나간다.
//   → _middleware.js 의 STAFF_GET_BLOCK 에 '/api/audit-log' 를 넣어 조교 GET을 막고,
//     여기서도 X-Kw-Actor-Role 로 한 번 더 확인한다(이중 잠금 — 미들웨어만 믿지 않는다).
//
// 📓 열람 자체는 로그로 남기지 않는다(거절만 남긴다)
//   화면을 새로고침할 때마다 audit.view 가 쌓이면, 정작 봐야 할 기록이 열람기록에 파묻힌다.
//   대신 **거절된 접근(audit.view.denied)** 은 남긴다 — 그게 진짜 알아야 할 사건이다.
//
// 사용법 (전부 GET)
//   /api/audit-log?limit=50&offset=0              최근순 목록 (detail 제외 — 목록이 무거워지므로)
//   /api/audit-log?id=123                         한 건의 전체 내용 (detail 포함)
//   /api/audit-log?facets=1                       필터 드롭다운용 — action·행위자 목록 + 전체 건수
//   필터: from=YYYY-MM-DD  to=YYYY-MM-DD  (한국시각 기준, 양끝 포함)
//         action=student.        (점으로 끝나면 앞자리 일치 = 그 계열 전부)
//         actor=010-0000-0000    role=owner|staff|student|parent|system|anonymous
//         target=24              q=자유검색어(요약·이름·action·경로)
//         fails=1                실패/거절/차단 계열만 (.fail .denied .reject .locked .blocked)
// ═══════════════════════════════════════════════════════════════════════════
import { safeError } from './_errors.js';
import { logAudit } from './_auditlog.js';

const MAX_LIMIT = 200;

// 한국시각 날짜(YYYY-MM-DD) → UTC ISO 문자열. ts 는 UTC ISO8601 로 저장돼 있다.
//   from 은 그날 00:00 KST, to 는 그 다음날 00:00 KST (= to 당일을 포함).
function kstDateToUtcIso(ymd, plusDays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return null;
  const t = Date.parse(ymd + 'T00:00:00+09:00');
  if (Number.isNaN(t)) return null;
  return new Date(t + (plusDays || 0) * 86400000).toISOString();
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return Response.json({ error: 'GET만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  const role = request.headers.get('X-Kw-Actor-Role') || '';   // 미들웨어가 붙인 값(외부 주입은 세척됨)
  const staffPhone = request.headers.get('X-Staff-Phone') || '';

  // 🔒 이중 잠금 — 관리자 인증을 통과했더라도 '조교'로 번역된 요청이면 거절.
  if (!isAdmin || role === 'staff' || staffPhone) {
    await logAudit(env, request, {
      action: 'audit.view.denied',
      target: '__audit_log__', targetName: '변경이력(감사로그)',
      summary: '감사로그 열람 거절 — ' + (isAdmin ? '조교 권한으로는 볼 수 없음' : '관리자 인증 실패'),
      detail: {
        사유: isAdmin ? '조교(ast_) 세션이라 차단' : '관리자 비밀번호/세션이 아님',
        조교번호: staffPhone || '(없음)',
        역할헤더: role || '(없음)',
        효과: '아무것도 보여주지 않음',
        비고: '감사로그에는 삭제된 데이터의 원본값과 학생 개인정보가 들어 있어 원장만 볼 수 있다. '
          + '이 기록이 쌓이면 누군가 로그를 들여다보려 한다는 뜻이다.',
      },
    });
    return Response.json({ error: '원장만 볼 수 있어요.' }, { status: 403 });
  }

  const url = new URL(request.url);
  const p = url.searchParams;

  try {
    // ── 한 건 상세 (detail 포함) ──
    const idOne = (p.get('id') || '').trim();
    if (idOne) {
      if (!/^\d+$/.test(idOne)) return Response.json({ error: 'id는 숫자' }, { status: 400 });
      const row = await env.DB.prepare('SELECT * FROM audit_log WHERE id = ?').bind(Number(idOne)).first();
      if (!row) return Response.json({ error: '그 번호의 기록이 없습니다.' }, { status: 404 });
      let detail = null;
      try { detail = row.detail ? JSON.parse(row.detail) : null; }
      catch (_) { detail = { '(JSON 파싱 실패 — 원문 그대로)': String(row.detail || '') }; }
      return Response.json({ ok: true, row: { ...row, detail } });
    }

    // ── 공통 WHERE 조립 ──
    const where = [];
    const vals = [];

    const fromIso = kstDateToUtcIso(p.get('from'), 0);
    const toIso = kstDateToUtcIso(p.get('to'), 1);           // to 당일 포함
    if (fromIso) { where.push('ts >= ?'); vals.push(fromIso); }
    if (toIso) { where.push('ts < ?'); vals.push(toIso); }

    const action = (p.get('action') || '').trim();
    if (action) {
      // 'student.' 처럼 점으로 끝나면 그 계열 전부, 아니면 정확히 그 action.
      if (action.endsWith('.')) { where.push('action LIKE ?'); vals.push(action + '%'); }
      else { where.push('action = ?'); vals.push(action); }
    }

    const actor = (p.get('actor') || '').trim();
    if (actor) { where.push('actor = ?'); vals.push(actor); }

    const roleF = (p.get('role') || '').trim();
    if (roleF) { where.push('actor_role = ?'); vals.push(roleF); }

    const target = (p.get('target') || '').trim();
    if (target) { where.push('target = ?'); vals.push(target); }

    // 실패·거절 계열만 — "뭐가 안 됐나"를 볼 때 쓴다.
    if (p.get('fails') === '1') {
      where.push("(action LIKE '%.fail%' OR action LIKE '%.denied%' OR action LIKE '%.reject%' "
        + "OR action LIKE '%.locked%' OR action LIKE '%.blocked%' OR action LIKE '%.miss%')");
    }

    // 자유검색 — 요약·이름·action·경로. detail 까지 뒤지면 느려져서 뺐다(정확히 찾고 싶으면 target/actor 필터를 쓴다).
    const q = (p.get('q') || '').trim();
    if (q) {
      const like = '%' + q.replace(/[%_]/g, (m) => '\\' + m) + '%';
      where.push("(summary LIKE ? ESCAPE '\\' OR actor_name LIKE ? ESCAPE '\\' OR target_name LIKE ? ESCAPE '\\' "
        + "OR action LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')");
      vals.push(like, like, like, like, like, like, like);
    }
    const whereSql = where.length ? (' WHERE ' + where.join(' AND ')) : '';

    // ── 필터 드롭다운용 목록 ──
    if (p.get('facets') === '1') {
      const [acts, actors, roles, cnt, span] = await Promise.all([
        env.DB.prepare('SELECT action, COUNT(*) n FROM audit_log' + whereSql + ' GROUP BY action ORDER BY n DESC LIMIT 300').bind(...vals).all(),
        env.DB.prepare('SELECT actor, actor_name, actor_role, COUNT(*) n FROM audit_log' + whereSql + ' GROUP BY actor, actor_name, actor_role ORDER BY n DESC LIMIT 200').bind(...vals).all(),
        env.DB.prepare('SELECT actor_role, COUNT(*) n FROM audit_log' + whereSql + ' GROUP BY actor_role ORDER BY n DESC').bind(...vals).all(),
        env.DB.prepare('SELECT COUNT(*) n FROM audit_log' + whereSql).bind(...vals).first(),
        env.DB.prepare('SELECT MIN(ts) first_ts, MAX(ts) last_ts FROM audit_log').first(),
      ]);
      return Response.json({
        ok: true,
        총건수: (cnt && cnt.n) || 0,
        기간: { 처음: (span && span.first_ts) || '', 마지막: (span && span.last_ts) || '' },
        actions: acts.results || [],
        actors: actors.results || [],
        roles: roles.results || [],
      });
    }

    // ── 목록 (detail 제외 — 한 건이 최대 2만자라 목록에 실으면 응답이 터진다) ──
    let limit = parseInt(p.get('limit') || '50', 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 50;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;
    let offset = parseInt(p.get('offset') || '0', 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const [list, cnt] = await Promise.all([
      env.DB.prepare(
        'SELECT id, ts, action, actor, actor_role, actor_name, target, target_name, summary, path, device, country, '
        + 'LENGTH(detail) detail_len FROM audit_log' + whereSql + ' ORDER BY id DESC LIMIT ? OFFSET ?'
      ).bind(...vals, limit, offset).all(),
      env.DB.prepare('SELECT COUNT(*) n FROM audit_log' + whereSql).bind(...vals).first(),
    ]);

    return Response.json({
      ok: true,
      총건수: (cnt && cnt.n) || 0,
      limit, offset,
      rows: list.results || [],
    });
  } catch (e) {
    return safeError(e, env, { message: '변경이력을 불러오지 못했습니다.' });
  }
}
