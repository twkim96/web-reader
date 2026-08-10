import type { OwnerKey } from './ownerIdentity';

const DRAFT_PREFIX = 'reading_stats_draft_v1:';

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
