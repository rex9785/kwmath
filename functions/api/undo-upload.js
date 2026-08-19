// /api/undo-upload — MathOS 홈페이지 업로드 되돌리기 · **원장 전용**
// ═══════════════════════════════════════════════════════════════════════════
// 왜 만들었나 (2026-08-15 · 2026-08-16 관리자로 이전)
//   MathOS에서 학원·반을 잘못 고른 채 「홈페이지 업로드」를 누르면
//     ① 그 반 전원의 리포트가 생기고 학부모 푸시가 즉시 나가고
//     ② 같은 학생·같은 날짜 리포트가 이미 있으면 **조용히 덮어쓰고**(reports-write.js 중복 가드)
//     ③ 같은 반·같은 날짜 영상 코드가 **자동 삭제**된다(save-video-code.js).
//   즉 잘못 올린 것을 지우는 것만으로는 복구가 안 된다. 그 업로드가 밀어낸 것까지 되살려야 한다.
//
// 🔴 왜 MathOS가 아니라 여기 있나 (관우T 확정 2026-08-16)
//   처음엔 되돌리기를 MathOS 안에 만들었다. 그런데 스냅샷이 그 PC 디스크에만 있어서
//   **그 컴퓨터 앞에 앉아 MathOS를 켜야만** 되돌릴 수 있었다. 실수는 대개 밖에서 깨닫는다.
//   → 스냅샷을 홈페이지에 함께 저장하고, 되돌리기 버튼을 관리자 화면에 둔다. 폰에서도 된다.
//
// 📓 왜 감사로그가 아니라 스냅샷인가
//   감사로그(report.overwrite → detail.이전내용)에도 덮이기 전 리포트가 통째로 있어서
//   원리상 복원은 된다. 다만 **자동 대체로 지워진 옛 영상의 `require_code`·`active`가
//   감사로그에도 video-replaced 표식에도 없다.** 그것만 보고 되살리면 코드 없이 열리는
//   영상으로 잘못 복원된다. MathOS가 보내기 직전에 찍은 스냅샷에는 그 두 값이 있다.
//   → 스냅샷을 1순위로 쓰고, 감사로그는 스냅샷이 없을 때 사람이 보는 근거로 남긴다.
//
// 사용법
//   POST { action:'save', snapshot:{...} }        MathOS가 업로드 직후 스냅샷 저장
//   GET  ?list=1&limit=20                          최근 업로드 목록 (되돌린 것 포함)
//   GET  ?id=undo-...                              한 건 + 되돌리기 계획(미리보기, 아무것도 안 건드림)
//   POST { action:'run', undo_id, confirm:true }   실행 (confirm 없으면 거부)
//
// R2 키: undo-uploads/{undo_id}.json   (최근 300건 유지)
// ═══════════════════════════════════════════════════════════════════════════
import { safeError } from './_errors.js';
import { logAudit } from './_auditlog.js';
import { updateReport, deleteReport } from './_db.js';

const PREFIX = 'undo-uploads/';
const KEEP = 300;
const ID_RE = /^undo-[0-9]{8}-[0-9]{6}-[A-Z0-9]{4}$/;

// 📌 여기에는 반 이름 정규화(norm)가 없다 — 일부러 없다.
//    "같은 반·같은 날짜 영상"을 골라내는 일은 **MathOS가 업로드 직전에 이미 끝냈고**,
//    그 결과가 snapshot.videos_before 로 통째로 넘어온다. 여기서 다시 고르면
//    규칙 두 벌이 생겨 언젠가 서로 어긋난다(=엉뚱한 영상을 되살린다).

function reportRow(r) {
  if (!r) return null;
  return {
    id: String(r.id),
    studentName: r.student_name || '',
    date: r.class_date || '',
    school: r.academy || '',
    content: r.content || '',
    homework: r.homework || '',
    notes: r.notes || '',
  };
}

async function readReport(env, id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  try {
    const r = await env.DB.prepare('SELECT * FROM reports WHERE id=?').bind(n).first();
    return reportRow(r);
  } catch (_) { return null; }
}

async function loadSnap(env, id) {
  if (!ID_RE.test(id || '')) return null;
  try {
    const obj = await env.BUCKET.get(PREFIX + id + '.json');
    if (!obj) return null;
    return await obj.json();
  } catch (_) { return null; }
}

async function saveSnap(env, snap) {
  await env.BUCKET.put(PREFIX + snap.id + '.json', JSON.stringify(snap),
    { httpMetadata: { contentType: 'application/json' } });
}

// ── 되돌리기 계획 ──
// 아무것도 바꾸지 않는다. 미리보기와 실행이 **같은 함수**를 쓴다 —
// 화면에 보여준 것과 실제로 도는 것이 어긋나지 않게 하려는 것이 이 구조의 전부다.
async function buildPlan(env, snap) {
  const 경고 = [];
  const 되돌릴수없음 = [];
  const uploaded = snap.uploaded || {};
  const 계획 = [];

  for (const row of (snap.reports || [])) {
    const name = row.name || '';
    const rid = row.report_id;
    const item = { name, report_id: rid == null ? null : String(rid), action: 'skip', note: '', warn: '', preview: '' };
    const 현재 = rid == null ? null : await readReport(env, rid);

    if (rid == null) {
      item.note = '리포트 번호를 받지 못해 자동으로는 못 건드림 — 리포트 탭에서 직접 확인해 주세요';
    } else if (!현재) {
      item.note = '이미 없음 — 그 사이 지워졌거나 다른 업로드로 바뀜';
    } else if (row.deduped) {
      // deduped=true 는 이번 업로드가 **기존 리포트를 덮어썼다**는 뜻이다 → 이전 내용으로 되돌린다.
      // ⚠️ 이 분기는 반드시 deduped 로 가른다. "찍어 둔 이전 내용이 있느냐"로 가르면
      //    동명이인(중복 가드가 꺼져 새 행이 쌓인 경우)에서 **남의 리포트를 덮어쓴다.**
      if (row.before_known && row.before) {
        item.action = 'restore';
        item.note = '덮어쓰기 전 내용으로 되돌림';
        item.preview = String(row.before.content || '').slice(0, 120);
      } else {
        item.note = '기존 리포트를 덮어썼는데 이전 내용을 못 찍었음 — 자동 복원 불가';
        경고.push(name + ': 덮어쓰기 전 내용을 모릅니다. 변경이력에서 '
          + 'report.overwrite → 이전내용 을 찾아 직접 되살려야 합니다.');
      }
    } else {
      item.action = 'delete';
      item.note = '이번 업로드로 새로 생긴 리포트 — 삭제';
    }

    // 업로드 뒤 사람이 손댔는지 — 되돌리면 그 수정까지 같이 사라진다.
    if (현재 && (uploaded.content !== undefined || uploaded.homework !== undefined)) {
      if ((현재.content || '') !== (uploaded.content || '')
        || (현재.homework || '') !== (uploaded.homework || '')) {
        item.warn = '업로드 뒤 내용이 바뀌었습니다 — 되돌리면 그 수정도 함께 사라집니다';
      }
    }
    계획.push(item);
  }

  // ── 영상 ──
  // 순서 의도: 잘못 올린 새 코드를 **먼저 지우고** 옛 코드를 되살린다.
  // (반대로 하면 옛 코드 저장이 save-video-code.js 의 자동 대체 규칙을 다시 깨워 방금 되살린 걸 또 지운다.)
  const 영상 = { delete: snap.new_video_code || null, restore: null };
  const 옛목록 = Array.isArray(snap.videos_before) ? snap.videos_before.slice() : [];
  if (옛목록.length) {
    옛목록.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    const 옛 = 옛목록[옛목록.length - 1];
    영상.restore = {
      code: String(옛.code || '').toUpperCase(),
      youtube_url: 옛.youtube_url || '',
      title: 옛.title || '',
      date: 옛.date || '',
      school: 옛.school || '',
      class_name: 옛.class_name || '',
      require_code: 옛.require_code === true,
      active: 옛.active !== false,
      access_count: 옛.access_count || 0,
    };
    if (!영상.restore.youtube_url) {
      영상.restore = null;
      경고.push('옛 영상의 유튜브 주소가 스냅샷에 없어 되살릴 수 없습니다. '
        + '변경이력에서 video.code.overwrite → 대체삭제내역 의 「유튜브」를 찾아 영상 관리에서 직접 등록해 주세요.');
    } else {
      되돌릴수없음.push('옛 영상 [' + 영상.restore.code + '] 의 열람 기록(누가 봤는지 · 총 '
        + (옛.access_count || 0) + '회)은 영상과 함께 이미 지워져 되살아나지 않습니다. 영상과 코드는 그대로 돌아옵니다.');
      되돌릴수없음.push("되살린 영상의 '등록 시각'은 원래 올린 때("
        + String(옛.created_at || '').slice(0, 16) + ')가 아니라 되돌린 지금으로 다시 찍힙니다. '
        + '학생이 보는 화면과 수업 날짜는 그대로입니다.');
    }
    if (옛목록.length > 1) {
      경고.push('업로드 직전 같은 반·같은 날짜 영상이 ' + 옛목록.length + '건이었습니다. '
        + '홈페이지 규칙상 한 반·한 날짜에는 1건만 남으므로 가장 최근 1건만 되살립니다.');
    }
  } else if (snap.videos_before_known === false) {
    경고.push('업로드 직전 영상 목록을 못 읽었습니다 — 이번 업로드로 지워진 옛 영상이 있었는지 알 수 없습니다. '
      + '잘못 올린 새 영상 코드는 그대로 지웁니다.');
  }

  되돌릴수없음.unshift('학부모 휴대폰에 이미 뜬 "📋 새 수업 리포트가 올라왔어요" 알림은 취소할 수 없습니다. '
    + '리포트를 지워도 알림 자체는 그분들 폰에 남아 있었습니다.');

  return {
    undo_id: snap.id,
    school: snap.school || '',
    class_name: snap.class_name || '',
    lesson_date: snap.lesson_date || '',
    uploaded_at: snap.created_at || '',
    undone_at: snap.undone_at || null,
    reports: 계획,
    delete_count: 계획.filter((x) => x.action === 'delete').length,
    restore_count: 계획.filter((x) => x.action === 'restore').length,
    skip_count: 계획.filter((x) => x.action === 'skip').length,
    video: 영상,
    warnings: 경고.concat(Array.isArray(snap.warnings) ? snap.warnings : []),
    irreversible: 되돌릴수없음,
  };
}

export async function onRequest({ request, env }) {
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
  const role = request.headers.get('X-Kw-Actor-Role') || '';   // 미들웨어가 붙인 값(외부 주입은 세척됨)
  const staffPhone = request.headers.get('X-Staff-Phone') || '';

  // 🔒 이중 잠금 — 스냅샷에는 리포트 원문(학생 개인정보)과 삭제 권한이 함께 들어 있다.
  //   _middleware.js 의 STAFF_GET_BLOCK 에도 넣었지만 미들웨어만 믿지 않는다(audit-log.js 와 같은 원칙).
  if (!isAdmin || role === 'staff' || staffPhone) {
    return Response.json({ error: '원장만 쓸 수 있어요.' }, { status: 403 });
  }

  try {
    // ══════════ 조회 ══════════
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const one = (url.searchParams.get('id') || '').trim();

      if (one) {
        const snap = await loadSnap(env, one);
        if (!snap) return Response.json({ error: '그 되돌리기 기록이 없습니다.' }, { status: 404 });
        const plan = await buildPlan(env, snap);
        return Response.json({ ok: true, preview: true, ...plan });
      }

      // 목록 — id 가 undo-YYYYMMDD-HHMMSS-XXXX 라 **키 이름순 = 시간순**이다.
      let limit = parseInt(url.searchParams.get('limit') || '20', 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 20;
      if (limit > 100) limit = 100;

      const listed = await env.BUCKET.list({ prefix: PREFIX, limit: 1000 });
      const keys = (listed.objects || []).map((o) => o.key).sort().reverse().slice(0, limit);
      const rows = [];
      for (const key of keys) {
        try {
          const obj = await env.BUCKET.get(key);
          if (!obj) continue;
          const s = await obj.json();
          rows.push({
            undo_id: s.id,
            created_at: s.created_at || '',
            school: s.school || '',
            class_name: s.class_name || '',
            lesson_date: s.lesson_date || '',
            student_count: Array.isArray(s.reports) ? s.reports.length : 0,
            overwrote: Array.isArray(s.reports) ? s.reports.filter((r) => r.deduped).length : 0,
            video_code: s.new_video_code || '',
            replaced_video: Array.isArray(s.videos_before) ? s.videos_before.length : 0,
            undone_at: s.undone_at || null,
          });
        } catch (_) { /* 한 건이 깨져도 목록 전체를 죽이지 않는다 */ }
      }
      return Response.json({ ok: true, rows, 총건수: (listed.objects || []).length });
    }

    if (request.method !== 'POST')
      return Response.json({ error: 'GET·POST만 허용' }, { status: 405 });

    let body = {};
    try { body = await request.json(); } catch { /* 아래에서 action 없음으로 걸린다 */ }
    const action = (body.action || '').trim();

    // ══════════ 저장 (MathOS가 업로드 직후 호출) ══════════
    if (action === 'save') {
      const snap = body.snapshot;
      if (!snap || !ID_RE.test(snap.id || ''))
        return Response.json({ error: 'snapshot.id 형식이 아닙니다 (undo-YYYYMMDD-HHMMSS-XXXX)' }, { status: 400 });

      snap.undone_at = snap.undone_at || null;
      await saveSnap(env, snap);

      // 오래된 것 정리 — 키 이름순 = 시간순이라 앞에서부터 버린다.
      try {
        const listed = await env.BUCKET.list({ prefix: PREFIX, limit: 1000 });
        const keys = (listed.objects || []).map((o) => o.key).sort();
        for (const key of keys.slice(0, Math.max(0, keys.length - KEEP))) await env.BUCKET.delete(key);
      } catch (_) { /* 정리 실패는 저장 성공을 취소할 이유가 못 된다 */ }

      return Response.json({ ok: true, undo_id: snap.id });
    }

    // ══════════ 실행 ══════════
    if (action === 'run') {
      const snap = await loadSnap(env, (body.undo_id || '').trim());
      if (!snap) return Response.json({ error: '그 되돌리기 기록이 없습니다.' }, { status: 404 });
      if (body.confirm !== true)
        return Response.json({ error: '미리보기를 먼저 확인해야 실행됩니다.' }, { status: 400 });
      if (snap.undone_at && body.force !== true) {
        return Response.json({
          error: '이미 ' + String(snap.undone_at).slice(0, 19) + ' 에 되돌린 업로드입니다. '
            + '다시 되돌리면 그 뒤에 새로 올린 글을 지울 수 있어 막았습니다.',
          already: true,
        }, { status: 409 });
      }

      const plan = await buildPlan(env, snap);

      // 🗄 되돌리기로 **사라지는 글**의 원본. 되돌리기 자체를 잘못 눌렀을 때 마지막 근거가 된다.
      //   (kwmath의 원칙: 지워진 데이터의 before 는 변경기록에 남긴다 — reports-write.js 삭제와 같은 등급.)
      //   화면 응답에는 안 실어 보낸다 — 미리보기·결과 화면에 통째 본문이 뜨면 읽기만 나빠진다.
      const 지워진원본 = [];
      const 요약본 = (o) => {
        if (!o) return null;
        const s = (v) => (v == null ? '' : String(v).slice(0, 1000));
        return { 이름: s(o.studentName || o.student_name), 날짜: s(o.date || o.class_date),
                 학원: s(o.school || o.academy), 내용: s(o.content), 숙제: s(o.homework), 메모: s(o.notes) };
      };

      for (const item of plan.reports) {
        if (item.action === 'delete') {
          const r = await deleteReport(env, Number(item.report_id));
          item.result = r.ok ? 'ok' : 'fail';
          if (!r.ok) item.error = r.error;
          else 지워진원본.push({ 리포트번호: item.report_id, 한일: '삭제', 지워진글: 요약본(r.before) });
        } else if (item.action === 'restore') {
          const row = (snap.reports || []).find((x) => String(x.report_id) === String(item.report_id));
          const b = (row && row.before) || {};
          // updateReport 는 undefined 만 건너뛴다 — 빈 문자열도 그대로 적용된다.
          //   (HTTP PATCH 층은 school 이 빈 문자열이면 무시해서 잘못된 학원명이 남았다. 여기선 직접 불러 그 구멍을 피한다.)
          const r = await updateReport(env, Number(item.report_id), {
            date: b.date || '',
            school: b.school === undefined ? '' : b.school,
            content: b.content || '',
            homework: b.homework || '',
            notes: b.notes || '',
          });
          item.result = r.ok ? 'ok' : 'fail';
          if (!r.ok) item.error = r.error;
          else 지워진원본.push({ 리포트번호: item.report_id, 한일: '덮어쓰기 복원', 지워진글: 요약본(r.before) });
          // 복원은 UPDATE 다 — 학부모 푸시를 보내지 않는다(푸시는 reports-write.js POST 안에만 있다).
        } else {
          item.result = 'skip';
        }
      }

      plan.video.result = {};
      if (plan.video.delete) {
        const key = 'video-codes/' + String(plan.video.delete).toUpperCase() + '.json';
        try {
          const obj = await env.BUCKET.get(key);
          if (!obj) plan.video.result.delete = '이미 없음';
          else { await env.BUCKET.delete(key); plan.video.result.delete = 'ok'; }
        } catch (e) { plan.video.result.delete = '실패 — ' + String((e && e.message) || e); }
      }
      if (plan.video.restore) {
        const v = plan.video.restore;
        try {
          await env.BUCKET.put('video-codes/' + v.code + '.json', JSON.stringify({
            code: v.code,
            youtube_url: v.youtube_url,
            title: v.title,
            date: v.date,
            school: v.school,
            class_name: v.class_name,
            require_code: v.require_code,
            active: v.active,
            created_at: new Date().toISOString(),
            access_count: 0,
            access_log: [],
            restored_from_undo: snap.id,
          }), { httpMetadata: { contentType: 'application/json' } });
          plan.video.result.restore = 'ok';
          // 대체 표식은 지운다 — 코드 파일이 되살아났으니 표식이 있으면 로그가 "대체됨"이라 거짓말을 한다.
          //   (video-access.js 는 코드 파일이 없을 때만 표식을 보므로 두어도 무해하지만, 남기면 나중에 사람이 오독한다.)
          try { await env.BUCKET.delete('video-replaced/' + v.code + '.json'); } catch (_) { /* 없으면 그만 */ }
        } catch (e) { plan.video.result.restore = '실패 — ' + String((e && e.message) || e); }
      }

      snap.undone_at = new Date().toISOString();
      snap.undo_result = { reports: plan.reports, video: plan.video };
      try { await saveSnap(env, snap); } catch (_) { /* 되돌리기 자체는 이미 끝났다 */ }

      const 성공 = plan.reports.filter((x) => x.result === 'ok').length;
      const 실패 = plan.reports.filter((x) => x.result === 'fail').length;

      await logAudit(env, request, {
        action: 'report.upload.undo',
        target: snap.id,
        targetName: (snap.school || '') + ' · ' + (snap.class_name || ''),
        summary: '홈페이지 업로드 되돌림 [' + (snap.school || '') + ' · ' + (snap.class_name || '')
          + ' · ' + (snap.lesson_date || '') + '] — 삭제 ' + plan.delete_count + ' · 복원 '
          + plan.restore_count + ' (성공 ' + 성공 + ' · 실패 ' + 실패 + ')',
        detail: {
          되돌리기id: snap.id,
          올린시각: snap.created_at || '',
          학원: snap.school || '', 반: snap.class_name || '', 수업일: snap.lesson_date || '',
          리포트: plan.reports,
          // 되돌리기로 화면에서 사라진 글의 원본 — 되돌리기를 잘못 눌렀을 때 여기서 되살린다.
          사라진글: 지워진원본,
          영상: plan.video,
          경고: plan.warnings,
          되돌릴수없음: plan.irreversible,
          비고: '푸시는 다시 나가지 않는다(복원은 UPDATE). 이미 발송된 알림은 취소 불가.',
        },
      });

      return Response.json({ ok: true, preview: false, ...plan, done: 성공, failed: 실패 });
    }

    return Response.json({ error: "action 은 'save' 또는 'run'" }, { status: 400 });
  } catch (e) {
    return safeError(e, env, { message: '되돌리기 처리에 실패했습니다.' });
  }
}
