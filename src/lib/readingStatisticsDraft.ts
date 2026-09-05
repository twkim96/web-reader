import type { OwnerKey } from './ownerIdentity';

const DRAFT_PREFIX = 'reading_stats_draft_v1:';

const getWriterLockName = (writerId: string) => `${DRAFT_PREFIX}writer:${writerId}`;

// A browser-held lock is a liveness signal even when a background tab's timers
// are throttled. The browser releases it when that execution context crashes.
export const holdReadingStatisticsDraftWriter = (writerId: string, locks?: LockManager) => {
  let release = () => {};
  const lifetime = new Promise<void>((resolve) => { release = resolve; });
  if (locks) {
    void locks.request(getWriterLockName(writerId), () => lifetime).catch(() => undefined);
  }
  return release;
};

export const recoverReadingStatisticsDraft = async <T extends {
  writerId?: string;
  state?: 'active' | 'closed-pending';
}>(
  key: string,
  readDraft: () => T | null,
  recover: (draft: T) => Promise<void>,
  locks?: LockManager,
) => {
  const recoverCurrent = async () => {
    const draft = readDraft();
    if (!draft) return;
    if (draft.state === 'closed-pending') {
      await recover(draft);
    } else if (draft.writerId && locks) {
      await locks.request(getWriterLockName(draft.writerId), { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        // The writer may have journaled its final close between our first read
        // and the browser granting this lock. Commit that final snapshot.
        const current = readDraft();
        if (current && current.writerId === draft.writerId) await recover(current);
      });
    }
    // Legacy active drafts and browsers without Web Locks cannot prove the
    // writer is gone. Retain their journal rather than freeze a live session.
  };
  if (locks) {
    await locks.request(`${DRAFT_PREFIX}recovery:${key}`, { ifAvailable: true }, async (lock) => {
      if (lock) await recoverCurrent();
    });
  } else {
    // Closed records are immutable; IndexedDB's existing session-ID check makes
    // concurrent closed-record retries idempotent without a browser lock.
    await recoverCurrent();
  }
};

export const getReadingStatisticsDraftPrefix = (ownerKey: OwnerKey, deviceId: string) => (
  `${DRAFT_PREFIX}${encodeURIComponent(ownerKey)}:${encodeURIComponent(deviceId)}:`
);

export const getReadingStatisticsDraftKey = (
  ownerKey: OwnerKey,
  deviceId: string,
  bookId: string,
  sessionId: string,
) => (
  `${getReadingStatisticsDraftPrefix(ownerKey, deviceId)}${encodeURIComponent(bookId)}:${encodeURIComponent(sessionId)}`
);

export const getReadingStatisticsDraftRecoveryEnd = (draft: {
  state?: 'active' | 'closed-pending';
  closedAtClient?: number;
  lastHeartbeatAt: number;
  activeIntervals?: ReadonlyArray<{ endedAtClient: number }>;
}) => Math.max(
  draft.state === 'closed-pending' && Number.isSafeInteger(draft.closedAtClient)
    ? Number(draft.closedAtClient)
    : draft.lastHeartbeatAt,
  draft.activeIntervals?.at(-1)?.endedAtClient ?? 0,
);
