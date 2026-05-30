// /api/_errors.js — 공통 에러 응답 헬퍼
//
// 목적: 노션/DB/저장소 원본 에러 메시지(데이터베이스 ID, integration 이름 등)가
//       클라이언트로 새는 것을 막는다. 원본은 서버 로그(console.error)에만 남기고,
//       클라이언트에는 친절한 한글 메시지 + 추적용 request_id만 내려준다.
//
// 사용:
//   import { safeError } from './_errors.js';
//   } catch (e) { return safeError(e, env); }
//
//   // 상태코드/메시지 커스텀:
//   return safeError(e, env, { status: 502, message: '결제 서버 응답이 지연되고 있어요.' });
//
// 참고: 프론트엔드는 응답의 data.error 를 화면에 그대로 표시하므로,
//       error 필드는 사람이 읽을 수 있는 한글 문장으로 유지한다.

function newRequestId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID().slice(0, 8);
    }
  } catch (_) {}
  return 'e' + Date.now().toString(36).slice(-7);
}

// 서버 로그에만 원본 에러를 남긴다 (클라이언트로 가지 않음)
export function logError(e, requestId) {
  const id = requestId || newRequestId();
  try {
    const detail = (e && (e.stack || e.message)) || (typeof e === 'string' ? e : JSON.stringify(e));
    console.error('[' + id + ']', detail);
  } catch (_) {
    try { console.error('[' + id + '] (unprintable error)'); } catch (__) {}
  }
  return id;
}

// 500류 서버 오류 응답. error 필드는 친절한 한글 + 참조ID.
export function safeError(e, env, opts) {
  const o = opts || {};
  const status = o.status || 500;
  const baseMsg = o.message || '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
  const requestId = newRequestId();
  logError(e, requestId);
  return Response.json({
    error: baseMsg + ' (참조: ' + requestId + ')',
    code: 'server_error',
    request_id: requestId,
  }, { status });
}
