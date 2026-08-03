// kwmath 로그인 잠금(brute-force 방어) 유틸 (Cloudflare D1)
// - 비밀번호를 연속으로 N회 틀리면 계정을 "일시 잠금"
// - 아이폰처럼, 실패가 누적될수록 잠금 시간이 점점 길어짐 (상한 있음 → 스스로 풀림)
// - 로그인 성공 또는 관우T의 비밀번호 초기화 시 잠금 해제
//
// 키: 정규화된 휴대폰 번호('010-1234-5678'). login.js의 phone / 계정 PK와 동일하게 사용.
//
// 설계 메모:
//   * 잠금이 만료돼도 누적 실패 횟수는 유지된다 → 다시 틀리면 다음 단계로 더 길게 잠긴다.
//   * 상한(60분)이 있어 관우T 본인이 잠겨도 최대 60분이면 스스로 풀린다(관리자 자가복구).
//   * 학생은 관우T가 비밀번호를 초기화해주면 즉시 잠금이 풀린다(clearLockout 호출).
//   * 모든 DB 호출은 try/catch로 감싸 인프라 오류 시 정상 로그인을 막지 않는다(가용성 우선).

// 접속 IP 를 꺼내는 규칙은 감사로그와 하나만 쓴다(§11-16). 순환 import 없음 — _auditlog.js 는 아무것도 import 하지 않는다.
import { clientIp } from './_auditlog.js';

const MAX_FAILS_BEFORE_LOCK = 5;            // 이 횟수째 실패부터 잠금 시작
// 잠금 단계(분): 5회→1분, 6회→5분, 7회→15분, 8회 이상→60분(상한, 자동 해제)
const LOCK_MINUTES = [1, 5, 15, 60];

function lockMsFor(failCount) {
  if (failCount < MAX_FAILS_BEFORE_LOCK) return 0;
  const idx = Math.min(failCount - MAX_FAILS_BEFORE_LOCK, LOCK_MINUTES.length - 1);
  return LOCK_MINUTES[idx] * 60 * 1000;
}

async function ensureTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS login_lockouts (' +
      'phone TEXT PRIMARY KEY, ' +
      'fail_count INTEGER NOT NULL DEFAULT 0, ' +
      'locked_until INTEGER, ' +      // epoch ms; null = 잠금 아님
      'last_fail_at INTEGER)'
  ).run();
}

// 현재 잠금 상태 확인 → { locked, retryAfterSec, failCount }
export async function checkLockout(env, phone) {
  if (!phone) return { locked: false, retryAfterSec: 0, failCount: 0 };
  try {
    await ensureTable(env);
    const row = await env.DB.prepare(
      'SELECT fail_count, locked_until FROM login_lockouts WHERE phone = ?'
    ).bind(phone).first();
    if (!row) return { locked: false, retryAfterSec: 0, failCount: 0 };
    const now = Date.now();
    if (row.locked_until && row.locked_until > now) {
      return {
        locked: true,
        retryAfterSec: Math.ceil((row.locked_until - now) / 1000),
        failCount: row.fail_count || 0,
      };
    }
    return { locked: false, retryAfterSec: 0, failCount: row.fail_count || 0 };
  } catch (_) {
    // 인프라 오류 시 잠금 검사를 건너뛰어 정상 로그인을 막지 않음
    return { locked: false, retryAfterSec: 0, failCount: 0 };
  }
}

// 실패 1회 기록(+필요 시 잠금) → { locked, retryAfterSec, failCount }
export async function recordFailure(env, phone) {
  if (!phone) return { locked: false, retryAfterSec: 0, failCount: 0 };
  try {
    await ensureTable(env);
    const row = await env.DB.prepare(
      'SELECT fail_count FROM login_lockouts WHERE phone = ?'
    ).bind(phone).first();
    const failCount = ((row && row.fail_count) || 0) + 1;
    const lockMs = lockMsFor(failCount);
    const now = Date.now();
    const lockedUntil = lockMs > 0 ? now + lockMs : null;
    await env.DB.prepare(
      'INSERT INTO login_lockouts (phone, fail_count, locked_until, last_fail_at) VALUES (?,?,?,?) ' +
      'ON CONFLICT(phone) DO UPDATE SET fail_count=excluded.fail_count, ' +
      'locked_until=excluded.locked_until, last_fail_at=excluded.last_fail_at'
    ).bind(phone, failCount, lockedUntil, now).run();
    return {
      locked: !!lockedUntil,
      retryAfterSec: lockMs > 0 ? Math.ceil(lockMs / 1000) : 0,
      failCount,
    };
  } catch (_) {
    return { locked: false, retryAfterSec: 0, failCount: 0 };
  }
}

// 잠금 해제(로그인 성공 / 관리자 비번 초기화). 비치명적.
export async function clearLockout(env, phone) {
  if (!phone) return;
  try {
    await env.DB.prepare('DELETE FROM login_lockouts WHERE phone = ?').bind(phone).run();
  } catch (_) { /* 비치명적 */ }
}

// 남은 잠금 시간을 사람이 읽기 좋은 문구로 (초 → "N분")
export function fmtRetry(sec) {
  if (!sec || sec <= 60) return '1분';
  return Math.ceil(sec / 60) + '분';
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🛡️ 2026-08-03 (§11-16) — 「로그인 아닌 공개 관문」용 잠금 (같은 IP 기준)
//
//   위쪽(checkLockout/recordFailure/clearLockout)은 **계정 = 전화번호**를 잠근다.
//   그런데 가입 신청(/api/student-register)처럼 **로그인 전에 아무나 두드릴 수 있는 문**은
//   잠글 계정 자체가 없다. 유일한 관문이 5자리 반 코드(10000~99999 = 9만 가지)인데
//   횟수 제한이 없으면 자동 프로그램이 전수 대입으로 맞는 코드를 찾아낼 수 있다.
//   → 잠그는 대상만 **접속 IP**로 바꾸고, 잠금 규칙(5회 → 1·5·15·60분, 자동 해제)은
//     로그인과 **글자 그대로 같은 것**을 쓴다(MAX_FAILS_BEFORE_LOCK · LOCK_MINUTES · lockMsFor).
//
//   ⚠️ 표를 따로 쓴다(gate_lockouts). login_lockouts 에 IP 를 섞으면
//      「이 학생 계정이 잠겼나」를 볼 때 IP 행이 같이 걸려 판단을 흐린다.
//   ⚠️ 키에 관문 이름을 붙인다('register-code|1.2.3.4') → 나중에 다른 공개 관문
//      (문의 폼 등)에 같은 장치를 걸어도 서로의 카운터를 건드리지 않는다.
//   ⚠️ IP 를 못 얻으면 빈 키를 돌려준다 → 모든 함수가 그냥 통과시킨다(가용성 우선).
//      IP 가 없다고 정상 가입을 막는 쪽이 더 큰 사고다.
// ═══════════════════════════════════════════════════════════════════════════════

// ⏳ 오래된 실패는 잊는다 — **IP 관문 전용** (로그인 잠금에는 적용 안 함).
//
//   왜 필요한가: 이 관문의 열쇠는 계정이 아니라 **접속 IP** 다.
//   한국 이동통신사는 수많은 가입자를 IP 몇 개 뒤에 묶어 쓴다(공용 IP).
//   실패 기록이 영원히 남으면, 몇 달 전 남이 남긴 실패 4회 위에
//   오늘 처음 온 정직한 학부모가 오타 한 번을 얹는 순간 곧바로 잠긴다.
//   누적이 8회를 넘긴 IP는 오타 한 번에 바로 60분 잠금이다 — 「가입이 안 돼요」 전화의 원인.
//
//   그래서 마지막 실패로부터 24시간이 지났으면 카운터를 0부터 다시 센다.
//   공격자 입장에선 IP 하나당 하루 4번 = 9만 가지를 훑는 데 수십 년이라 방어력은 그대로다.
//
//   ⚠️ 로그인(recordFailure)에는 일부러 적용하지 않는다. 거긴 열쇠가 개인 전화번호라
//      남의 실패가 섞이지 않고, 검증까지 끝난 동작을 건드릴 이유가 없다.
const GATE_FORGET_MS = 24 * 60 * 60 * 1000;

async function ensureGateTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS gate_lockouts (' +
      'gate_key TEXT PRIMARY KEY, ' +
      'fail_count INTEGER NOT NULL DEFAULT 0, ' +
      'locked_until INTEGER, ' +      // epoch ms; null = 잠금 아님
      'last_fail_at INTEGER)'
  ).run();
}

// 요청 → 잠금 키('관문이름|IP'). IP 를 못 얻으면 '' (= 잠금 비활성).
export function gateKeyFromRequest(request, gate) {
  const ip = clientIp(request);
  if (!ip) return '';
  return String(gate || 'gate') + '|' + ip;
}

// 현재 잠금 상태 → { locked, retryAfterSec, failCount }
export async function checkGateLockout(env, key) {
  if (!key) return { locked: false, retryAfterSec: 0, failCount: 0 };
  try {
    await ensureGateTable(env);
    const row = await env.DB.prepare(
      'SELECT fail_count, locked_until FROM gate_lockouts WHERE gate_key = ?'
    ).bind(key).first();
    if (!row) return { locked: false, retryAfterSec: 0, failCount: 0 };
    const now = Date.now();
    if (row.locked_until && row.locked_until > now) {
      return {
        locked: true,
        retryAfterSec: Math.ceil((row.locked_until - now) / 1000),
        failCount: row.fail_count || 0,
      };
    }
    return { locked: false, retryAfterSec: 0, failCount: row.fail_count || 0 };
  } catch (_) {
    return { locked: false, retryAfterSec: 0, failCount: 0 };
  }
}

// 실패 1회 기록(+필요 시 잠금) → { locked, retryAfterSec, failCount }
export async function recordGateFailure(env, key) {
  if (!key) return { locked: false, retryAfterSec: 0, failCount: 0 };
  try {
    await ensureGateTable(env);
    const row = await env.DB.prepare(
      'SELECT fail_count, last_fail_at FROM gate_lockouts WHERE gate_key = ?'
    ).bind(key).first();
    const now = Date.now();
    // ⏳ 마지막 실패로부터 GATE_FORGET_MS(24시간)가 지났으면 카운터를 0부터 다시 센다.
    //    (위 GATE_FORGET_MS 주석 참고 — 공용 IP 때문에 남의 옛 실패가 쌓이는 걸 막는다.)
    const 이전실패 = (row && row.last_fail_at && (now - row.last_fail_at) > GATE_FORGET_MS)
      ? 0
      : ((row && row.fail_count) || 0);
    const failCount = 이전실패 + 1;
    const lockMs = lockMsFor(failCount);
    const lockedUntil = lockMs > 0 ? now + lockMs : null;
    await env.DB.prepare(
      'INSERT INTO gate_lockouts (gate_key, fail_count, locked_until, last_fail_at) VALUES (?,?,?,?) ' +
      'ON CONFLICT(gate_key) DO UPDATE SET fail_count=excluded.fail_count, ' +
      'locked_until=excluded.locked_until, last_fail_at=excluded.last_fail_at'
    ).bind(key, failCount, lockedUntil, now).run();
    return {
      locked: !!lockedUntil,
      retryAfterSec: lockMs > 0 ? Math.ceil(lockMs / 1000) : 0,
      failCount,
    };
  } catch (_) {
    return { locked: false, retryAfterSec: 0, failCount: 0 };
  }
}

// 관문 통과 → 카운터 삭제. 비치명적.
//   📓 이게 있어야 학원·학교 공용 와이파이에서 여러 명이 가입해도
//      정상 신청자(코드를 제대로 받은 사람)가 남의 실패에 발목 잡히지 않는다.
export async function clearGateLockout(env, key) {
  if (!key) return;
  try {
    await env.DB.prepare('DELETE FROM gate_lockouts WHERE gate_key = ?').bind(key).run();
  } catch (_) { /* 비치명적 */ }
}

// 잠금까지 몇 번 남았는지 (안내 문구용). 잠긴 뒤엔 0.
export function gateTriesLeft(failCount) {
  return Math.max(0, MAX_FAILS_BEFORE_LOCK - (failCount || 0));
}
