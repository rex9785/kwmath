/* session-keep.js — 원장·조교 "계속 로그인" 수신부 (2026-07-29 신설 · 관우T 지시)
 *
 * 문제: 원장(adm_)·조교(ast_) 토큰은 만료시각이 토큰 안에 서명돼 박히는 무상태 토큰이라,
 *       서버가 나중에 늘려줄 수가 없다. 그래서 30일이 지나면 매일 쓰고 있어도 튕겼다.
 * 해결: 서버(functions/_middleware.js)가 "만료를 다시 30일 뒤로 민 새 토큰"을 만들어
 *       응답헤더 `X-Kw-Session`으로 내려준다. 이 파일은 그걸 받아 localStorage에 덮어쓰기만 한다.
 *       (발급 후 하루 지났을 때만 내려오므로 매 요청마다 쓰지 않는다.)
 *
 * 주의 3가지
 *  1) 페이지가 이미 읽어둔 token 변수는 건드리지 않는다. 그 토큰은 아직 유효하고,
 *     새 토큰은 다음 페이지 로드 때 자연스럽게 쓰인다. (지금 화면을 흔들지 않기 위해)
 *  2) localStorage에 토큰이 없으면(=로그아웃 상태) 절대 새로 심지 않는다. 로그아웃을 되살리면 안 된다.
 *  3) 학생·학부모 페이지에 이 파일이 실려도 무해하다 — 그쪽은 이 헤더가 아예 안 내려온다.
 *     (학생·학부모 토큰의 같은 기능은 서버 functions/api/_auth.js가 R2에서 알아서 처리한다.)
 */
(function () {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;

  var KEY = 'kwmath_admin_token';
  var origFetch = window.fetch;

  window.fetch = function () {
    return origFetch.apply(window, arguments).then(function (res) {
      try {
        var t = res && res.headers ? res.headers.get('X-Kw-Session') : null;
        if (t && (t.indexOf('adm_') === 0 || t.indexOf('ast_') === 0)) {
          if (localStorage.getItem(KEY)) localStorage.setItem(KEY, t);   // 로그인 상태일 때만 갱신
        }
      } catch (_) { /* 갱신 실패는 이번 요청과 무관 — 다음 접속 때 다시 내려온다 */ }
      return res;
    });
  };
})();
