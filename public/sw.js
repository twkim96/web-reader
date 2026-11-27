importScripts('/sw-policy.js', '/sw-build.js');

const CACHE_PREFIX = 'pc-reader-';
const CACHE_NAME = `${CACHE_PREFIX}v1.8.37-${self.PC_READER_BUILD_ID}`;
const readerRevision = CACHE_NAME.slice(CACHE_PREFIX.length + 1);
const REQUIRED_PRECACHE_URLS = ['/manifest.json', ...[
  `view.js?v=${readerRevision}`,
  `paginator.js?v=${readerRevision}`,
  'epub.js',
  'epubcfi.js',
  'fixed-layout.js',
  'latest-task.js',
  'overlayer.js',
  'progress.js',
  'publication-sanitizer.js',
  'sandbox-policy.js',
  'text-walker.js',
  'vendor/zip.js',
  'view-policy.js',
].map(path => `/foliate-js/${path}`)];
const OPTIONAL_PRECACHE_URLS = [
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png',
  '/logo.png',
  '/fonts/PretendardVariable.woff2',
  '/fonts/RIDIBatang.woff2',
  '/fonts/Chosunilbo_myungjo.woff',
  '/fonts/ChosunGu.woff',
  '/fonts/GowunBatang-Regular.woff',
  '/fonts/GowunDodum-Regular.woff',
];
const OBSOLETE_PRECACHE_URLS = ['/fonts/SUIT-Variable.woff2'];
const policy = self.PCReaderSWPolicy;

const matchInCache = (request) => caches
  .match(request, { cacheName: CACHE_NAME })
  .catch(() => undefined);

const cacheFirst = (event, reload = false) => {
  const cached = reload ? Promise.resolve(undefined) : matchInCache(event.request);
  const network = cached.then(response => response ? undefined : fetch(event.request));
  event.waitUntil(network.then(async (response) => {
    if (!policy.isCacheableResponse(response)) return;
    const copy = response.clone();
    const cache = await caches.open(CACHE_NAME);
    await cache.put(event.request, copy);
  }).catch(() => undefined));
  return cached.then(response => response ?? network);
};

const navigationShellFirst = async (event) => {
  // Keep HTML and unversioned runtime modules on one approved deployment.
  // Registration.update() detects the next build independently of navigation.
  if (new URL(event.request.url).pathname === '/') {
    const installedShell = await matchInCache('/');
    if (installedShell) return installedShell;
  }
  try {
    return await fetch(event.request);
  } catch {
    return (await matchInCache('/')) ?? Response.error();
  }
};

const fetchOfflineAssets = async () => {
  if (!self.PC_READER_HAS_OFFLINE_ASSETS) return [];
  const response = await fetch(`/_next/static/${self.PC_READER_BUILD_ID}/offline-assets.json`);
  if (!response.ok) throw new Error('Offline asset list download failed');
  const assets = await response.json();
  if (!Array.isArray(assets) || !assets.length || assets.some(path => (
    typeof path !== 'string' || !/^\/_next\/static\/chunks\/[\w.-]+\.(?:js|css)$/.test(path)
  ))) throw new Error('Invalid offline asset list');
  return assets;
};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Publish the offline HTML only after all of its initial Next assets are ready.
    // Keep that shell fixed for this build; a later online response may belong to
    // a deployment whose worker the user has not yet approved.
    const [shell, offlineAssets] = await Promise.all([
      fetch('/', { cache: 'reload' }),
      fetchOfflineAssets(),
    ]);
    if (!shell.ok) throw new Error('Offline shell download failed');
    const html = await shell.clone().text();
    const assets = [...new Set(html.match(/\/_next\/static\/[^\s"'<>\\]+/g) ?? [])]
      .map((url) => url.replaceAll('&amp;', '&'));
    await cache.addAll([...new Set([...assets, ...offlineAssets, ...REQUIRED_PRECACHE_URLS])]);
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
    const refreshDiscovery = url.pathname === '/catalog/discovery.v1.json' && event.request.cache === 'reload';
    event.respondWith(cacheFirst(event, refreshDiscovery));
  }
});
