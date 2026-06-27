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
