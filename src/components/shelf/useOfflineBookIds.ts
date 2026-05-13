import { useCallback, useEffect, useState } from 'react';
import { Book } from '../../types';
import { getOfflineBookIds } from '../../lib/localDB';

export const useOfflineBookIds = (books: Book[]) => {
  const [offlineIds, setOfflineIds] = useState<Set<string>>(new Set());

  const refreshOfflineBookIds = useCallback(async () => {
    const ids = await getOfflineBookIds();
    setOfflineIds(ids);
  }, []);

  useEffect(() => {
    let cancelled = false;

    getOfflineBookIds().then(ids => {
      if (!cancelled) setOfflineIds(ids);
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
