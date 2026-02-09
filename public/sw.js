// public/sw.js

const CACHE_NAME = 'pc-reader-v1';
const PRE_CACHE_URLS = [
  '/',
  '/manifest.json',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png',
  '/logo.png',
];

// 1. 설치(Install): 핵심 정적 파일들을 미리 캐싱
self.addEventListener('install', (event) => {
  console.log('Service Worker installing.');
  
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Caching app shell');
      return cache.addAll(PRE_CACHE_URLS);
    })
  );
  
  self.skipWaiting();
});

// 2. 활성화(Activate): 이전 버전의 캐시 정리
self.addEventListener('activate', (event) => {
  console.log('Service Worker activating.');
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  
  return self.clients.claim();
});

// 3. 요청(Fetch): 네트워크 우선, 실패 시 캐시 사용 (Network First, then Cache)
self.addEventListener('fetch', (event) => {
  // POST 등의 요청이나 chrome-extension 같은 스키마는 캐싱하지 않음
  if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // 유효한 응답이 아니면 그냥 반환
        if (!response || response.status !== 200) {
          return response;
        }

        // 응답을 복제하여 캐시에 저장 (다음 오프라인 접속을 대비)
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return response;
      })
      .catch(() => {
        // 네트워크 요청 실패 시(오프라인), 캐시에서 찾아서 반환
        return caches.match(event.request)
          .then((cachedResponse) => {
            if (cachedResponse) {
              return cachedResponse;
            }
            // 캐시에도 없다면 오프라인 페이지를 보여줄 수도 있음(현재는 생략)
            console.log('No cache found for:', event.request.url);
          });
      })
  );
});