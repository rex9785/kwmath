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

  var REG_KEY = 'kwmath_fcm_reg';   // { "<userId>": { t:"<fcm token>", at:<보낸시각ms> } }
                                    //   구형(2026-07-31 이전)은 값이 문자열이라 tokOf()로 둘 다 읽는다.

  function load() {
    try { var o = JSON.parse(localStorage.getItem(REG_KEY) || '{}'); return (o && typeof o === 'object') ? o : {}; }
    catch (_) { return {}; }
  }
  function tokOf(v) { return (v && typeof v === 'object') ? (v.t || '') : (v || ''); }
  function atOf(v) { return (v && typeof v === 'object' && v.at) ? v.at : 0; }
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
    var m = load(); m[userId] = { t: token, at: Date.now() }; save(m);
  }

  // userId 지정 → 그 계정에서만 이 기기를 뺀다. 생략 → 예약 아닌(학생·학부모) 계정 전부.
  //   reason 은 서버 감사로그(audit_log)에 그대로 적힌다. 나중에 "왜 알림이 끊겼나"를 되짚을 때
  //   '로그아웃'인지 '계정삭제'인지가 구분돼야 해서 붙인다. 안 넘기면 '미지정'으로 남는다.
  function unregister(userId, reason) {
    var m = load();
    var ids = userId ? [userId] : Object.keys(m).filter(function (k) { return !isReserved(k); });
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], tok = tokOf(m[id]);
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
          body: JSON.stringify({ userId: id, token: tok, reason: reason || '로그아웃' })
        }).catch(function () {});
      } catch (_) {}
      delete m[id];
    }
    save(m);
  }

  /* ── ensure() — "로그인했으면 어느 화면으로 들어왔든 알림이 빠짐없이 온다" (2026-07-31 · 관우T 지시)
   *
   * 문제: 앱 FCM 등록 코드가 portal.html(학생·학부모)과 admin-qna.html(원장·조교) **화면 안에만** 있었다.
   *       그래서 원장이 로그아웃 후 다시 로그인하고 /admin이나 ☰의 다른 화면으로 들어가면,
   *       「질문답변」 화면을 한 번 열기 전까지 이 폰이 알림 명단에 안 들어갔다. = 알림이 조용히 빠졌다.
   * 해결: 모든 화면이 싣는 이 파일에서 페이지 로드 때마다 조용히 확인해 채운다.
   *
   * 지키는 것 4가지
   *  1) **권한창을 절대 띄우지 않는다.** 이미 허용된 경우에만 토큰이 나온다. 안 나오면 조용히 포기하고,
   *     켜는 건 기존 화면의 알림 버튼이 담당한다. (아무 화면에서나 권한창이 뜨면 안 된다)
   *  2) **토스트·알럿도 안 띄운다.** 배경 보정이라 사용자 눈에 보이면 안 된다.
   *  3) 이 폰에 로그인돼 있는 **모든 신분**에 등록한다. 관우T 폰처럼 `__admin__` + 포털 계정이
   *     동시에 있으면 둘 다. (예약 id `__`는 서버가 관리자 인증을 요구 → Authorization 동봉)
   *  4) 같은 토큰을 이미 12시간 안에 보냈으면 건너뛴다. 매 페이지마다 서버를 두드리지 않기 위해서다.
   *     토큰이 바뀌었으면 12시간이 안 지났어도 바로 보낸다(FCM 토큰은 조용히 갱신된다).
   */
  var FRESH_MS = 12 * 60 * 60 * 1000;

  function adminLoggedIn() {
    try {
      return !!(localStorage.getItem('kwmath_admin_token')
             || sessionStorage.getItem('kwmath_admin_pw')
             || localStorage.getItem('kwmath_admin_pw'));
    } catch (_) { return false; }
  }
  function portalIdentity() {
    try {
      var t = sessionStorage.getItem('kwmath_portal_token') || localStorage.getItem('kwmath_portal_token') || '';
      var p = sessionStorage.getItem('kwmath_portal_phone') || localStorage.getItem('kwmath_portal_phone') || '';
      return (t && p) ? p : '';
    } catch (_) { return ''; }
  }
  function currentIds() {
    var ids = [];
    if (adminLoggedIn()) ids.push('__admin__');
    var p = portalIdentity(); if (p) ids.push(p);
    return ids;
  }

  function isInApp() {
    try { return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()); }
    catch (_) { return false; }
  }
  // 원격+번들 앱이라 window.Capacitor.Plugins는 비어 있다 → 브리지 저수준 API로 직접 호출.
  //   (portal.html·admin-qna.html의 getPN()과 같은 구조. 그쪽은 UI까지 다루고, 여기는 토큰만 받는다.)
  function getPN() {
    if (!isInApp()) return null;
    var C = window.Capacitor;
    var plat = (typeof C.getPlatform === 'function') ? C.getPlatform() : '';
    if (typeof C.nativePromise !== 'function' || typeof C.nativeCallback !== 'function') {
      if (C.Plugins && C.Plugins.PushNotifications) return { core: C.Plugins.PushNotifications };
      return null;
    }
    // iOS는 코어 PushNotifications가 APNs 토큰(FCM 비호환)을 주므로 FirebaseMessaging을 쓴다.
    var js = (plat === 'ios') ? 'FirebaseMessaging' : 'PushNotifications';
    return {
      ios: plat === 'ios',
      check: function () { return C.nativePromise(js, 'checkPermissions', {}); },
      getToken: function () { return C.nativePromise('FirebaseMessaging', 'getToken', {}); },
      register: function () { return C.nativePromise('PushNotifications', 'register', {}); },
      onRegistration: function (cb) {
        C.nativeCallback('PushNotifications', 'addListener', { eventName: 'registration' }, function (d) {
          if (d && d.value) cb(d.value);
        });
      }
    };
  }

  // 토큰 1개를 지금 로그인된 모든 신분에 등록한다(필요한 것만).
  function pushToken(tok) {
    if (!tok) return;
    var m = load(), now = Date.now(), ids = currentIds();
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], cur = m[id];
      if (tokOf(cur) === tok && (now - atOf(cur)) < FRESH_MS) continue;   // 최근에 같은 걸 보냈다 → 생략
      var h = { 'Content-Type': 'application/json' };
      if (isReserved(id)) {
        var t = adminToken();
        if (!t) continue;
        h['Authorization'] = 'Bearer ' + t;
      }
      try {
        fetch('/api/push-register-fcm', {
          method: 'POST', headers: h,
          body: JSON.stringify({ userId: id, token: tok, via: 'ensure' })
        }).then(function (r) { return r && r.ok; }).catch(function () {});
      } catch (_) { continue; }
      remember(id, tok);
      m = load();
    }
  }

  var _busy = false;
  function ensure() {
    if (_busy) return;
    var ids = currentIds();
    if (!ids.length) return;                 // 로그아웃 상태 → 아무것도 안 한다
    var PN = getPN();
    _busy = true;
    setTimeout(function () { _busy = false; }, 15000);   // 중복 실행만 막고 곧 푼다
    if (!PN) return;                         // 앱이 아니면(웹) 여기서 끝 — 웹은 기존 Web Push 경로
    try {
      if (PN.core) {                         // 코어 플러그인이 번들된 드문 경우
        PN.core.addListener('registration', function (t) { if (t && t.value) pushToken(t.value); });
        PN.core.checkPermissions().then(function (p) { if (p && p.receive === 'granted') PN.core.register(); }).catch(function () {});
        return;
      }
      PN.check().then(function (p) {
        if (!p || p.receive !== 'granted') return;   // 권한이 없으면 조용히 끝 — 권한창은 띄우지 않는다
        if (PN.ios) {
          PN.getToken().then(function (r) { pushToken(r && r.token); }).catch(function () {});
        } else {
          PN.onRegistration(pushToken);
          PN.register().catch(function () {});
        }
      }).catch(function () {});
    } catch (_) {}
  }

  window.KWPush = { remember: remember, unregister: unregister, ensure: ensure };

  // ☰ 메뉴 로그아웃(원장·조교 16개 화면)은 확인창이 없어 여기서 한 번에 걸어둔다 → 그 16개 파일은 손 안 댐.
  try {
    document.addEventListener('click', function (ev) {
      var t = ev && ev.target;
      if (t && t.closest && t.closest('.kwnav-logout')) unregister('__admin__');
    }, true);
  } catch (_) {}

  /* 언제 도느냐 —
   *   로드 직후 한 번만으로는 부족하다. 로그인 화면에서 시작하면 그 시점엔 아직 로그인 전이라
   *   "할 게 없다"로 끝나 버리고, 같은 화면에서 로그인해도 다시 안 돌기 때문이다(= 원래 구멍 그대로).
   *   그래서 "지금 이 폰에 누가 로그인돼 있나"를 4초마다 보고, **바뀌었을 때만** 돈다.
   *   로그아웃하면 기억을 비워, 나중에 다시 로그인하면 또 돈다. (읽는 건 localStorage뿐 — 통신 없음)
   */
  var _lastSig = '';
  function watch() {
    var sig = currentIds().join(',');
    if (!sig) { _lastSig = ''; return; }
    if (sig === _lastSig) return;
    _lastSig = sig;
    ensure();
  }
  try {
    setTimeout(watch, 2500);          // 페이지 자신의 로그인·복원 코드가 먼저 끝나도록 양보
    setInterval(watch, 4000);
  } catch (_) {}
})();
