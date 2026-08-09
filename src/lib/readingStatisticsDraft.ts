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
