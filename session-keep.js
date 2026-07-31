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

/* ══════════════════════════════════════════════════════════════════════════
 * KWPush — 로그아웃하면 "이 폰"을 그 계정의 알림 명단에서 뺀다 (2026-07-31 신설 · 관우T 지시)
 *
 * 문제: 앱 FCM 기기토큰은 서버(R2 `fcm-tokens/{userId}.json`)에 쌓이는데 로그아웃해도 안 지워졌다.
 *       그래서 학생이 남의 폰으로 한 번만 로그인해도 그 폰이 계속 그 학생 알림을 받았다
 *       (2026-07-31 실제 발생 — 관우T 폰이 세정학원 학생 알림을 받음).
 * 해결: 등록할 때 remember()로 {userId → token}을 이 폰에 적어두고,
 *       로그아웃할 때 unregister()가 `DELETE /api/push-register-fcm`으로 그 기기 1개만 뺀다.
 *
 * 주의 5가지
 *  1) 반드시 **토큰까지 지정해서** 뺀다. userId만 보내면 그 계정의 다른 기기(가족 폰)까지 다 날아간다.
 *  2) `keepalive:true` — `location.href`로 화면이 바로 넘어가도 요청이 끝까지 간다.
 *  3) 한 폰에 여러 계정 기록이 남을 수 있어(예: `__admin__` + 데모 포털) **맵으로** 들고 있는다.
 *     그래서 unregister는 "누가 로그아웃하는지"를 받아야 엉뚱한 계정을 빼지 않는다.
 *       unregister('__admin__') → 그 id만  ·  unregister() → 예약(`__`) 아닌 id 전부(학생·학부모용)
 *  4) `__admin__` 같은 예약 id는 서버가 관리자 인증을 요구하므로 Authorization을 같이 보낸다.
 *     ☰ 로그아웃은 **capture 단계**에서 잡으므로 페이지가 세션키를 지우기 전 = 토큰이 아직 살아 있다.
 *  5) 확인창(confirm)이 있는 로그아웃(portal·me)은 여기서 자동으로 걸지 않는다.
 *     capture 단계에서 걸면 사용자가 '취소'를 눌러도 알림이 꺼져 버린다. → 그쪽은 confirm 통과 뒤 직접 호출.
 * ══════════════════════════════════════════════════════════════════════════ */
(function () {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;

  var REG_KEY = 'kwmath_fcm_reg';   // { "<userId>": "<fcm token>" }

  function load() {
    try { var o = JSON.parse(localStorage.getItem(REG_KEY) || '{}'); return (o && typeof o === 'object') ? o : {}; }
    catch (_) { return {}; }
  }
  function save(map) {
    try {
      if (!map || !Object.keys(map).length) localStorage.removeItem(REG_KEY);
      else localStorage.setItem(REG_KEY, JSON.stringify(map));
    } catch (_) {}
  }
  function isReserved(id) { return String(id || '').indexOf('__') === 0; }
  function adminToken() {
    try {
      return sessionStorage.getItem('kwmath_admin_pw')
          || localStorage.getItem('kwmath_admin_pw')
          || localStorage.getItem('kwmath_admin_token') || '';
    } catch (_) { return ''; }
  }

  // 등록 성공 시 호출 — 나중에 로그아웃할 때 뺄 수 있게 이 폰에 적어둔다.
  function remember(userId, token) {
    if (!userId || !token) return;
    var m = load(); m[userId] = token; save(m);
  }

  // userId 지정 → 그 계정에서만 이 기기를 뺀다. 생략 → 예약 아닌(학생·학부모) 계정 전부.
  function unregister(userId) {
    var m = load();
    var ids = userId ? [userId] : Object.keys(m).filter(function (k) { return !isReserved(k); });
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], tok = m[id];
      if (!tok) continue;
      var h = { 'Content-Type': 'application/json' };
      if (isReserved(id)) {
        var t = adminToken();
        if (!t) continue;                      // 관리자 인증이 없으면 어차피 403 — 기록은 남겨둔다
        h['Authorization'] = 'Bearer ' + t;
      }
      try {
        fetch('/api/push-register-fcm', {
          method: 'DELETE', headers: h, keepalive: true,
          body: JSON.stringify({ userId: id, token: tok })
        }).catch(function () {});
      } catch (_) {}
      delete m[id];
    }
    save(m);
  }

  window.KWPush = { remember: remember, unregister: unregister };

  // ☰ 메뉴 로그아웃(원장·조교 16개 화면)은 확인창이 없어 여기서 한 번에 걸어둔다 → 그 16개 파일은 손 안 댐.
  try {
    document.addEventListener('click', function (ev) {
      var t = ev && ev.target;
      if (t && t.closest && t.closest('.kwnav-logout')) unregister('__admin__');
    }, true);
  } catch (_) {}
})();
