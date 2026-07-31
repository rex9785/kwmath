// /api/inquiry — 홈페이지 수업 문의(리드) 접수
// ───────────────────────────────────────────────────────────
// D1 table: inquiries (없으면 자동 생성).
// 예전엔 mailto: 링크라 학부모가 상담 신청을 해도 서버로 안 들어오고
// 각자 메일 앱이 떴다 → 메일 설정 안 한 사람은 리드가 그냥 증발.
// 이제 서버에 저장 + 원장(관우T) 앱으로 즉시 푸시.
//
//  POST   /api/inquiry            무인증(공개). 홈페이지 문의 폼이 호출.
//         body: { name, phone, grade?, message?, hp? }
//         - hp = 허니팟(숨김 입력). 값이 차서 오면 봇으로 보고 조용히 무시(ok 반환).
//  GET    /api/inquiry?admin=1    원장. 전체 리드 목록 (Bearer ADMIN_PASSWORD)
//  PATCH  /api/inquiry?id=...     원장. 처리상태/메모 변경 { status:'new'|'done', memo? }
//  DELETE /api/inquiry?id=...     원장. 삭제
//
//  ※ 인증: admin.html이 보낸 adm_ 세션을 _middleware.js가 Bearer ADMIN_PASSWORD로 번역해 전달.
//     조교(ast_)는 _middleware.js STAFF_GET_BLOCK에서 이 경로 GET을 차단(리드=원장 전용).
// ───────────────────────────────────────────────────────────
import { sendPushToUsers } from './_push.js';
import { logAudit, diffFields } from './_auditlog.js';

// 새 문의 알림을 받을 관리자 푸시 userId (qna.js와 동일 규약)
const ADMIN_PUSH_USERS = ['__admin__'];

const MAX_NAME = 60;
const MAX_PHONE = 30;
const MAX_GRADE = 80;
const MAX_MSG = 2000;

function jsonOk(data, status = 200) { return Response.json(data, { status }); }
function jsonErr(msg, status = 400) { return Response.json({ error: msg }, { status }); }

// 저장형 XSS 방지 — 원장 화면(admin-inquiries.html)에서 렌더되므로 위험문자 제거.
// (admin 페이지도 textContent로 렌더하지만, 서버에서도 한 번 더 살균 = 이중 방어)
function clean(v, max) {
  return String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, max);
}

async function ensureTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS inquiries (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'name TEXT, phone TEXT, grade TEXT, message TEXT, ' +
    "status TEXT NOT NULL DEFAULT 'new', memo TEXT, ua TEXT, " +
    'src TEXT, utm TEXT, ' +
    'created_at TEXT, handled_at TEXT)'
  ).run();
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_inq_created ON inquiries(created_at)').run(); } catch (_) {}
  // 기존 테이블 마이그레이션 — CREATE TABLE IF NOT EXISTS는 컬럼을 추가 안 하므로
  // 이미 있던 inquiries 테이블엔 ALTER로 유입정보 컬럼을 덧댄다(이미 있으면 조용히 무시).
  try { await env.DB.prepare('ALTER TABLE inquiries ADD COLUMN src TEXT').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE inquiries ADD COLUMN utm TEXT').run(); } catch (_) {}
}

// KST 표시용(참고) — created_at 자체는 ISO(UTC)로 저장, 화면에서 변환.
function nowIso() { return new Date().toISOString(); }

function rowOut(r) {
  return {
    id: r.id,
    name: r.name || '',
    phone: r.phone || '',
    grade: r.grade || '',
    message: r.message || '',
    status: r.status || 'new',
    memo: r.memo || '',
    src: r.src || '',
    utm: r.utm || '',
    createdAt: r.created_at || '',
    handledAt: r.handled_at || '',
  };
}

// 새 문의 → 원장 앱 푸시 (best-effort, 절대 throw 안 함)
function notifyAdmin(context, env, lead) {
  try {
    const who = (lead.name || '문의').toString().slice(0, 20);
    const parts = [];
    if (lead.phone) parts.push(lead.phone);
    if (lead.grade) parts.push(lead.grade.toString().slice(0, 20));
    const sub = parts.join(' · ') || '새 상담 문의';
    const p = sendPushToUsers(env, ADMIN_PUSH_USERS, {
      title: '📩 새 수업 문의가 도착했어요',
      body: who + ' · ' + sub,
      url: '/admin-inquiries.html',
      tag: 'kwmath-inquiry-new',
    });
    if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
    else if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* best-effort */ }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
  const isAdmin = !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;

  try { await ensureTable(env); }
  catch (e) { return jsonErr('문의 DB 초기화에 실패했습니다.', 500); }

  try {
    // ─────────────── POST (공개 · 문의 접수) ───────────────
    if (method === 'POST') {
      const body = await request.json().catch(() => ({}));

      // 허니팟 — 사람은 안 보이는 필드. 봇이 채워 보내면 조용히 성공처럼 응답하고 버림.
      if (clean(body.hp, 100)) return jsonOk({ ok: true, message: '문의가 접수됐어요.' });

      const name = clean(body.name, MAX_NAME);
      const phoneRaw = clean(body.phone, MAX_PHONE);
      const grade = clean(body.grade, MAX_GRADE);
      const message = clean(body.message, MAX_MSG);
      // 유입정보 — 어느 채널로 홈페이지에 들어와 문의했는지(전환 추적용).
      // src = document.referrer(유입 출처 URL), utm = 광고/캠페인 파라미터.
      const src = clean(body.src, 300);
      const utm = clean(body.utm, 200);

      if (!name) return jsonErr('성함을 입력해 주세요.');
      // 연락처: 숫자가 최소 8자리는 있어야 유효(하이픈·공백 허용)
      const digits = phoneRaw.replace(/\D/g, '');
      if (digits.length < 8) return jsonErr('연락처를 정확히 입력해 주세요.');

      const ua = clean(request.headers.get('user-agent') || '', 200);
      const now = nowIso();
      const res = await env.DB.prepare(
        'INSERT INTO inquiries (name, phone, grade, message, status, memo, ua, src, utm, created_at, handled_at) ' +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(name, phoneRaw, grade, message, 'new', '', ua, src, utm, now, null).run();

      notifyAdmin(context, env, { name, phone: phoneRaw, grade });

      // 📓 2026-07-31 — 리드 접수도 로그로 남긴다.
      //   ① 나중에 이 문의가 삭제돼도 "그날 문의가 실제로 들어왔다"는 독립 증거가 남는다.
      //   ② 홈페이지 문의폼이 살아있는지(리드 0이 유입 문제인지 폼 고장인지) 판별하는 근거가 된다.
      //   행위자는 로그인 사용자가 아니라 홈페이지 방문자 → actor 를 직접 명시한다.
      await logAudit(env, request, {
        action: 'inquiry.create',
        actor: '방문자', actorRole: 'public', actorName: name,
        target: String((res.meta && res.meta.last_row_id) || ''),
        targetName: name,
        summary: '홈페이지 수업 문의 접수 — ' + name + ' · ' + phoneRaw + (grade ? ' · ' + grade : ''),
        detail: {
          문의id: (res.meta && res.meta.last_row_id) || null,
          이름: name, 연락처: phoneRaw, 학년: grade || '',
          내용: message || '(없음)',
          유입출처: src || '(없음)', 광고파라미터: utm || '(없음)',
          접수시각: now,
        },
      });

      return jsonOk({
        ok: true,
        id: res.meta && res.meta.last_row_id,
        message: '문의가 접수됐어요. 관우T가 확인 후 곧 연락드릴게요.',
      });
    }

    // ─────────────── GET (원장 · 리드 목록) ───────────────
    if (method === 'GET') {
      if (url.searchParams.get('admin') !== '1') return jsonErr('지원하지 않는 요청입니다.', 400);
      if (!isAdmin) return jsonErr('관리자 인증이 필요합니다.', 401);
      const { results } = await env.DB.prepare(
        'SELECT * FROM inquiries ORDER BY created_at DESC, id DESC'
      ).all();
      const list = (results || []).map(rowOut);
      const newCount = list.filter(x => x.status === 'new').length;
      return jsonOk({ ok: true, inquiries: list, newCount });
    }

    // ─────────────── PATCH (원장 · 처리상태/메모) ───────────────
    if (method === 'PATCH') {
      if (!isAdmin) return jsonErr('관리자 인증이 필요합니다.', 401);
      const id = url.searchParams.get('id');
      if (!id) return jsonErr('id가 필요합니다.');
      const body = await request.json().catch(() => ({}));
      // 🔎 예전엔 id 한 칸만 읽어 존재 확인만 했다 → 메모를 통째로 갈아엎어도 옛 메모가 어디에도 안 남았다.
      //    같은 쿼리 한 번에 전체 행을 읽어 "전" 값을 확보한다(추가 비용 0).
      const ex = await env.DB.prepare('SELECT * FROM inquiries WHERE id=?').bind(id).first();
      if (!ex) return jsonErr('문의를 찾을 수 없습니다.', 404);

      const sets = [], vals = [];
      const after = { status: ex.status || 'new', memo: ex.memo || '', handled_at: ex.handled_at || null };
      if (body.status !== undefined) {
        const st = (body.status === 'done') ? 'done' : 'new';
        sets.push('status=?'); vals.push(st);
        const h = st === 'done' ? nowIso() : null;
        sets.push('handled_at=?'); vals.push(h);
        after.status = st; after.handled_at = h;
      }
      if (body.memo !== undefined) {
        const m = clean(body.memo, 500);
        sets.push('memo=?'); vals.push(m);
        after.memo = m;
      }
      if (!sets.length) return jsonOk({ ok: true });
      vals.push(id);
      await env.DB.prepare('UPDATE inquiries SET ' + sets.join(', ') + ' WHERE id=?').bind(...vals).run();

      // 📓 메모는 상담 내용이 쌓이는 칸이다. 덮어쓰면 옛 내용이 사라지므로 전/후를 통째로 남긴다.
      const d = diffFields(
        { status: ex.status || 'new', memo: ex.memo || '', handled_at: ex.handled_at || null },
        after, ['status', 'memo', 'handled_at']
      );
      await logAudit(env, request, {
        action: 'inquiry.update',
        target: String(id), targetName: ex.name || '',
        summary: '문의 [' + (ex.name || ('#' + id)) + '] 수정 — ' + (d.요약 || '변경 없음'),
        detail: {
          문의id: Number(id), 이름: ex.name || '', 연락처: ex.phone || '',
          바뀐칸: d.바뀐칸, 변경: d.변경,
          메모길이: { 전: (ex.memo || '').length, 후: after.memo.length },
        },
      });
      return jsonOk({ ok: true, id });
    }

    // ─────────────── DELETE (원장 · 삭제) ───────────────
    if (method === 'DELETE') {
      if (!isAdmin) return jsonErr('관리자 인증이 필요합니다.', 401);
      const id = url.searchParams.get('id');
      if (!id) return jsonErr('id가 필요합니다.');
      // 🔴 2026-07-31 — 예전엔 아무것도 안 읽고 바로 지웠다. 리드(잠재 고객 연락처)가
      //    이름·전화번호·상담내용째로 흔적 없이 증발했고, 잘못 지웠는지조차 알 수 없었다.
      //    지우기 전에 행 전체를 읽어 로그에 통째로 박는다 → 로그가 유일한 복원 근거.
      let row = null;
      try { row = await env.DB.prepare('SELECT * FROM inquiries WHERE id=?').bind(id).first(); } catch (_) {}
      const del = await env.DB.prepare('DELETE FROM inquiries WHERE id=?').bind(id).run();
      const removed = (del.meta && del.meta.changes) || 0;

      await logAudit(env, request, {
        action: 'inquiry.delete',
        target: String(id), targetName: (row && row.name) || '',
        summary: '수업 문의 [' + ((row && row.name) || ('#' + id)) + (row && row.phone ? ' · ' + row.phone : '')
          + '] 영구 삭제 (복구 불가)',
        detail: {
          문의id: Number(id),
          지워진문의: row || '(행을 못 읽음 — 이미 없었을 수 있음)',
          삭제건수: removed,
          처리상태였음: (row && row.status) || '',
          비고: removed === 0 ? '지울 행이 없었음' : '이 로그의 지워진문의가 유일한 복원 근거',
        },
      });
      return jsonOk({ ok: true, removed });
    }

    return jsonErr('지원하지 않는 메소드입니다.', 405);
  } catch (e) {
    return jsonErr('문의 처리 중 오류가 발생했습니다.', 500);
  }
}
