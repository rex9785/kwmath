/**
 * kwmath PWA Service Worker
 * 캐시 전략: app-shell은 stale-while-revalidate, API는 network-first
 * 푸시: 2단계에서 활성화 (현재는 빈 핸들러)
 */

const VERSION = 'kwmath-v1';
const APP_SHELL = [
  '/app',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
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

  // API 호출은 network-first (캐시 안전성 위해)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  // 그 외 정적 자원은 stale-while-revalidate
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

// 푸시 알림 수신 - 2단계에서 본격 사용
self.addEventListener('push', (event) => {
  let data = { title: '이관우 수학연구소', body: '새 소식이 있습니다', url: '/app' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/favicon-32.png',
      tag: data.tag || 'kwmath',
      data: { url: data.url || '/app' },
      requireInteraction: false
    })
  );
});

// 알림 클릭 - 해당 페이지로 이동
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes('/app') && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
