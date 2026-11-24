'use client';

import { useEffect, useState } from 'react';
import type { OwnerKey } from '../../lib/ownerIdentity';
import { getLocalReadingSessionsForFileTotals } from '../../lib/localReadingStatistics';
import { formatReadingClock } from '../../lib/readingStatistics';
import { getReadingFileTime } from '../../lib/readingStatisticsRollup';
import type { ReadingSessionV1 } from '../../lib/readingStatistics';
import { subscribeReadingStatisticsChanges } from '../../lib/readingStatisticsWake';
import { useMyPageReadingFiles } from '../useMyPageList';

const DISPLAY_REFRESH_MS = 5_000;

export const useCurrentBookReadingTime = ({
  ownerKey,
  bookId,
  enabled,
  getActiveSessionPreview,
}: {
  ownerKey: OwnerKey;
  bookId: string;
  enabled: boolean;
  getActiveSessionPreview: () => ReadingSessionV1 | null;
}) => {
  const displayKey = `${ownerKey}:${bookId}`;
  const [display, setDisplay] = useState({ key: displayKey, minutes: 0 });
  const { data: published } = useMyPageReadingFiles(ownerKey, enabled);
  const archived = published?.history;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let persistedMs = 0;
    let displayedMinutes = 0;
    let loadGeneration = 0;

    setDisplay({ key: displayKey, minutes: 0 });
    const refreshDisplay = (allowDecrease = false) => {
      if (cancelled) return;
      const totalMs = persistedMs + (getActiveSessionPreview()?.durationMs ?? 0);
      const measuredMinutes = Math.floor(totalMs / 60_000);
      const nextMinutes = allowDecrease
        ? measuredMinutes
        : Math.max(displayedMinutes, measuredMinutes);
      if (nextMinutes === displayedMinutes) return;
      displayedMinutes = nextMinutes;
      setDisplay({ key: displayKey, minutes: nextMinutes });
    };
    const reloadPersisted = async () => {
      const generation = ++loadGeneration;
      try {
        const sessions = await getLocalReadingSessionsForFileTotals(ownerKey, archived);
        if (cancelled || generation !== loadGeneration) return;
        persistedMs = getReadingFileTime(sessions, bookId, archived);
        refreshDisplay(true);
      } catch (error) {
        console.error('[ReadingStatistics] current book total load failed:', error);
      }
    };

    void reloadPersisted();
    const unsubscribe = subscribeReadingStatisticsChanges(ownerKey, () => {
      void reloadPersisted();
    });
    const intervalId = window.setInterval(refreshDisplay, DISPLAY_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      unsubscribe();
    };
  }, [archived, bookId, displayKey, enabled, getActiveSessionPreview, ownerKey]);

  return formatReadingClock(display.key === displayKey ? display.minutes * 60_000 : 0);
};
