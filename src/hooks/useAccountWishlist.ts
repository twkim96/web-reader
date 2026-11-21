'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiscoveryBook } from '../lib/bookDiscovery';
import { MY_PAGE_DASHBOARD_BOOK_LIMIT, type MyPageSavedBook } from '../lib/myPageSocial';
import { myPageRequest, MyPageRequestError } from '../lib/myPageSocialClient';
import { dashboardWishlistCache } from '../lib/myPageDashboardCache';
import type { OwnerKey } from '../lib/ownerIdentity';
import { useWishlist } from './useWishlist';

export function useAccountWishlist(ownerKey: OwnerKey, enabled: boolean) {
  const local = useWishlist(ownerKey, !enabled);
  const [entries, setEntries] = useState<MyPageSavedBook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    const generation = ++request.current;
    const cache = dashboardWishlistCache.beginRead(ownerKey);
    try {
      const result = await myPageRequest<{ entries: MyPageSavedBook[] }>({ view: 'wishlist' }, { owner: ownerKey });
      if (generation === request.current) {
        cache?.(result.entries.filter(({ item }) => item.saved).slice(0, MY_PAGE_DASHBOARD_BOOK_LIMIT).map(({ book }) => book));
        setEntries(result.entries);
        setError(null);
      }
    } catch (error) {
      if (generation === request.current) {
        if (error instanceof MyPageRequestError && error.status === 401) {
          cache?.(undefined);
          setEntries(null);
        }
        setError((error as Error).message);
      }
    }
  }, [ownerKey]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    let active = true;
    let queued = false;
    const resume = () => {
      if (document.visibilityState === 'hidden' || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (active) void refresh();
      });
    };
    const requests = request;
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      active = false;
      requests.current++;
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [enabled, refresh]);
  const index = useMemo(() => {
    const byAlias = new Map<string, MyPageSavedBook>();
    for (const entry of entries ?? []) for (const id of [entry.item.workId, entry.book.id, ...entry.aliases]) byAlias.set(id, entry);
    return byAlias;
  }, [entries]);
  const savedIds = useMemo(() => new Set([...index].flatMap(([id, entry]) => entry.item.saved ? [id] : [])), [index]);
  const savedEntries = useMemo(() => (entries ?? []).flatMap(({ book, item }) => (
    item.saved ? [{ book, addedAt: item.addedAt }] : []
  )), [entries]);
  const change = async (book: DiscoveryBook, saved: boolean) => {
    if (pending.current || entries === null) return;
    pending.current = true;
    setSaving(true);
    const generation = ++request.current;
    const entry = index.get(book.id);
    let conflict = false;
    try {
      const result = await myPageRequest<MyPageSavedBook>({ action: 'wishlist' }, {
        owner: ownerKey,
        body: {
          workId: entry?.item.workId ?? book.id, saved, revision: entry?.item.revision ?? null,
          siblingRevisions: entry ? entry.siblingRevisions : [],
        },
      });
      if (generation !== request.current) return;
      setEntries((current) => {
        const others = (current ?? []).filter((entry) => entry.item.workId !== result.item.workId);
        return [result, ...others];
      });
      setError(null);
    } catch (error) {
      if (generation === request.current) {
        conflict = error instanceof MyPageRequestError && error.status === 409;
        setError((error as Error).message);
      }
    } finally {
      pending.current = false;
      if (generation === request.current) {
        setSaving(false);
        if (conflict) void refresh();
      }
    }
  };
  return enabled ? {
    entries: savedEntries,
    savedIds, setSaved: change, error, loading: entries === null, saving, refresh,
  } : { ...local, saving: false, refresh };
}
