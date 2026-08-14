'use client';

import { useEffect, useState } from 'react';
import type { OwnerKey } from '../../lib/ownerIdentity';
import { getLocalReadingSessionsV11 } from '../../lib/localReadingStatistics';
import { buildReadingStatistics, formatReadingClock } from '../../lib/readingStatistics';
import type { ReadingSessionV1 } from '../../lib/readingStatistics';
import { subscribeReadingStatisticsChanges } from '../../lib/readingStatisticsWake';
import { readHiddenReadingStatisticsSessionIds } from '../../lib/readingStatisticsSessionVisibility';

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
        const sessions = await getLocalReadingSessionsV11(ownerKey);
        if (cancelled || generation !== loadGeneration) return;
        const hiddenSessionIds = readHiddenReadingStatisticsSessionIds(ownerKey);
        persistedMs = buildReadingStatistics(sessions.filter(({ sessionId }) => (
          !hiddenSessionIds.has(sessionId)
        ))).books
          .find((book) => book.bookId === bookId)?.totalMs ?? 0;
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
  }, [bookId, displayKey, enabled, getActiveSessionPreview, ownerKey]);

  return formatReadingClock(display.key === displayKey ? display.minutes * 60_000 : 0);
};
