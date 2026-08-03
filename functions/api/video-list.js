import { safeError } from './_errors.js';
// GET /api/video-list  (admin only)
// R2의 모든 video-codes JSON 목록 반환 — admin.html 영상 관리 탭용
//
// 📓 2026-08-03 — 열람자 명단은 R2 파일 + 변경이력(D1 audit_log)을 **합쳐서** 만든다.
//   왜: 영상 파일 안의 access_log 는 "읽고 → 고치고 → 통째로 다시 쓰기" 방식이라,
//       두 사람이 같은 영상을 동시에 열면 한 명의 줄이 조용히 덮여 사라졌다(수업 직후에 잘 생긴다).
//       같은 날 video-access.js 에 조건부 쓰기를 넣어 앞으로는 안 사라지지만,
//       **그 전에 사라진 줄은 영상 파일에 이미 없다.**
//   그런데 2026-07-31부터는 열람 한 건이 감사로그에 한 줄씩 따로 쌓인다 — 덮어쓰기의 영향을 안 받는다.
//   → 둘을 합치면 사라졌던 줄이 되살아나고, 앞으로도 어느 한쪽이 비어도 명단이 안 빈다.
//   같은 열람이 양쪽에 있으면 한 줄로 친다(같은 이름·같은 구분이 5분 안이면 같은 열람 —
//   video-access.js 의 중복 판정 규칙과 똑같이 맞춰 뒀다).

const 감사조회건수 = 3000;          // 실제 열람(시청·수업코드)을 D1에서 몇 줄까지 끌어올지
const 목록열람건수 = 1500;          // 「목록만 열었다」는 상한을 따로 둔다 — 이게 실제 열람 기록을 밀어내면 안 된다
const 중복시간 = 5 * 60 * 1000;     // 이 시간 안의 같은 사람 = 같은 열람 (video-access.js 와 동일)

// 같은 열람이 두 경로로 잡히면 "더 센 쪽"이 이긴다 — 목록만 연 것보다 실제로 본 것이 진실에 가깝다.
//   (안 그러면 목록을 열고 바로 영상을 본 사람이 「목록열람」으로만 남아 시청자 수가 줄어든다.)
const via강도 = { watch: 3, code: 2, open: 1 };
function 센via(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return (via강도[b] || 0) > (via강도[a] || 0) ? b : a;
}

// 감사로그에서 영상코드별 열람기록을 끌어온다.
//   실패해도 영상 목록 자체는 떠야 하므로 조용히 null 을 돌려주고, 부르는 쪽이 옛 방식으로 되돌아간다.
async function 감사열람기록(env) {
  try {
    const 실제열람 = env.DB.prepare(
      'SELECT ts, actor, actor_role, actor_name, target, '
      + "CASE WHEN json_valid(detail) THEN json_extract(detail, '$.열람경로코드') ELSE NULL END AS via, "
      + "CASE WHEN json_valid(detail) THEN json_extract(detail, '$.누가.학생번호') ELSE NULL END AS student_id "
      + "FROM audit_log WHERE action = 'video.access.log' ORDER BY id DESC LIMIT ?"
    ).bind(감사조회건수);
    // 📓 2026-08-03(§11-8) — 「목록 열람」은 이제 영상 파일(R2)에 안 쓰고 감사로그에만 남는다.
    //   여기서 같이 끌어와야 관우T 화면에 계속 보인다. detail 모양이 달라 학생번호 경로도 다르다.
    const 목록열람 = env.DB.prepare(
      "SELECT ts, actor, actor_role, actor_name, target, 'open' AS via, "
      + "CASE WHEN json_valid(detail) THEN json_extract(detail, '$.학생.학생ID') ELSE NULL END AS student_id "
      + "FROM audit_log WHERE action = 'video.list.open' ORDER BY id DESC LIMIT ?"
    ).bind(목록열람건수);
    const [실제, 목록] = await env.DB.batch([실제열람, 목록열람]);
    const byCode = new Map();
    for (const r of [].concat((실제 && 실제.results) || [], (목록 && 목록.results) || [])) {
      const code = String(r.target || '').toUpperCase();
      if (!code) continue;
      // 'anon' · 'unknown' · 'admin-key' 는 화면에서 '비로그인'으로 보여주므로 null 로 눕힌다.
      const role = (r.actor_role === 'parent' || r.actor_role === 'student' || r.actor_role === 'other')
        ? r.actor_role : null;
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push({
        name:       r.actor_name || '익명',
        role,
        student_id: r.student_id != null ? r.student_id : null,
        phone:      r.actor || null,
        via:        r.via || null,
        time:       r.ts,
      });
    }
    return byCode;
  } catch (_) {
    return null;   // 감사로그를 못 읽음 → 옛 방식(R2만)으로 표시
  }
}

// 같은 열람이 R2와 감사로그 양쪽에 있으면 한 줄로 합친다. 한쪽에만 있는 칸은 서로 채워 준다.
function 열람기록합치기(r2로그, 감사로그) {
  const 전부 = [].concat(r2로그 || [], 감사로그 || [])
    .filter(e => e && e.time)
    .sort((x, y) => String(x.time).localeCompare(String(y.time)));   // 오래된 것부터 (화면이 뒤집어 쓴다)
  const 남길것 = [];
  for (const e of 전부) {
    const 같은열람 = 남길것.find(k =>
      (k.name || '') === (e.name || '')
      && (k.role || null) === (e.role || null)
      && Math.abs(new Date(k.time).getTime() - new Date(e.time).getTime()) <= 중복시간
    );
    if (같은열람) {
      같은열람.via = 센via(같은열람.via, e.via);   // 시청 > 수업코드 > 목록열람
      if (같은열람.student_id == null && e.student_id != null) 같은열람.student_id = e.student_id;
      if (!같은열람.phone && e.phone) 같은열람.phone = e.phone;
      continue;
    }
    남길것.push({ ...e });
  }
  return 남길것;
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET')
    return Response.json({ error: 'GET만 허용' }, { status: 405 });

  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  try {
    const 감사 = await 감사열람기록(env);   // null 이면 감사로그를 못 읽은 것 (R2만으로 표시)
    const listed = await env.BUCKET.list({ prefix: 'video-codes/', limit: 500 });
    const videos = [];
    for (const obj of listed.objects || []) {
      try {
        const item = await env.BUCKET.get(obj.key);
        if (!item) continue;
        const data = await item.json();
        const r2로그 = Array.isArray(data.access_log) ? data.access_log : [];
        const 합친로그 = 감사
          ? 열람기록합치기(r2로그, 감사.get(String(data.code || '').toUpperCase()) || [])
          : r2로그.slice();
        videos.push({
          code:         data.code,
          youtube_url:  data.youtube_url,
          title:        data.title || '',
          date:         data.date || '',
          school:       data.school || '',
          class_name:   data.class_name || '',
          active:       data.active !== false,
          require_code: data.require_code === true,
          // 파일에 적힌 누적 횟수와 실제로 보여줄 줄 수 중 큰 쪽. 예전에 덮여 사라진 줄이
          // 감사로그에서 되살아나면 줄 수가 더 많을 수 있고, 그때는 그게 진짜에 가깝다.
          access_count: Math.max(data.access_count || 0, 합친로그.length),
          access_log:   합친로그.slice(-30),  // 누가 봤는지(학부모/학생) 표시용, 최근 30개
          access_source: 감사 ? 'r2+audit' : 'r2',
          created_at:   data.created_at || '',
        });
      } catch {}
    }
    videos.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return Response.json({ ok: true, videos });
  } catch (e) {
    return safeError(e, null, { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
