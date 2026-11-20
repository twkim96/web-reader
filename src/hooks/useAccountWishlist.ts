'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiscoveryBook } from '../lib/bookDiscovery';
import type { MyPageSavedBook } from '../lib/myPageSocial';
import { myPageRequest } from '../lib/myPageSocialClient';
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
    try {
      const result = await myPageRequest<{ entries: MyPageSavedBook[] }>({ view: 'wishlist' }, { owner: ownerKey });
      if (generation === request.current) { setEntries(result.entries); setError(null); }
    } catch (error) {
      if (generation === request.current) {
        setEntries((current) => current ?? []);
        setError((error as Error).message);
      }
    }
  }, [ownerKey]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const onFocus = () => { if (!pending.current) void refresh(); };
    const requests = request;
    window.addEventListener('focus', onFocus);
    return () => { requests.current++; window.removeEventListener('focus', onFocus); };
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
    try {
      const result = await myPageRequest<MyPageSavedBook>({ action: 'wishlist' }, {
        owner: ownerKey,
        body: { workId: index.get(book.id)?.item.workId ?? book.id, saved, revision: index.get(book.id)?.item.revision ?? null },
      });
      if (generation !== request.current) return;
      setEntries((current) => {
        const others = (current ?? []).filter((entry) => entry.item.workId !== result.item.workId);
        return [result, ...others];
      });
      setError(null);
    } catch (error) {
      if (generation === request.current) setError((error as Error).message);
    } finally {
      pending.current = false;
      if (generation === request.current) setSaving(false);
    }
  };
  return enabled ? {
    entries: savedEntries,
    savedIds, setSaved: change, error, loading: entries === null, saving, refresh,
  } : { ...local, saving: false, refresh };
}
