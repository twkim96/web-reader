'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { fullReviewListCache, previewReviewListCache, wishlistListCache, type MyPageListSnapshot } from '../lib/myPageListCache';
import { finishMyPageTiming, startDiscoveryTiming } from '../lib/myPagePerformance';
import { myPageRequest } from '../lib/myPageSocialClient';
import type { MyPageOwnReviews, MyPageSavedBook } from '../lib/myPageSocial';
import type { OwnerKey } from '../lib/ownerIdentity';

type ListCache<T> = {
  subscribe: (listener: () => void) => () => void;
  empty: () => MyPageListSnapshot<T>;
  read: (owner: OwnerKey) => MyPageListSnapshot<T>;
  refresh: (owner: OwnerKey, load: (signal: AbortSignal) => Promise<T>, force?: boolean) => Promise<void> | undefined;
};

function useMyPageList<T>(
  cache: ListCache<T>, params: Record<string, string>, owner: OwnerKey, enabled: boolean,
  phase: 'wishlist-ready' | 'reviews-ready' | 'review-preview-ready',
) {
  const snapshot = useSyncExternalStore(cache.subscribe, () => enabled ? cache.read(owner) : cache.empty(), cache.empty);
  const load = useCallback((force = false) => (
    cache.refresh(owner, (signal) => myPageRequest<T>(params, { owner, signal }), force)
  ), [cache, owner, params]);
  const refresh = useCallback(() => load(true), [load]);
  const ready = snapshot.data !== undefined && snapshot.writeVersion % 2 === 0;
  const timing = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    timing.current = enabled ? startDiscoveryTiming() : undefined;
  }, [enabled, owner, phase]);
  useLayoutEffect(() => {
    if (ready && timing.current !== undefined) {
      finishMyPageTiming(phase, timing.current);
      timing.current = undefined;
    }
  }, [enabled, owner, phase, ready]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const resume = () => {
      if (document.visibilityState !== 'hidden') void load();
    };
    const reconnect = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', reconnect);
    return () => {
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', reconnect);
    };
  }, [enabled, load, refresh, snapshot.writeVersion]);

  return { ...snapshot, refresh };
}

const wishlistParams = { view: 'wishlist' };
const fullReviewParams = { view: 'reviews' };
const previewReviewParams = { view: 'reviews', preview: '1' };

export const useMyPageWishlistList = (owner: OwnerKey, enabled: boolean) => (
  useMyPageList<{ entries: MyPageSavedBook[] }>(wishlistListCache, wishlistParams, owner, enabled, 'wishlist-ready')
);

export const useMyPageReviewList = (owner: OwnerKey, enabled: boolean, preview = false) => (
  useMyPageList<MyPageOwnReviews>(
    preview ? previewReviewListCache : fullReviewListCache, preview ? previewReviewParams : fullReviewParams, owner, enabled,
    preview ? 'review-preview-ready' : 'reviews-ready',
  )
);
