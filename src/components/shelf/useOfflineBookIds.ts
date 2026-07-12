import { useCallback, useEffect, useState } from 'react';
import { Book } from '../../types';
import { getOfflineBookIdsV5 } from '../../lib/localDBV5';
import { ownerRuntime } from '../../lib/ownerRuntime';

export const useOfflineBookIds = (books: Book[]) => {
  const [offlineIds, setOfflineIds] = useState<Set<string>>(new Set());

  const refreshOfflineBookIds = useCallback(async () => {
    const owner = ownerRuntime.require();
    const ids = await getOfflineBookIdsV5(owner.ownerKey);
    if (!ownerRuntime.isCurrent(owner)) return;
    setOfflineIds(ids);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const owner = ownerRuntime.capture();
    if (!owner) return;
    getOfflineBookIdsV5(owner.ownerKey).then(ids => {
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
