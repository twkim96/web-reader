'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiscoveryBook } from '../lib/bookDiscovery';
import { readWishlist, setWishlistSaved, wishlistPrefix, type WishlistEntry } from '../lib/localWishlist';
import type { OwnerKey } from '../lib/ownerIdentity';

type State = { owner: OwnerKey; entries: WishlistEntry[]; loading: boolean; error: string | null };
const message = (error: unknown) => error instanceof Error ? error.message : '위시리스트 저장소를 사용할 수 없습니다.';
export const useWishlist = (ownerKey: OwnerKey, enabled = true) => {
  const ownerRef = useRef(ownerKey);
  ownerRef.current = ownerKey;
  const [state, setState] = useState<State>({ owner: ownerKey, entries: [], loading: true, error: null });
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      try { setState({ owner: ownerKey, entries: readWishlist(ownerKey, window.localStorage), loading: false, error: null }); }
      catch (error) { setState({ owner: ownerKey, entries: [], loading: false, error: message(error) }); }
    };
    refresh();
    const onStorage = (event: StorageEvent) => {
      try {
        if (event.storageArea === window.localStorage && (event.key === null || event.key.startsWith(wishlistPrefix(ownerKey)))) refresh();
      } catch (error) { setState({ owner: ownerKey, entries: [], loading: false, error: message(error) }); }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [enabled, ownerKey]);
  const setSaved = useCallback((book: DiscoveryBook, saved: boolean) => {
    if (ownerRef.current !== ownerKey) return;
    try {
      setWishlistSaved(ownerKey, book, saved, window.localStorage);
      setState({ owner: ownerKey, entries: readWishlist(ownerKey, window.localStorage), loading: false, error: null });
      window.dispatchEvent(new CustomEvent('reader-wishlist-change', { detail: ownerKey }));
    } catch (error) { setState((current) => current.owner === ownerKey ? { ...current, loading: false, error: message(error) } : current); }
  }, [ownerKey]);
  useEffect(() => {
    if (!enabled) return;
    const update = (event: Event) => {
      if ((event as CustomEvent).detail !== ownerKey) return;
      try { setState({ owner: ownerKey, entries: readWishlist(ownerKey, window.localStorage), loading: false, error: null }); }
      catch (error) { setState({ owner: ownerKey, entries: [], loading: false, error: message(error) }); }
    };
    window.addEventListener('reader-wishlist-change', update);
    return () => window.removeEventListener('reader-wishlist-change', update);
  }, [enabled, ownerKey]);
  const current = state.owner === ownerKey ? state : { owner: ownerKey, entries: [], loading: true, error: null };
  const savedIds = useMemo(() => new Set(current.entries.map((entry) => entry.book.id)), [current.entries]);
  return { entries: current.entries, loading: current.loading, error: current.error, setSaved, savedIds };
};
