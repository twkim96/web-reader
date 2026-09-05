importScripts('/sw-policy.js', '/sw-build.js');

const CACHE_PREFIX = 'pc-reader-';
const CACHE_NAME = `${CACHE_PREFIX}v1.8.36-${self.PC_READER_BUILD_ID}`;
const REQUIRED_PRECACHE_URLS = ['/manifest.json'];
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
  const response = caches.open(CACHE_NAME).then(async (cache) => {
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const networkResponse = await fetch(event.request);
    await putInCache(event.request, networkResponse);
    return networkResponse;
  });
  event.waitUntil(response.then(() => undefined).catch(() => undefined));
  return response;
};

const navigationShellFirst = async (event) => {
  const cache = await caches.open(CACHE_NAME);
  // Keep HTML and unversioned runtime modules on one approved deployment.
  // Registration.update() detects the next build independently of navigation.
  if (new URL(event.request.url).pathname === '/') {
    const installedShell = await cache.match('/');
    if (installedShell) return installedShell;
  }
  try {
    return await fetch(event.request);
  } catch {
    return (await cache.match('/')) ?? Response.error();
  }
};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Publish the offline HTML only after all of its initial Next assets are ready.
    // Keep that shell fixed for this build; a later online response may belong to
    // a deployment whose worker the user has not yet approved.
    const shell = await fetch('/', { cache: 'reload' });
    if (!shell.ok) throw new Error('Offline shell download failed');
    const html = await shell.clone().text();
    const assets = [...new Set(html.match(/\/_next\/static\/[^\s"'<>\\]+/g) ?? [])]
      .map((url) => url.replaceAll('&amp;', '&'));
    await cache.addAll(assets);
    await cache.addAll(REQUIRED_PRECACHE_URLS);
    await cache.put('/', shell);
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
    event.respondWith(navigationShellFirst(event));
    return;
  }
  if (policy.isStaticAssetPath(url.pathname)) {
    event.respondWith(cacheFirst(event));
  }
});
