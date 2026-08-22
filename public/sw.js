importScripts('/sw-policy.js');

// 1.8.31: extend covered grid titles and anchor TXT/view-count metadata to the cover bottom.
const CACHE_PREFIX = 'pc-reader-';
const CACHE_NAME = `${CACHE_PREFIX}v1.8.31`;
const REQUIRED_PRECACHE_URLS = ['/', '/manifest.json'];
const OPTIONAL_PRECACHE_URLS = [
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png',
  '/logo.png',
  '/fonts/PretendardVariable.woff2',
  '/fonts/RIDIBatang.woff2',
  '/fonts/RIDIBatang.otf',
];
const OBSOLETE_PRECACHE_URLS = ['/fonts/SUIT-Variable.woff2'];
const policy = self.PCReaderSWPolicy;

const putInCache = async (request, response) => {
  if (!policy.isCacheableResponse(response)) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
};

const cacheFirst = (event) => {
  const response = caches.match(event.request).then(async (cached) => {
    if (cached) return cached;
    const networkResponse = await fetch(event.request);
    await putInCache(event.request, networkResponse);
    return networkResponse;
  });
  event.waitUntil(response.then(() => undefined).catch(() => undefined));
  return response;
};

const navigationNetworkFirst = async (event) => {
  try {
    return await fetch(event.request);
  } catch {
    return (await caches.match('/')) ?? Response.error();
  }
};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(REQUIRED_PRECACHE_URLS);
    await Promise.allSettled(OPTIONAL_PRECACHE_URLS.map((url) => cache.add(url)));
    await Promise.all(OBSOLETE_PRECACHE_URLS.map((url) => cache.delete(url)));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((cacheNames) => Promise.all(
    cacheNames
      .filter((cacheName) => cacheName.startsWith(CACHE_PREFIX) && cacheName !== CACHE_NAME)
      .map((cacheName) => caches.delete(cacheName)),
  )));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (policy.isPrivateRequest(event.request, url, self.location.origin)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(navigationNetworkFirst(event));
    return;
  }
  if (policy.isStaticAssetPath(url.pathname)) {
    event.respondWith(cacheFirst(event));
  }
});
