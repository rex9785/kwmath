/* ════════════════════════════════════════════════════════════════════════
 * app-native.js — kwmath 앱(Capacitor) 네이티브 기능 공용 레이어
 * ────────────────────────────────────────────────────────────────────────
 * 목적: 웹 화면(kwmath.co.kr/portal 등)이 앱 안에서 열렸을 때 진짜 네이티브
 *       기능(햅틱·로컬알림·공유·배지·생체인증)을 호출할 수 있게 해준다.
 *       → 애플 Guideline 4.2.2(미완성/웹같음) 반려의 근본 대응: "웹 껍데기"가
 *         아니라 OS 기능을 실제로 쓰는 앱임을 코드로 증명한다.
 *
 * 원리 (portal.html의 FCM 브리지와 동일한 저수준 방식):
 *   - 이 사이트는 Capacitor 코어/플러그인 JS를 번들하지 않는다.
 *     → window.Capacitor.Plugins 는 비어 있음(=고수준 API 못 씀).
 *   - 대신 코어가 WebView에 주입하는 저수준 브리지를 직접 쓴다:
 *       window.Capacitor.isNativePlatform()            → 앱 감지
 *       window.Capacitor.nativePromise(js, method, opt) → 플러그인 호출(Promise)
 *   - 네이티브에 해당 플러그인이 설치돼 있어야 실제 동작. 없으면 안전하게 무시.
 *
 * 안전성: 앱이 아니거나(=웹/PWA), 플러그인 미설치거나, 브리지가 없으면
 *         모든 호출은 조용히 no-op(빈 결과)으로 끝난다. 웹/PWA/구버전 앱을
 *         절대 깨뜨리지 않는다.
 *
 * 지금 자동 적용되는 것: 버튼/링크 탭 시 가벼운 햅틱(즉시 체감되는 네이티브감).
 * 예약(수업 10분 전 알림 등) 타이밍/문구 세부는 나중에 웹만 고쳐 조정 가능
 * (앱 재빌드 불필요). 이 파일은 "기능 자체"를 심는 레이어다.
 *
 * 작성: Claude (Cowork) · 2026-07-03 · 문서/주석 존댓말 규칙 적용
 * 갱신: 2026-07-03 · Face ID 잠금·공유 폴백·biometryAvailable 헬퍼 추가.
 * Tier2: 2026-07-03 · 인앱 브라우저(openLink, jsName "Browser")·오프라인 배너 추가.
 *        둘 다 앱 전용이며, 플러그인/네트워크가 없어도 안전하게 폴백한다.
 * ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── 앱(네이티브) 여부 ──────────────────────────────────────────────
  function isApp() {
    try {
      return !!(window.Capacitor &&
        typeof window.Capacitor.isNativePlatform === 'function' &&
        window.Capacitor.isNativePlatform());
    } catch (e) { return false; }
  }

  function platform() {
    try {
      var C = window.Capacitor;
      return (C && typeof C.getPlatform === 'function') ? C.getPlatform() : '';
    } catch (e) { return ''; }
  }

  // 저수준 브리지 사용 가능 여부
  function hasBridge() {
    try {
      return isApp() && typeof window.Capacitor.nativePromise === 'function';
    } catch (e) { return false; }
  }

  // ── 공용 호출기: 어떤 상황에서도 reject로 앱을 깨지 않는다 ──────────
  //    앱/브리지/플러그인이 없거나 호출이 실패하면 항상 resolve(null).
  function np(jsName, method, opts) {
    if (!hasBridge()) return Promise.resolve(null);
    try {
      var p = window.Capacitor.nativePromise(jsName, method, opts || {});
      // nativePromise가 Promise가 아닐 가능성까지 방어
      if (p && typeof p.then === 'function') {
        return p.then(function (r) { return r; })
                .catch(function () { return null; });
      }
      return Promise.resolve(p);
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 1) Haptics — 촉각 피드백 (jsName: "Haptics")
  //    impact{style: HEAVY|MEDIUM|LIGHT}, notification{type: SUCCESS|WARNING|ERROR},
  //    vibrate{duration: ms}
  // ══════════════════════════════════════════════════════════════════
  function haptic(style) {
    var s = (style || 'LIGHT').toUpperCase();
    if (s !== 'HEAVY' && s !== 'MEDIUM' && s !== 'LIGHT') s = 'LIGHT';
    return np('Haptics', 'impact', { style: s });
  }
  function hapticNotify(type) {
    var t = (type || 'SUCCESS').toUpperCase();
    if (t !== 'SUCCESS' && t !== 'WARNING' && t !== 'ERROR') t = 'SUCCESS';
    return np('Haptics', 'notification', { type: t });
  }
  function vibrate(ms) {
    return np('Haptics', 'vibrate', { duration: (ms > 0 ? ms : 300) });
  }

  // ══════════════════════════════════════════════════════════════════
  // 2) LocalNotifications — 로컬 예약 알림 (jsName: "LocalNotifications")
  //    schedule{notifications:[{id:Int, title, body, schedule:{at: Date}}]}
  //    ⚠️ 네이티브가 schedule.at 을 Date로 읽어 ISO8601로 변환한다 → 반드시 Date 객체로 전달.
  //    권한은 푸시(FCM)와 동일한 UNUserNotificationCenter 인증을 공유하므로
  //    앱이 이미 푸시 권한을 받았다면 별도 프롬프트 없이 예약된다. 안전하게 확인/요청도 제공.
  // ══════════════════════════════════════════════════════════════════
  function notifPermission() {
    return np('LocalNotifications', 'checkPermissions', {});
  }
  function requestNotifPermission() {
    return np('LocalNotifications', 'requestPermissions', {});
  }
  // opts: {id, title, body, at:(Date|ms timestamp|ISO string), inSeconds}
  function scheduleNotification(opts) {
    opts = opts || {};
    var id = (typeof opts.id === 'number') ? opts.id
           : Math.floor(Date.now() % 2147483000) + 1; // 32-bit 안전 범위 양수
    var at = opts.at;
    if (typeof opts.inSeconds === 'number' && opts.inSeconds > 0) {
      at = new Date(Date.now() + opts.inSeconds * 1000);
    } else if (typeof at === 'number') {
      at = new Date(at);
    } else if (typeof at === 'string') {
      at = new Date(at);
    }
    var one = { id: id, title: opts.title || '알림', body: opts.body || '' };
    if (at instanceof Date && !isNaN(at.getTime())) {
      one.schedule = { at: at };  // 네이티브가 Date로 파싱
    }
    return np('LocalNotifications', 'schedule', { notifications: [one] })
      .then(function (r) { return (r == null) ? null : id; }); // 성공 시 id 반환
  }
  function cancelNotification(id) {
    if (typeof id !== 'number') return Promise.resolve(null);
    return np('LocalNotifications', 'cancel', { notifications: [{ id: id }] });
  }
  function pendingNotifications() {
    return np('LocalNotifications', 'getPending', {});
  }

  // ══════════════════════════════════════════════════════════════════
  // 3) Share — 시스템 공유 시트 (jsName: "Share")
  //    share{title, text, url, dialogTitle}
  // ══════════════════════════════════════════════════════════════════
  function share(opts) {
    opts = opts || {};
    var payload = {};
    if (opts.title) payload.title = opts.title;
    if (opts.text)  payload.text  = opts.text;
    if (opts.url)   payload.url   = opts.url;
    payload.dialogTitle = opts.dialogTitle || '공유';
    return np('Share', 'share', payload);
  }
  function canShare() {
    return np('Share', 'canShare', {});
  }

  // ══════════════════════════════════════════════════════════════════
  // 4) Badge — 앱 아이콘 배지 (jsName: "Badge")
  //    set{count:Int}, clear, get, increase, decrease
  // ══════════════════════════════════════════════════════════════════
  function setBadge(count) {
    var n = (typeof count === 'number' && count >= 0) ? Math.floor(count) : 0;
    return np('Badge', 'set', { count: n });
  }
  function clearBadge() {
    return np('Badge', 'clear', {});
  }

  // ══════════════════════════════════════════════════════════════════
  // 5) Biometric — 생체 인증 로그인 (jsName: "BiometricAuthNative")
  //    ⚠️ jsName은 "BiometricAuth"가 아니라 "BiometricAuthNative" (아니면 조용히 no-op).
  //    checkBiometry{} → {isAvailable, biometryType, ...}
  //    internalAuthenticate{reason, cancelTitle, iosFallbackTitle, allowDeviceCredential}
  //      → 성공 시 resolve, 실패/취소 시 reject (여기선 catch로 흡수해 결과 객체로 정규화)
  // ══════════════════════════════════════════════════════════════════
  function checkBiometry() {
    return np('BiometricAuthNative', 'checkBiometry', {});
  }
  // opts: {reason, cancelTitle, fallbackTitle, allowDeviceCredential}
  // 반환: {success:true} 또는 {success:false, reason:'...'} — 절대 throw하지 않음
  function authenticate(opts) {
    opts = opts || {};
    if (!hasBridge()) return Promise.resolve({ success: false, reason: 'not-app' });
    var payload = {
      reason: opts.reason || '본인 확인을 위해 인증해주세요.',
      cancelTitle: opts.cancelTitle || '취소',
      iosFallbackTitle: (opts.fallbackTitle != null) ? opts.fallbackTitle : '비밀번호 입력',
      allowDeviceCredential: !!opts.allowDeviceCredential
    };
    try {
      var p = window.Capacitor.nativePromise('BiometricAuthNative', 'internalAuthenticate', payload);
      if (p && typeof p.then === 'function') {
        return p.then(function () { return { success: true }; })
                .catch(function (e) {
                  var msg = (e && (e.message || e.code)) ? (e.message || e.code) : 'failed';
                  return { success: false, reason: String(msg) };
                });
      }
      return Promise.resolve({ success: true });
    } catch (e) {
      return Promise.resolve({ success: false, reason: 'bridge-error' });
    }
  }

  // 생체 사용 가능 여부 → boolean (플러그인/기기마다 응답 키가 달라 관대하게 파싱)
  function biometryAvailable() {
    if (!hasBridge()) return Promise.resolve(false);
    return checkBiometry().then(function (r) {
      if (!r) return false;
      if (typeof r.isAvailable === 'boolean') return r.isAvailable;      // aparajita: {isAvailable, biometryType,...}
      if (typeof r.available === 'boolean') return r.available;
      if (r.biometryType && r.biometryType !== 0 && r.biometryType !== 'none') return true;
      return false;
    }).catch(function () { return false; });
  }

  // ══════════════════════════════════════════════════════════════════
  // Face ID 잠금 — 저장된 로그인 세션을 "복원 전에 생체인증"으로 잠근다.
  //   플래그는 localStorage에 저장(기기별). 실제 잠금은 앱+플래그+생체가능일 때만 작동.
  //   웹/PWA/생체불가에선 자동으로 열림(fail-open) → 잠겨서 못 들어가는 사고 없음.
  // ══════════════════════════════════════════════════════════════════
  var FACE_FLAG = 'kw_faceid_lock';
  function faceLockEnabled() {
    try { return localStorage.getItem(FACE_FLAG) === '1'; } catch (e) { return false; }
  }
  function setFaceLock(on) {
    try { on ? localStorage.setItem(FACE_FLAG, '1') : localStorage.removeItem(FACE_FLAG); } catch (e) {}
  }
  // 지금 실제로 잠금을 걸어야 하는 상태인가? (앱 + 플래그 ON + 생체 사용가능) → boolean Promise
  function faceLockActive() {
    if (!hasBridge() || !faceLockEnabled()) return Promise.resolve(false);
    return biometryAvailable();
  }

  // ══════════════════════════════════════════════════════════════════
  // 공유 — 앱이면 네이티브 시트, 아니면 웹(navigator.share) → 클립보드 폴백.
  //   반환: {ok, via} (via: native|web|clipboard|none)
  // ══════════════════════════════════════════════════════════════════
  function shareOrFallback(opts) {
    opts = opts || {};
    if (hasBridge()) {
      return share(opts).then(function () { return { ok: true, via: 'native' }; });
    }
    try {
      if (navigator && typeof navigator.share === 'function') {
        var d = {};
        if (opts.title) d.title = opts.title;
        if (opts.text)  d.text  = opts.text;
        if (opts.url)   d.url   = opts.url;
        return navigator.share(d)
          .then(function () { return { ok: true, via: 'web' }; })
          .catch(function () { return { ok: false, via: 'web-cancel' }; });
      }
    } catch (e) {}
    try {
      if (navigator && navigator.clipboard && opts.url) {
        return navigator.clipboard.writeText(opts.url)
          .then(function () { return { ok: true, via: 'clipboard' }; })
          .catch(function () { return { ok: false, via: 'none' }; });
      }
    } catch (e) {}
    return Promise.resolve({ ok: false, via: 'none' });
  }

  // ══════════════════════════════════════════════════════════════════
  // 6) Browser — 인앱 사파리(SFSafariViewController) (jsName: "Browser")
  //    open{url}, close{}. @capacitor/browser 플러그인(이번 빌드에 추가).
  //    외부 링크를 앱 밖으로 튕기지 않고 앱 안 네이티브 브라우저 뷰로 연다
  //    → 세션 유지 + "웹 껍데기 아님"을 한 번 더 증명(4.2.2 대응 강화).
  //    ⚠️ 플러그인 미설치(구버전 앱)면 np가 null → window.open(시스템 브라우저)로 폴백.
  //       즉 웹 push가 새 빌드보다 먼저 나가도 링크가 죽지 않는다(fail-open).
  // ══════════════════════════════════════════════════════════════════
  function openLink(url) {
    if (!url) return Promise.resolve({ ok: false, via: 'none' });
    if (hasBridge()) {
      return np('Browser', 'open', { url: url }).then(function (r) {
        if (r === null) {                     // 플러그인 미설치/실패 → 안전 폴백
          try { window.open(url, '_blank'); } catch (e) {}
          return { ok: true, via: 'fallback' };
        }
        return { ok: true, via: 'native' };   // 네이티브 인앱 브라우저로 열림
      });
    }
    try { window.open(url, '_blank', 'noopener'); } catch (e) {}
    return Promise.resolve({ ok: true, via: 'web' });
  }
  function closeBrowser() { return np('Browser', 'close', {}); }

  // 앱에서만: 외부(다른 origin) 링크와 [data-inapp] 링크를 인앱 브라우저로 연다.
  //   - 웹/PWA에선 절대 가로채지 않음(기본 동작 그대로).
  //   - 이미 다른 핸들러가 처리(preventDefault)했으면 건드리지 않음.
  //   - [data-no-inapp]는 제외. tel:/mailto:/#/javascript:도 제외.
  function onLinkClick(ev) {
    if (!hasBridge()) return;
    if (ev.defaultPrevented) return;
    var t = ev.target;
    var a = (t && t.closest) ? t.closest('a') : null;
    if (!a || a.hasAttribute('data-no-inapp')) return;
    var abs = a.href;
    if (!abs || !/^https?:\/\//i.test(abs)) return;   // http(s)만
    var external = false;
    try { external = (new URL(abs)).origin !== window.location.origin; } catch (e) {}
    if (!external && !a.hasAttribute('data-inapp')) return;  // 같은 origin은 opt-in만
    ev.preventDefault();
    openLink(abs);
  }
  function wireInAppBrowser() {
    document.addEventListener('click', onLinkClick, false);
  }

  // ══════════════════════════════════════════════════════════════════
  // 7) 오프라인 배너 — 네트워크가 끊기면 앱 상단에 얇은 안내 바를 띄운다.
  //    앱에서만 노출(웹사이트 기본 경험은 그대로). 복구되면 자동으로 내려간다.
  //    DOM은 처음 오프라인이 될 때만 생성(온라인이면 아무 것도 안 만듦).
  // ══════════════════════════════════════════════════════════════════
  var _offlineBar = null;
  function ensureOfflineBar() {
    if (_offlineBar) return _offlineBar;
    var b = document.createElement('div');
    b.id = 'kw-offline-bar';
    b.textContent = '오프라인 상태예요. 인터넷 연결을 확인해 주세요.';
    b.setAttribute('role', 'status');
    b.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:99999',
      'padding:8px 12px', 'text-align:center',
      'font-size:13px', 'font-weight:700', 'color:#fff',
      'background:#c0392b', 'box-shadow:0 1px 4px rgba(0,0,0,0.2)',
      'transition:transform .25s ease', 'font-family:inherit'
    ].join(';');
    (document.body || document.documentElement).appendChild(b);
    _offlineBar = b;
    return b;
  }
  function updateOnline() {
    var online = (navigator.onLine !== false);
    if (online) { if (_offlineBar) _offlineBar.style.transform = 'translateY(-100%)'; return; }
    ensureOfflineBar().style.transform = 'translateY(0)';
  }
  function wireOfflineBanner() {
    if (!hasBridge()) return;                 // 앱에서만
    try {
      window.addEventListener('online', updateOnline, false);
      window.addEventListener('offline', updateOnline, false);
      updateOnline();
    } catch (e) {}
  }

  // ══════════════════════════════════════════════════════════════════
  // 자동 향상: 버튼/링크 탭 시 가벼운 햅틱 (지금 바로 체감되는 네이티브감)
  //   - 앱 안에서만 동작(웹/PWA는 no-op).
  //   - [data-no-haptic] 가 붙은 요소/조상은 제외.
  //   - 과도한 연타 방지를 위해 최소 간격 40ms 쓰로틀.
  // ══════════════════════════════════════════════════════════════════
  var _lastHaptic = 0;
  function tapTargetFrom(node) {
    var el = node, depth = 0;
    while (el && el.nodeType === 1 && depth < 6) {
      if (el.hasAttribute && el.hasAttribute('data-no-haptic')) return null;
      var tag = (el.tagName || '').toLowerCase();
      var role = el.getAttribute ? (el.getAttribute('role') || '') : '';
      if (el.hasAttribute && el.hasAttribute('data-haptic')) return el;
      if (tag === 'button' || tag === 'a' || tag === 'summary' || role === 'button') return el;
      if (el.classList && (el.classList.contains('btn') || el.classList.contains('button'))) return el;
      el = el.parentElement; depth++;
    }
    return null;
  }
  function onTap(ev) {
    if (!hasBridge()) return;
    var t = ev.target;
    if (!t) return;
    if (!tapTargetFrom(t)) return;
    var now = Date.now();
    if (now - _lastHaptic < 40) return;
    _lastHaptic = now;
    haptic('LIGHT');
  }
  function wireAutoHaptics() {
    // 캡처 단계 위임 → 동적으로 추가된 버튼에도 자동 적용.
    document.addEventListener('click', onTap, true);
  }

  // ── 공개 API ────────────────────────────────────────────────────────
  var KWNative = {
    // 상태
    isApp: isApp,
    platform: platform,
    available: hasBridge,     // 브리지로 네이티브 호출이 가능한 상태인지
    // Haptics
    haptic: haptic,
    hapticNotify: hapticNotify,
    vibrate: vibrate,
    // LocalNotifications
    notifPermission: notifPermission,
    requestNotifPermission: requestNotifPermission,
    scheduleNotification: scheduleNotification,
    cancelNotification: cancelNotification,
    pendingNotifications: pendingNotifications,
    // Share
    share: share,
    canShare: canShare,
    // Badge
    setBadge: setBadge,
    clearBadge: clearBadge,
    // Biometric
    checkBiometry: checkBiometry,
    authenticate: authenticate,
    biometryAvailable: biometryAvailable,
    // Face ID 잠금(세션 복원 게이트)
    faceLockEnabled: faceLockEnabled,
    setFaceLock: setFaceLock,
    faceLockActive: faceLockActive,
    // 공유(앱=네이티브 시트 / 웹=navigator.share→클립보드)
    shareOrFallback: shareOrFallback,
    // 인앱 브라우저(앱=네이티브 SFSafariViewController / 웹=새 탭). 폴백 안전.
    openLink: openLink,
    closeBrowser: closeBrowser,
    // 저수준 탈출구(고급): 직접 플러그인 호출이 필요할 때
    _call: np
  };
  window.KWNative = KWNative;

  // ── 초기화 ──────────────────────────────────────────────────────────
  function init() {
    try { wireAutoHaptics(); } catch (e) {}
    try { wireInAppBrowser(); } catch (e) {}   // Tier2: 외부/opt-in 링크 → 인앱 브라우저
    try { wireOfflineBanner(); } catch (e) {}   // Tier2: 오프라인 배너(앱 전용)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
