'use client';

import { useMemo, useRef, useState } from 'react';
import type { DiscoveryBook } from '../lib/bookDiscovery';
import type { MyPageSavedBook } from '../lib/myPageSocial';
import { myPageRequest, MyPageRequestError } from '../lib/myPageSocialClient';
import { ownerRuntime } from '../lib/ownerRuntime';
import { useMyPageWishlistList } from './useMyPageList';
import { isGuestOwner, type OwnerKey } from '../lib/ownerIdentity';
import { useWishlist } from './useWishlist';

export function useAccountWishlist(ownerKey: OwnerKey, enabled: boolean) {
  const guest = isGuestOwner(ownerKey);
  const local = useWishlist(ownerKey, guest && enabled);
  const { data, error, refresh, writeVersion } = useMyPageWishlistList(ownerKey, !guest && enabled);
  const entries = data?.entries;
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const session = ownerRuntime.capture();
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
    if (pending.current || writeVersion % 2 !== 0 || !entries || session?.ownerKey !== ownerKey || !ownerRuntime.isCurrent(session)) return;
    pending.current = true;
    setSaving(true);
    setSaveError('');
    const entry = index.get(book.id);
    let conflict = false;
    try {
      await myPageRequest<MyPageSavedBook>({ action: 'wishlist' }, {
        owner: ownerKey,
        body: {
          workId: entry?.item.workId ?? book.id, saved, revision: entry?.item.revision ?? null,
          siblingRevisions: entry ? entry.siblingRevisions : [],
        },
      });
    } catch (error) {
      if (ownerRuntime.isCurrent(session)) {
        conflict = error instanceof MyPageRequestError && error.status === 409;
        setSaveError((error as Error).message);
      }
    } finally {
      pending.current = false;
      if (ownerRuntime.isCurrent(session)) {
        setSaving(false);
        if (conflict) void refresh();
      }
    }
  };
  const reload = () => {
    setSaveError('');
    if (enabled && !guest) return refresh();
  };
  return !guest ? {
    entries: savedEntries,
    savedIds, setSaved: change, error: enabled ? error || saveError : '', loading: !entries, saving: saving || writeVersion % 2 !== 0, refresh: reload,
  } : { ...local, error: enabled ? local.error : null, saving: false, refresh: reload };
}
