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
      const ex = await env.DB.prepare('SELECT id FROM inquiries WHERE id=?').bind(id).first();
      if (!ex) return jsonErr('문의를 찾을 수 없습니다.', 404);

      const sets = [], vals = [];
      if (body.status !== undefined) {
        const st = (body.status === 'done') ? 'done' : 'new';
        sets.push('status=?'); vals.push(st);
        sets.push('handled_at=?'); vals.push(st === 'done' ? nowIso() : null);
      }
      if (body.memo !== undefined) { sets.push('memo=?'); vals.push(clean(body.memo, 500)); }
      if (!sets.length) return jsonOk({ ok: true });
      vals.push(id);
      await env.DB.prepare('UPDATE inquiries SET ' + sets.join(', ') + ' WHERE id=?').bind(...vals).run();
      return jsonOk({ ok: true, id });
    }

    // ─────────────── DELETE (원장 · 삭제) ───────────────
    if (method === 'DELETE') {
      if (!isAdmin) return jsonErr('관리자 인증이 필요합니다.', 401);
      const id = url.searchParams.get('id');
      if (!id) return jsonErr('id가 필요합니다.');
      await env.DB.prepare('DELETE FROM inquiries WHERE id=?').bind(id).run();
      return jsonOk({ ok: true, removed: 1 });
    }

    return jsonErr('지원하지 않는 메소드입니다.', 405);
  } catch (e) {
    return jsonErr('문의 처리 중 오류가 발생했습니다.', 500);
  }
}
