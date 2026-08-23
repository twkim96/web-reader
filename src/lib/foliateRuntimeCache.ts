export const FOLIATE_RUNTIME_VERSION = '1.8.33';
export const FOLIATE_RUNTIME_REVISION = '1.8.33';
export const FOLIATE_RUNTIME_CACHE_NAME = `pc-reader-v${FOLIATE_RUNTIME_VERSION}`;
export const FOLIATE_ENTRY_URL = `/foliate-js/view.js?v=${FOLIATE_RUNTIME_REVISION}`;

const CACHE_PREFIX = 'pc-reader-';
const FOLIATE_PATH_PREFIX = '/foliate-js/';

export const createRetryablePreparation = (prepare: () => Promise<void>) => {
  let preparation: Promise<void> | null = null;
  return () => {
    if (!preparation) {
      preparation = Promise.resolve()
        .then(prepare)
        .catch((error) => {
          preparation = null;
          throw error;
        });
    }
    return preparation;
  };
};

export const clearStaleFoliateRuntimeEntries = async (
  cacheStorage: Pick<CacheStorage, 'keys' | 'open'>,
  appOrigin: string,
) => {
  let deleted = 0;
  const cacheNames = await cacheStorage.keys();
  await Promise.all(cacheNames
    .filter((cacheName) => (
      cacheName.startsWith(CACHE_PREFIX)
      && cacheName !== FOLIATE_RUNTIME_CACHE_NAME
    ))
    .map(async (cacheName) => {
      const cache = await cacheStorage.open(cacheName);
      const requests = await cache.keys();
      await Promise.all(requests.map(async (request) => {
        const url = new URL(request.url, appOrigin);
        if (url.origin !== appOrigin || !url.pathname.startsWith(FOLIATE_PATH_PREFIX)) return;
        if (await cache.delete(request)) deleted += 1;
      }));
    }));
  return deleted;
};
