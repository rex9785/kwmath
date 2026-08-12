// ═══════════════════════════════════════════════════════════════════════════════
// 🔒 2026-08-12 — 입시컨설팅 리포트 비밀번호 관문
//
//   관우T 지시 두 개를 함께 만족시킨다.
//     ① "홈페이지에서 이걸로 가는 입구는 만들지 말고 url 알면 들어갈 수 있는 정도"
//        → 사이트 어디에도 링크를 걸지 않는다. 주소를 아는 사람만 도달한다.
//     ② "비번으로 잠궈줘 비밀번호 4550"
//        → 주소를 알아도 비밀번호를 통과해야 본문이 나온다.
//
//   ⚠️ 왜 브라우저 자바스크립트로 안 막았나
//      화면에서 비밀번호를 물어보고 통과하면 보여주는 방식은, 본문 HTML이 이미 브라우저에
//      내려온 뒤다. 「페이지 소스 보기」 한 번이면 전부 읽힌다. 학생 실명·학교명·성적·
//      대학 지원전략이 들어 있는 문서라 그렇게 두면 안 된다.
//      → **서버가 먼저 판정하고, 통과하기 전에는 본문을 아예 내려보내지 않는다.**
//
//   비밀번호 보관
//      기본값은 아래 DEFAULT_PIN(4550). Cloudflare Pages 대시보드에서 환경변수
//      CONSULT_PIN 을 넣으면 그 값이 우선한다(소스코드에서 비밀번호가 사라짐).
//      비밀번호를 바꾸면 이미 발급된 통행증도 **자동으로 전부 무효**가 된다
//      (서명 원문에 비밀번호가 섞여 있어서 — 아래 ticketMsg 참고).
//
//   무차별 대입 방어
//      네 자리 = 1만 가지. 횟수 제한이 없으면 프로그램으로 몇 분이면 다 훑는다.
//      → 이미 만들어 둔 공개 관문 잠금(gate_lockouts, §11-16)을 그대로 쓴다.
//        같은 IP 기준 5회 실패 → 1·5·15·60분 자동 잠금(스스로 풀림), 24시간 지난 실패는 잊음.
// ═══════════════════════════════════════════════════════════════════════════════

import { readCookie } from './_admin.js';
import {
  gateKeyFromRequest, checkGateLockout, recordGateFailure,
  clearGateLockout, gateTriesLeft, fmtRetry,
} from './_lockout.js';

// 잠글 주소들. kwmath.co.kr/hyochan 처럼 확장자 없이도 열린다(Pages 기본 동작).
const SLUGS = new Set(['hyochan', 'seoyul', 'chaeeun', 'jihwan']);

const DEFAULT_PIN = '4550';
const GATE_NAME = 'consult';          // gate_lockouts 카운터 이름(다른 관문과 안 섞임)
const COOKIE_PREFIX = 'kwc_';         // 통행증 쿠키 이름 앞머리 — 문서마다 따로
const TICKET_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 한 번 풀면 7일간 다시 안 묻는다

const BRAND = '#862633';

// ── 이 요청이 잠긴 문서인가 → slug 또는 null ──────────────────────────────────
//   /hyochan · /hyochan.html · /hyochan/ 세 가지를 모두 같은 문서로 본다.
export function consultSlugOf(pathname) {
  if (typeof pathname !== 'string' || pathname.charCodeAt(0) !== 47) return null;
  let p = pathname;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (p.endsWith('.html')) p = p.slice(0, -5);
  const slug = p.slice(1);
  return SLUGS.has(slug) ? slug : null;
}

function pinOf(env) {
  const v = env && env.CONSULT_PIN;
  return (typeof v === 'string' && v.length > 0) ? v : DEFAULT_PIN;
}

async function hmacHex(key, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 서명 원문에 **문서 slug 와 현재 비밀번호**를 함께 넣는다.
//   → 통행증은 그 문서에서만 쓸 수 있고, 비밀번호를 바꾸면 옛 통행증이 전부 죽는다.
function ticketMsg(slug, exp, pin) {
  return 'consult|' + slug + '|' + exp + '|' + pin;
}

// 길이가 같을 때 시간차로 정답을 흘리지 않게 — 전부 비교하고 끝에 판정
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function issueTicket(env, slug) {
  const exp = Date.now() + TICKET_TTL_MS;
  const sig = await hmacHex(env.ADMIN_PASSWORD, ticketMsg(slug, exp, pinOf(env)));
  return exp + '_' + sig;
}

async function verifyTicket(env, slug, token) {
  if (!token || typeof token !== 'string') return false;
  const i = token.indexOf('_');
  if (i <= 0) return false;
  const exp = Number(token.slice(0, i));
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  const want = await hmacHex(env.ADMIN_PASSWORD, ticketMsg(slug, exp, pinOf(env)));
  return safeEq(token.slice(i + 1), want);
}

// ── 잠금해제 화면 ─────────────────────────────────────────────────────────────
//   ⚠️ 여기에 **학생 이름·학교·문서 제목을 쓰지 않는다.** 주소를 우연히 눌러 본 사람이
//      "누구 문서인지"조차 알 수 없어야 한다. 통과한 뒤에야 이름이 보인다.
function gatePage(opts) {
  const err = opts.err || '';
  const disabled = opts.locked ? ' disabled' : '';
  const html = '<!DOCTYPE html>\n' +
'<html lang="ko">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">\n' +
'<meta name="referrer" content="no-referrer">\n' +
'<title>이관우 수학연구소</title>\n' +
'<link rel="icon" href="/icons/icon-192.png">\n' +
'<style>\n' +
'*{box-sizing:border-box}\n' +
'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;\n' +
'  background:#f7f7f9;color:#1b1b1f;\n' +
'  font-family:"Apple SD Gothic Neo","Malgun Gothic","맑은 고딕",-apple-system,sans-serif}\n' +
'.card{width:100%;max-width:360px;background:#fff;border:1px solid #e3e4e8;border-radius:16px;\n' +
'  padding:36px 28px 30px;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.06)}\n' +
'.mark{width:44px;height:44px;margin:0 auto 18px;border-radius:12px;background:' + BRAND + ';\n' +
'  display:flex;align-items:center;justify-content:center}\n' +
'.mark svg{width:22px;height:22px;fill:#fff}\n' +
'h1{margin:0 0 6px;font-size:17px;font-weight:700;letter-spacing:-.2px}\n' +
'p.sub{margin:0 0 22px;font-size:13.5px;line-height:1.6;color:#6b6e78}\n' +
'input{width:100%;height:52px;text-align:center;font-size:22px;letter-spacing:10px;\n' +
'  border:1px solid #d8d9df;border-radius:10px;outline:none;background:#fff;color:#1b1b1f}\n' +
'input:focus{border-color:' + BRAND + ';box-shadow:0 0 0 3px rgba(134,38,51,.12)}\n' +
'button{width:100%;height:48px;margin-top:12px;border:0;border-radius:10px;cursor:pointer;\n' +
'  background:' + BRAND + ';color:#fff;font-size:15px;font-weight:700}\n' +
'button:disabled{background:#c9c9d0;cursor:not-allowed}\n' +
'.err{margin:14px 0 0;font-size:13px;font-weight:600;color:#a02020}\n' +
'.foot{margin:24px 0 0;font-size:11.5px;color:#9a9da6}\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'<form class="card" method="POST" autocomplete="off">\n' +
'  <div class="mark"><svg viewBox="0 0 24 24"><path d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5zm0 2a3 3 0 0 1 3 3v3H9V6a3 3 0 0 1 3-3zm0 11a2 2 0 0 1 1 3.7V19a1 1 0 0 1-2 0v-1.3A2 2 0 0 1 12 14z"/></svg></div>\n' +
'  <h1>비밀번호로 보호된 문서입니다</h1>\n' +
'  <p class="sub">전달받으신 네 자리 숫자를 입력해주세요.</p>\n' +
'  <input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8"\n' +
'         autocomplete="off" autofocus aria-label="비밀번호"' + disabled + '>\n' +
'  <button type="submit"' + disabled + '>열기</button>\n' +
(err ? '  <p class="err">' + err + '</p>\n' : '') +
'  <p class="foot">이관우 수학연구소 · kwmath.co.kr</p>\n' +
'</form>\n' +
'</body>\n' +
'</html>\n';
  return new Response(html, {
    status: opts.status || 401,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

// ── 관문 본체 ────────────────────────────────────────────────────────────────
//   반환값 null = 통과(미들웨어가 원본 문서를 그대로 서빙).
//   반환값 Response = 여기서 끝(잠금해제 화면 · 통과 후 되돌리기 · 잠김 안내).
export async function handleConsultGate(context, slug) {
  const request = context.request;
  const env = context.env;

  // 서명 열쇠가 없으면 통행증을 만들 수도 검증할 수도 없다 → **닫는다**.
  //   비공개 문서라 「모르면 열어준다」가 아니라 「모르면 닫는다」가 맞다.
  if (!env || !env.ADMIN_PASSWORD) {
    return gatePage({ status: 503, locked: true, err: '지금은 열 수 없습니다. 관리자에게 문의해주세요.' });
  }

  // 이미 푼 사람 — 통행증이 유효하면 그냥 통과
  if (await verifyTicket(env, slug, readCookie(request, COOKIE_PREFIX + slug))) return null;

  const method = (request.method || 'GET').toUpperCase();
  const key = gateKeyFromRequest(request, GATE_NAME);

  if (method === 'POST') {
    const pre = await checkGateLockout(env, key);
    if (pre.locked) {
      return gatePage({ status: 429, locked: true, err: '너무 여러 번 틀렸습니다. ' + fmtRetry(pre.retryAfterSec) + ' 뒤에 다시 시도해주세요.' });
    }
    let pin = '';
    try {
      const form = await request.formData();
      pin = String(form.get('pin') || '').trim();
    } catch (_) { pin = ''; }

    if (pin && safeEq(pin, pinOf(env))) {
      await clearGateLockout(env, key);
      const ticket = await issueTicket(env, slug);
      let dest = '/' + slug;
      try { dest = new URL(request.url).pathname; } catch (_) {}
      return new Response(null, {
        status: 303,
        headers: {
          Location: dest,
          'Set-Cookie': COOKIE_PREFIX + slug + '=' + ticket + '; Path=/; Max-Age=' +
            Math.floor(TICKET_TTL_MS / 1000) + '; HttpOnly; Secure; SameSite=Lax',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
        },
      });
    }

    const f = await recordGateFailure(env, key);
    if (f.locked) {
      return gatePage({ status: 429, locked: true, err: '너무 여러 번 틀렸습니다. ' + fmtRetry(f.retryAfterSec) + ' 뒤에 다시 시도해주세요.' });
    }
    const left = gateTriesLeft(f.failCount);
    return gatePage({
      status: 401,
      err: (left > 0 && left <= 2)
        ? '비밀번호가 맞지 않습니다. (' + left + '번 남음)'
        : '비밀번호가 맞지 않습니다.',
    });
  }

  // GET·HEAD 등 — 잠금해제 화면
  const now = await checkGateLockout(env, key);
  if (now.locked) {
    return gatePage({ status: 429, locked: true, err: '너무 여러 번 틀렸습니다. ' + fmtRetry(now.retryAfterSec) + ' 뒤에 다시 시도해주세요.' });
  }
  return gatePage({ status: 401 });
}
