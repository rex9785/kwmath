/* kwnav.js — ☰ 메뉴에 "원장 전용" 화면을 채워 넣는다 (2026-07-29 신설)
 *
 * ▣ 무엇이 문제였나
 *   관리 화면 16장에 붙어 있는 ☰ 메뉴는 어느 페이지든 항상 같은 9개였다:
 *     질문 답변 · 학생 · 클리닉 명단 · 클리닉 총평 · 성적 · 리포트 · 수업자료 · 테스트 · 근무기록
 *   이 9개는 전부 "조교도 쓰는 화면"이다. 그래서 원장 전용 화면 9장
 *     상담 문의함 · 알림 보내기 · 과제 제출함 · 인강 신청·해제 · 공부 랭킹 · 방문 통계 · 운영진 관리
 *     · 진단평가 보고서(2026-07-30 추가 — 그땐 홈 카드조차 없어 주소를 직접 쳐야 했다.
 *       2026-08-03 홈에도 카드가 생겼다 → 이 줄은 "다른 관리 화면에서 곧장 건너가는 길"로 남는다)
 *     · 변경이력(2026-07-31 추가 — 감사로그 열람 화면. 역시 홈 카드가 없다)
 *   은 메뉴에 아예 없었다. 원장이 「알림 보내기」에서 「상담 문의함」으로 가려면
 *   기기 뒤로가기 → 홈 → 19개 카드에서 찾기, 매번 이 길을 걸어야 했다.
 *
 *   ⚠️ 점검문서(4관점_앱점검_20260729.md 1-7·5-2)는 이 불편의 원인을 "admin.html에 kwnav가 없어서"로
 *      적었지만 그건 아니다. 홈에는 19개 카드가 이미 다 있어서 홈에 메뉴를 또 붙여도 얻는 게 없다.
 *      진짜 원인은 "메뉴 목록이 조교 기준 9개로 고정"이었다. 그래서 홈은 그대로 두고 목록을 고쳤다.
 *
 * ▣ 어떻게 고쳤나 — 기존 코드를 지우지 않고 "덧붙이는" 방식
 *   각 페이지의 인라인 네비 스크립트(열고 닫기 · 현재 페이지 표시 · 로그아웃)는 그대로 둔다.
 *   이 파일은 그 스크립트 **뒤에** 실려서, 원장일 때만 항목 7개를 #kwnavPop에 끼워 넣는다.
 *   → 16개 페이지에서 지운 코드가 0줄이다. 되돌리려면 <script src="/kwnav.js"> 한 줄만 빼면 된다.
 *   → 앞으로 원장 메뉴를 바꿀 때 고칠 곳은 이 파일 한 군데다(16벌 아님).
 *
 * ▣ 원장·조교 구분 (여기 틀리면 조교에게 원장 메뉴가 보인다 — 반드시 이 순서)
 *   조교 : kwmath_admin_pw 가 'ast_' 로 시작  (sessionStorage 또는 localStorage)
 *   원장 : localStorage.kwmath_admin_token 이 있음  (원장은 admin_pw 를 애초에 저장하지 않는다
 *          — portal.html:727-731 참고. 그래서 기존 kwnav의 `/^ast_/ ? staff-home : admin` 판정이
 *          원장에게도 맞게 동작했다.)
 *   조교 검사를 먼저 한다. 관우T 기기에 조교 토큰이 남아 있는 상황에서도 원장 메뉴가 새지 않게.
 *
 * ▣ 학생·학부모 페이지에는 싣지 않는다
 *   학생 메뉴 9개(리포트·시험결과·출결·자료·공부시간·복습·숙제·질문·내정보)는
 *   portal.html 이 노출하는 기능 버튼과 이미 1:1로 맞는다. 빠진 게 없어서 건드릴 이유가 없다.
 */
(function () {
  try {
    // ── 1) 원장인지 확인 ──
    var pw = '';
    try { pw = sessionStorage.getItem('kwmath_admin_pw') || localStorage.getItem('kwmath_admin_pw') || ''; } catch (_) {}
    if (/^ast_/.test(pw)) return;                                   // 조교 → 지금 9개 그대로
    var admToken = '';
    try { admToken = localStorage.getItem('kwmath_admin_token') || ''; } catch (_) {}
    if (!admToken) return;                                          // 로그인 전 → 아무것도 안 한다

    var pop = document.getElementById('kwnavPop');
    if (!pop) return;                                               // 이 페이지엔 ☰ 메뉴가 없다

    // ── 2) 이미 목록에 있는 주소는 건너뛴다 (두 번 실려도 항목이 겹치지 않게) ──
    var have = {};
    var cur = pop.querySelectorAll('a[data-p]');
    for (var i = 0; i < cur.length; i++) have[cur[i].getAttribute('data-p')] = 1;
    if (have['/admin-inquiries']) return;                            // 이미 넣었다 → 재실행 무해

    // ── 3) 원장 전용 화면 — 문구는 admin.html 카드와 같게 맞춘다(같은 걸 두 이름으로 부르지 않기) ──
    var ITEMS = [
      ['/admin-inquiries', '📩 상담 문의함'],
      ['/admin-notify',    '🔔 알림 보내기'],
      ['/admin-homework',  '📸 과제 제출함'],
      ['/admin-makeup',    '🔓 인강 신청·해제'],
      ['/admin-study',     '🏆 공부 랭킹'],
      ['/admin-stats',     '📊 방문 통계'],
      ['/admin-staff',     '🧑‍🏫 운영진 관리'],
      // ✅ 2026-08-03 정정 — 예전 주석은 "홈에 카드가 없어 이 줄이 유일한 입구"였는데, 그 말이
      //    「입구가 하나뿐이라 좋다」로 읽혀 홈 카드 신설이 계속 미뤄졌다. 실제로는 홈에서 출발하면
      //    존재를 알 수 없어 관우T가 주소를 직접 쳐야 했다 → admin.html ② 구획에 카드를 만들었다.
      //    이 줄은 「다른 관리자 페이지에서 곧장 건너가는」 입구로 그대로 둔다(성격이 다르다).
      //    문구는 홈 카드·페이지 제목(admin-report.html:6)과 셋 다 같게 맞춘다.
      // ❌ 2026-08-04 넣었다가 같은 날 되돌림 — ['/admin-surveys','📝 테스트·설문']
      //    "테스트를 수업에서 자주 쓰니 메뉴에도 줄을 넣자"고 추가했는데, 어느 페이지에서도 안 그려지는
      //    죽은 줄이었다. 근거 둘: (1) ☰ 메뉴(#kwnavPop)를 가진 16장은 인라인 9개 목록에 이미
      //    /admin-surveys(「📝 테스트」)가 있어 48~51행 중복검사에 걸러진다. (2) 인라인에 그 줄이 없는
      //    유일한 페이지 admin.html 은 애초에 #kwnavPop 이 없다(홈은 카드로 간다) → 46행에서 return.
      //    → 다시 넣지 말 것. 메뉴에 보이는 이름은 인라인의 「📝 테스트」이고, 그건 admin-surveys.html 의
      //      isStaff 분기(조교에게는 '테스트')와 이미 일치한다. 원장이 다른 관리 화면에서 건너갈 길도
      //      그 인라인 줄로 이미 있다.
      ['/admin-report',    '📄 진단평가 보고서'],
      // 2026-07-31 추가 — 변경이력(감사로그). 조교가 무엇을 만졌는지, 삭제된 데이터의 원본값까지 들어 있어
      // 원장만 볼 수 있다(_middleware.js 의 STAFF_GET_BLOCK + audit-log.js 이중 잠금).
      // 홈에도 카드가 없으므로 이 메뉴 줄이 유일한 입구다.
      ['/admin-log',       '🧾 변경이력']
    ];

    // 현재 페이지 판정 — 각 페이지 인라인 스크립트와 같은 규칙(.html 제거 · 끝 슬래시 제거).
    // 인라인 스크립트는 이 파일보다 먼저 돌아 이미 끝났으므로, 넣는 항목의 'cur' 표시는 여기서 직접 한다.
    var path = (location.pathname || '').replace(/\.html$/, '');
    if (path.length > 1) path = path.replace(/\/+$/, '');

    var frag = document.createDocumentFragment();

    // 구분 라벨 — 조교용 9개와 섞이면 어디까지가 뭔지 몰라서 한 줄 넣는다.
    // 페이지마다 CSS 변수 이름이 달라(--muted / --text-light / --border / --hairline …) 인라인으로 고정색을 쓴다.
    var lb = document.createElement('div');
    lb.textContent = '원장 전용';
    lb.setAttribute('aria-hidden', 'true');
    lb.style.cssText = 'font-size:0.68rem;font-weight:800;color:#9C9086;padding:9px 12px 5px;margin-top:4px;border-top:1px solid #EDE0E1;letter-spacing:.02em;';
    frag.appendChild(lb);

    for (var k = 0; k < ITEMS.length; k++) {
      var p = ITEMS[k][0];
      if (have[p]) continue;
      var a = document.createElement('a');
      a.setAttribute('role', 'menuitem');
      a.setAttribute('data-p', p);
      a.textContent = ITEMS[k][1];
      if (p === path) { a.className = 'cur'; }                       // 보고 있는 화면 — 링크를 안 건다
      else { a.setAttribute('href', p); }
      frag.appendChild(a);
    }

    // ── 4) 로그아웃은 항상 맨 아래로 ──
    var lo = pop.querySelector('.kwnav-logout');
    if (lo) pop.insertBefore(frag, lo);
    else pop.appendChild(frag);

    // ── 5) 9개 + 라벨 + 9개 = 19줄. 폰에서 화면 밖으로 넘칠 수 있어 스크롤을 허용한다.
    //       (CSS 파일을 16벌 고치지 않으려고 여기서 인라인으로 준다.)
    pop.style.maxHeight = 'min(68vh, 430px)';
    pop.style.overflowY = 'auto';
    pop.style.overscrollBehavior = 'contain';
    pop.style.webkitOverflowScrolling = 'touch';
  } catch (_) { /* 메뉴 보강 실패는 페이지 기능과 무관 — 기존 9개는 그대로 살아 있다 */ }
})();
