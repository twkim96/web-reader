// public/sw.js
self.addEventListener('install', (event) => {
  console.log('Service Worker installing.');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('Service Worker activating.');
});

// 설치 버튼 활성화를 위해 필수적으로 fetch 이벤트가 필요합니다.
self.addEventListener('fetch', (event) => {
  // 현재는 단순히 요청을 통과시키지만, 나중에 오프라인 캐싱 기능을 추가할 수 있습니다.
  event.respondWith(fetch(event.request));
});