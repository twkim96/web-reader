(function exposeServiceWorkerPolicy(root, factory) {
  const policy = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = policy;
  root.PCReaderSWPolicy = policy;
}(typeof globalThis !== 'undefined' ? globalThis : self, function createPolicy(root) {
  const STATIC_PATHS = new Set([
    '/manifest.json',
    '/favicon.ico',
    '/icon-192.png',
    '/icon-512.png',
    '/logo.png',
  ]);
  const STATIC_PREFIXES = [
    '/_next/static/',
    '/7z/',
    '/foliate-js/',
    '/fonts/',
    '/zip/',
  ];
  const PRIVATE_PREFIXES = ['/__/auth/', '/__/firebase/', '/api/'];

  const getHeader = (headers, name) => headers?.get?.(name) ?? null;
  const isPrivateRequest = (request, url, appOrigin = root.location?.origin ?? url.origin) => (
    request.method !== 'GET'
    || url.origin !== appOrigin
    || Boolean(getHeader(request.headers, 'Authorization'))
    || Boolean(getHeader(request.headers, 'Range'))
    || PRIVATE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
  );
  const isStaticAssetPath = (pathname) => (
    STATIC_PATHS.has(pathname)
    || STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
  const isCacheableResponse = (response) => {
    if (!response || response.status !== 200) return false;
    if (response.type === 'opaque' || response.type === 'opaqueredirect') return false;
    const cacheControl = getHeader(response.headers, 'Cache-Control')?.toLowerCase() ?? '';
    return !cacheControl.includes('no-store') && !cacheControl.includes('private');
  };

  return { isPrivateRequest, isStaticAssetPath, isCacheableResponse };
}));
