import { useCallback, useEffect, useState } from 'react';
import { Book } from '../../types';
import { getOfflineBookIdsV5 } from '../../lib/localDBV5';
import { ownerRuntime } from '../../lib/ownerRuntime';

export const useOfflineBookIds = (books: Book[]) => {
  const [offlineIds, setOfflineIds] = useState<Set<string>>(new Set());

  const refreshOfflineBookIds = useCallback(async () => {
    const owner = ownerRuntime.require();
    const ids = owner.storageMode === 'legacy-readonly'
      ? await import('../../lib/localDB').then(({ getOfflineBookIds }) => getOfflineBookIds())
      : await getOfflineBookIdsV5(owner.ownerKey);
    if (!ownerRuntime.isCurrent(owner)) return;
    setOfflineIds(ids);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const owner = ownerRuntime.capture();
    if (!owner) return;
    const getIds = owner.storageMode === 'legacy-readonly'
      ? import('../../lib/localDB').then(({ getOfflineBookIds }) => getOfflineBookIds())
      : getOfflineBookIdsV5(owner.ownerKey);
    getIds.then(ids => {
      if (!cancelled && ownerRuntime.isCurrent(owner)) setOfflineIds(ids);
    });

    return () => {
      cancelled = true;
    };
  }, [books]);

  return {
    offlineIds,
    refreshOfflineBookIds,
  };
};
