'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createListCache, fullReviewListCache, previewReviewListCache, wishlistListCache, type MyPageListSnapshot } from '../lib/myPageListCache';
import { finishMyPageTiming, startDiscoveryTiming } from '../lib/myPagePerformance';
import { MyPageRequestError, myPageRequest } from '../lib/myPageSocialClient';
import type { MyPageOwnReviews, MyPageSavedBook } from '../lib/myPageSocial';
import { isGuestOwner, type OwnerKey } from '../lib/ownerIdentity';
import { ownerRuntime } from '../lib/ownerRuntime';
import type { PublishedReadingCalendar, PublishedReadingWeek } from '../lib/readingRollupCalendar';
import type { PublishedReadingFiles } from '../lib/readingStatisticsRollup';

type ListCache<T> = {
  subscribe: (listener: () => void) => () => void;
  empty: () => MyPageListSnapshot<T>;
  read: (owner: OwnerKey) => MyPageListSnapshot<T>;
  refresh: (owner: OwnerKey, load: (signal: AbortSignal) => Promise<T>, force?: boolean) => Promise<void> | undefined;
};

function useMyPageList<T>(
  cache: ListCache<T>, params: Record<string, string>, owner: OwnerKey, enabled: boolean,
  phase: 'wishlist-ready' | 'reviews-ready' | 'review-preview-ready' | 'reading-calendar-ready' | 'reading-week-ready' | 'reading-files-ready',
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
const readingCalendarParams = { view: 'rollup-calendar' };
const readingCalendarCache = createListCache<{ calendar: PublishedReadingCalendar | null }>();
const readingFilesParams = { view: 'rollup-files' };
const readingFilesCache = createListCache<{ history: PublishedReadingFiles | null }>(15 * 60_000);

export const useMyPageWishlistList = (owner: OwnerKey, enabled: boolean) => (
  useMyPageList<{ entries: MyPageSavedBook[] }>(wishlistListCache, wishlistParams, owner, enabled, 'wishlist-ready')
);

export const useMyPageReviewList = (owner: OwnerKey, enabled: boolean, preview = false) => (
  useMyPageList<MyPageOwnReviews>(
    preview ? previewReviewListCache : fullReviewListCache, preview ? previewReviewParams : fullReviewParams, owner, enabled,
    preview ? 'review-preview-ready' : 'reviews-ready',
  )
);

export const useMyPageReadingCalendar = (owner: OwnerKey, enabled: boolean) => (
  useMyPageList(readingCalendarCache, readingCalendarParams, owner, enabled, 'reading-calendar-ready')
);

export const useMyPageReadingFiles = (owner: OwnerKey, enabled: boolean) => (
  useMyPageList(readingFilesCache, readingFilesParams, owner, enabled && !isGuestOwner(owner)
    && process.env.NEXT_PUBLIC_ENABLE_READING_STATS_ROLLUP_READS === '1', 'reading-files-ready')
);

export function useMyPageReadingWeek(owner: OwnerKey, week: string | null, enabled: boolean) {
  const { cache, params } = useMemo(() => ({
    cache: createListCache<{ week: PublishedReadingWeek | null }>(),
    params: { view: 'rollup-week', week: week ?? '' },
  }), [week]);
  const session = ownerRuntime.capture();
  useEffect(() => {
    if (session) return () => cache.dispose(session);
  }, [cache, session]);
  return useMyPageList(cache, params, owner, Boolean(week) && enabled, 'reading-week-ready');
}

export function useMyPageWorkReview(owner: OwnerKey, enabled: boolean, workId: string) {
  // Book detail is keyed by account and book. The cache owns just that work.
  const { cache, params } = useMemo(() => ({
    cache: createListCache<MyPageOwnReviews>(),
    params: { view: 'own-review', workId },
  }), [workId]);
  const session = ownerRuntime.capture();
  useEffect(() => {
    if (session) return () => cache.dispose(session);
  }, [cache, session]);
  const scopedCache = useMemo(() => ({
    ...cache,
    refresh(owner: OwnerKey, load: (signal: AbortSignal) => Promise<MyPageOwnReviews>, force?: boolean) {
      const session = ownerRuntime.capture();
      return cache.refresh(owner, async (signal) => {
        try { return await load(signal); }
        catch (error) {
          if (session && !signal.aborted && error instanceof MyPageRequestError && error.status === 401) cache.clear(session, error.message);
          throw error;
        }
      }, force);
    },
  }), [cache]);
  const { data, error, writeVersion, refresh } = useMyPageList(scopedCache, params, owner, enabled, 'reviews-ready');
  return { cache, data, error, ready: data !== undefined && writeVersion % 2 === 0, refresh };
}
