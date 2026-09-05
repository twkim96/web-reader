export const FOLIATE_RUNTIME_VERSION = '1.8.36';
const BUILD_ID = process.env.NEXT_PUBLIC_APP_BUILD_ID ?? 'development';
export const FOLIATE_RUNTIME_REVISION = `${FOLIATE_RUNTIME_VERSION}-${BUILD_ID}`;
export const FOLIATE_RUNTIME_CACHE_NAME = `pc-reader-v${FOLIATE_RUNTIME_REVISION}`;
export const FOLIATE_ENTRY_URL = `/foliate-js/view.js?v=${FOLIATE_RUNTIME_REVISION}`;

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
