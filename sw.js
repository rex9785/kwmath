/**
 * kwmath PWA Service Worker — portal 전용
 * 캐시 전략: app-shell stale-while-revalidate, API network-first
 * 푸쉬: Web Push 활성화 (data 페이로드 받으면 알림 표시 + 클릭 시 해당 url 이동)
 *
 * 버전 올릴 때: VERSION 문자열 숫자 +1 → 옛 캐시 자동 정리
 */

const VERSION = 'kwmath-v6';
const APP_SHELL = [
  '/portal',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/가로로고.jpg',
  '/세로로고.jpg'
];

// 설치 - 앱 셸 프리캐시
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(APP_SHELL).catch(() => null))
  );
  self.skipWaiting();
});

// 활성화 - 옛 캐시 정리
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 페치 핸들러
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // portal 페이지와 그 직접 리소스(API/manifest/icons/sw)만 sw가 개입
  // 그 외(메인 index, report, video, materials 등)는 sw 미개입 → 항상 서버 직접
  const swManaged =
       url.pathname === '/portal'
    || url.pathname.startsWith('/portal/')
    || url.pathname === '/portal.html'
    || url.pathname.startsWith('/api/')
    || url.pathname === '/manifest.json'
    || url.pathname === '/sw.js'
    || url.pathname.startsWith('/icons/');
  if (!swManaged) return; // 기본 브라우저 동작 (캐시 안 함)

  // API 호출은 network-first
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  // HTML 페이지(portal, report, video 등)도 network-first — 항상 최신 코드 보장
  //   같은 도메인의 navigate 요청 또는 .html 확장자, 또는 portal/report/video/materials 경로
  const isHtmlPage = request.mode === 'navigate'
    || url.pathname.endsWith('.html')
    || ['/portal','/report','/video','/materials','/register','/admin','/'].includes(url.pathname);
  if (isHtmlPage) {
    event.respondWith(
      fetch(request).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(VERSION).then((cache) => cache.put(request, clone));
        }
        return res;
      }).catch(() => caches.match(request))
    );
    return;
  }

  // 그 외 정적 자원(이미지·아이콘·manifest 등)은 stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const fresh = fetch(request)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(VERSION).then((cache) => cache.put(request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});

// 푸쉬 수신
// 서버에서 보내는 페이로드 예시: { title, body, url, tag, image }
self.addEventListener('push', (event) => {
  let data = { title: '이관우 수학연구소', body: '새 소식이 있습니다', url: '/portal' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/favicon-32.png',
      tag: data.tag || 'kwmath',
      data: { url: data.url || '/portal' },
      requireInteraction: false,
      vibrate: [120, 60, 120]
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/portal';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes('/portal') && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
