'use client';

import { useEffect, useState } from 'react';
import { getLocalReadingReportSnapshot } from '../lib/localReadingStatistics';
import type { OwnerKey } from '../lib/ownerIdentity';
import type { StoredReadingSessionV11 } from '../lib/readingStatistics';
import { subscribeReadingStatisticsChanges, subscribeReadingStatisticsServerChecks } from '../lib/readingStatisticsWake';
import type { ReadingRollupCheckpoint } from '../lib/readingRollupBootstrap';

type Snapshot = {
  ownerKey: OwnerKey;
  sessions: StoredReadingSessionV11[];
  rawHistoryComplete: boolean;
  published?: ReadingRollupCheckpoint;
  tailComplete: boolean;
  recentOnly: boolean;
  error: boolean;
};

export function useLocalReadingReportSessions(ownerKey: OwnerKey, enabled: boolean, verifyHistory: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let verified = false;
    let request = 0;
    let timer: number | undefined;
    const load = async () => {
      const current = ++request;
      try {
        const result = await getLocalReadingReportSnapshot(ownerKey, verifyHistory);
        if (disposed || request !== current) return;
        verified = result.rawHistoryComplete || result.tailComplete;
        setSnapshot({ ownerKey, ...result, error: false });
      } catch (error) {
        if (disposed || request !== current) return;
        console.error('[ReadingStatistics] load failed:', error);
        setSnapshot({ ownerKey, sessions: [], rawHistoryComplete: false, tailComplete: false, recentOnly: false, error: true });
      }
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 250);
    };
    const change = subscribeReadingStatisticsChanges(ownerKey, schedule);
    const check = verifyHistory ? subscribeReadingStatisticsServerChecks(ownerKey, (checkedAt) => {
      // The initial archive-only view also has to advance on an empty final page.
      if (checkedAt !== null && !verified) schedule();
    }) : undefined;
    void load();
    return () => {
      disposed = true;
      change();
      check?.();
      window.clearTimeout(timer);
    };
  }, [enabled, ownerKey, verifyHistory]);
  return enabled && snapshot?.ownerKey === ownerKey ? snapshot : null;
}
