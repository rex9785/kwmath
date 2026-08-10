// /api/outcomes  (admin only) — 「지운 기록」 조회·숨김·삭제
// ───────────────────────────────────────────────────────────
// ⚠️ 2026-08-10 — 화면 이름이 「퇴원생 기록」 → 「지운 기록」으로 바뀌었다. 여기 담기는 건
//    **계정까지 지운 학생**뿐이다. 그냥 그만둔 학생은 「수료」·「졸업」으로 빠지므로 students 행에
//    그대로 남고 이 테이블엔 오지 않는다. 옛 주석의 "퇴원"은 전부 "계정 삭제"로 읽으면 된다.
// GET  : student_archive(실명·전화·성적·출결·학습 전체)를 최근 삭제 순으로 돌려준다.
//        (hidden=1 행도 포함해서 돌려줌 — 화면에서 '숨김 보기'로 분리 표시)
//        ⚠️ 목록에는 profile_json 을 안 실어 보낸다(has_profile 0/1 만).
// GET ?id=N : 그 1건 + profile_json 을 한글 라벨로 펼친 profile 을 돌려준다 = 「소환」.
//        희망대학·상담메모·유입경로 등은 여기서만 나온다(2026-08-05 관우T 요청).
//   via='admin' : 관리자가 「기록 삭제」한 분 / via='app' : 앱 자가탈퇴분(앱에선 삭제됨, 기록만 보존)
// POST : { action:'hide'|'unhide', id }  → hidden 플래그만 토글(기록은 보존, 복구 가능)
//        { action:'delete', id }         → 그 행을 DB에서 영구 삭제(복구 불가)
// 인증: Authorization: Bearer <ADMIN_PASSWORD>  (admin-scores.html과 동일 방식)
// ───────────────────────────────────────────────────────────
// 배포 push 테스트 — 2026-06-11 (확인용 한 줄, 지워도 됨)
import { ensureArchiveTable } from './_outcomes.js';
import { logAudit } from './_auditlog.js';

// ── 소환용 라벨(2026-08-05) ───────────────────────────────────
// profile_json = 퇴원 직전 students 행 통째. 컬럼명 그대로면 읽기 어려워 한글로 펼쳐 준다.
// 퇴원생 목록 화면에는 이 상세를 뿌리지 않는다(관우T 2026-08-05) — 필요할 때 ?id=N 으로만 꺼낸다.
const PROFILE_LABELS = {
  name: '이름', school: '학교', grade: '학년', created_at: '등록일',
  parent_phone: '학부모 전화', student_phone: '학생 전화',
  parent_relation: '학부모 관계', parent_last4: '학부모 번호 뒷4자리',
  academy: '학원', class_name: '반',
  cur_math_grade: '현재 수학 수준',
  mock_math_grade: '모의 수학 등급', mock_math_raw: '모의 수학 원점수',
  mock_kor_grade: '모의 국어 등급', mock_eng_grade: '모의 영어 등급',
  school_math_grade: '학교 수학 등급',
  prior_progress: '선행 진도', weak_units: '취약 단원',
  target_univ: '희망 대학',
  purposes: '수강 목적', avail_days: '가능 요일',
  notes: '상담 메모',
  referral: '유입 경로', referral_detail: '유입 경로 상세',
  mathflat_name: '매쓰플랫 이름', approval_status: '승인 상태', personal_key: '개인키',
};
function expandProfile(json) {
  if (!json) return null;
  let o = null;
  try { o = JSON.parse(json); } catch (_) { return null; }
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || v === '') continue;   // 빈 칸은 빼고 준다
    let val = v;
    if (k === 'purposes' || k === 'avail_days') {              // DB엔 JSON 문자열로 들어 있다
      try { const a = JSON.parse(v); if (Array.isArray(a)) val = a.join(', '); } catch (_) {}
    }
    out[PROFILE_LABELS[k] || k] = val;   // 라벨에 없는 새 컬럼도 원래 이름으로 통과시킨다
  }
  return out;
}

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD)
    return Response.json({ error: '인증 실패' }, { status: 401 });

  try {
    await ensureArchiveTable(env);

    if (request.method === 'GET') {
      // 🔎 소환 (2026-08-05) — ?id=N 이면 그 1건만 + profile_json 을 한글로 펼쳐서 준다.
      //    화면은 안 부른다(파라미터 없이 호출) → 목록 응답 모양은 그대로다.
      const idQ = new URL(request.url).searchParams.get('id');
      if (idQ) {
        const rid = Number(idQ);
        if (!Number.isFinite(rid)) return Response.json({ error: 'id 형식 오류' }, { status: 400 });
        const row = await env.DB.prepare('SELECT * FROM student_archive WHERE id = ?').bind(rid).first();
        if (!row) return Response.json({ error: '그 번호의 기록이 없습니다.' }, { status: 404 });
        const profile = expandProfile(row.profile_json);
        return Response.json({
          ok: true, outcome: row, profile,
          // 2026-08-05 이전에 퇴원한 학생은 profile_json 이 애초에 안 담겼다.
          // "값이 비었다"와 "그때는 저장 자체를 안 했다"를 구분해 준다.
          profile_note: profile ? null : '이 기록에는 상세 프로필이 없습니다(2026-08-05 보존 개선 이전 퇴원분). R2 일일 백업 30일치에 남아 있을 수 있습니다.',
        });
      }
      const { results } = await env.DB.prepare(
        'SELECT * FROM student_archive ORDER BY left_at DESC, id DESC'
      ).all();
      // 목록에서는 profile_json 을 빼고 보낸다(관우T 2026-08-05 — 화면엔 최소만).
      //   화면이 안 쓰는 개인정보를 브라우저까지 실어 보낼 이유가 없고, 응답도 가벼워진다.
      //   대신 has_profile 로 "상세가 남아 있는 기록인지"만 알려 준다 → ?id=N 으로 꺼내면 된다.
      const list = (results || []).map((r) => {
        const { profile_json, ...rest } = r;
        return { ...rest, has_profile: profile_json ? 1 : 0 };
      });
      return Response.json({ ok: true, count: list.length, outcomes: list });
    }

    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const id = Number(body.id);
      const action = String(body.action || '');
      if (!Number.isFinite(id)) return Response.json({ error: 'id가 필요합니다.' }, { status: 400 });

      // 🔎 손대기 전 원본 행을 먼저 읽는다. 삭제는 복구 불가라 "무엇이 사라졌는지"가 남아야 하고,
      //    숨김도 "누가 언제 숨겼나"가 남아야 나중에 기록이 안 보인다는 문의를 추적할 수 있다.
      const prev = await env.DB.prepare('SELECT * FROM student_archive WHERE id = ?').bind(id).first();
      const 이름 = (prev && (prev.name || prev.student_name)) || '';

      if (action === 'hide' || action === 'unhide') {
        await env.DB.prepare('UPDATE student_archive SET hidden = ? WHERE id = ?')
          .bind(action === 'hide' ? 1 : 0, id).run();
        await logAudit(env, request, {
          action: 'outcome.' + action,
          target: 'student_archive/' + id,
          targetName: 이름,
          summary: (이름 || ('기록 #' + id)) + ' 지운 기록을 ' + (action === 'hide' ? '숨김' : '숨김 해제'),
          detail: { id, 전: prev ? prev.hidden : null, 후: action === 'hide' ? 1 : 0, 삭제경로: prev ? prev.via : null },
        });
        return Response.json({ ok: true, id, hidden: action === 'hide' ? 1 : 0 });
      }
      if (action === 'delete') {
        const d = await env.DB.prepare('DELETE FROM student_archive WHERE id = ?').bind(id).run();
        // ⚠️ 되돌릴 수 없는 삭제 — 지워진 행 전체를 그대로 남긴다(이게 유일한 복원 근거가 된다).
        await logAudit(env, request, {
          action: 'outcome.delete',
          target: 'student_archive/' + id,
          targetName: 이름,
          summary: (이름 || ('기록 #' + id)) + ' 지운 기록을 영구 삭제 (복구 불가)',
          detail: { id, 삭제행수: (d.meta && d.meta.changes) || 0, 지워진행: prev || null },
        });
        return Response.json({ ok: true, id, deleted: (d.meta && d.meta.changes) || 0 });
      }
      return Response.json({ error: '알 수 없는 action' }, { status: 400 });
    }

    return Response.json({ error: 'GET/POST만 허용됩니다.' }, { status: 405 });
  } catch (e) {
    return Response.json({ error: '지운 기록을 처리하는 중 오류가 발생했습니다.' }, { status: 500 });
  }
}
