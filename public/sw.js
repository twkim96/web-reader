const CACHE_PREFIX = 'pc-reader-';
const CACHE_NAME = `${CACHE_PREFIX}v1.6.0`;
const PRE_CACHE_URLS = [
  '/',
  '/manifest.json',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png',
  '/logo.png',
  '/fonts/RIDIBatang.woff2',
  '/fonts/RIDIBatang.otf',
];

const RUNTIME_ASSET_PREFIXES = [
  '/_next/static/',
  '/7z/',
  '/foliate-js/',
  '/fonts/',
  '/zip/',
];

const isCacheableResponse = (response) =>
  response?.ok && response.type !== 'opaque' && response.type !== 'opaqueredirect';

const putInCache = async (request, response) => {
  if (!isCacheableResponse(response)) return;
  const responseToCache = response.clone();
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, responseToCache);
};

const cacheFirst = (event) => {
  const cachedResponse = caches.match(event.request);
  const networkResponse = cachedResponse.then((cached) =>
    cached ? null : fetch(event.request));

  event.waitUntil(
    networkResponse
      .then((response) => response && putInCache(event.request, response))
      .catch(() => undefined)
  );

  return cachedResponse.then(async (cached) => {
    if (cached) return cached;
    const response = await networkResponse;
    if (!response) throw new Error('Static asset is unavailable');
    return response;
  });
};

const networkFirst = (event, fallbackUrl) => {
  const networkResponse = fetch(event.request);

  event.waitUntil(
    networkResponse
      .then((response) => putInCache(event.request, response))
      .catch(() => undefined)
  );

  return networkResponse.catch(async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    return Response.error();
  });
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRE_CACHE_URLS))
  );

  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => Promise.all(
      cacheNames
        .filter((cacheName) =>
          cacheName.startsWith(CACHE_PREFIX) && cacheName !== CACHE_NAME)
        .map((cacheName) => caches.delete(cacheName))
    ))
  );

  return self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event, '/'));
    return;
  }

  if (RUNTIME_ASSET_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    event.respondWith(cacheFirst(event));
    return;
  }

  event.respondWith(networkFirst(event));
});
