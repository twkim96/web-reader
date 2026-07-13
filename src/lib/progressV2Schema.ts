import type { LibraryScopeKey } from './ownerIdentity';
import { FIREBASE_SYNC_SCOPE_KEY, getLibraryScopeId } from './ownerIdentity';

export type ProgressPositionV2 = {
  cfi: string;
  anchorCfi: string | null;
  progressPercent: number;
};

export type ManualBookmarkPayloadV2 = {
  bookmarkId: string;
  cfi: string;
  name: string;
  color: string;
  progressPercent: number | null;
  createdAtClient: number;
  updatedAtClient: number;
};

export type ProgressHeadV2 = {
  schemaVersion: 2;
  bookId: string;
  revision: number;
  acceptedEventId: string;
  operation: 'set' | 'reset';
  position: ProgressPositionV2 | null;
  acceptedDeviceId: string;
  occurredAtClient: number;
  updatedAtServer: unknown;
  deletedAtServer: unknown | null;
};

export type BookmarkHeadV2 = {
  schemaVersion: 2;
  bookId: string;
  bookmarkId: string;
  revision: number;
  acceptedEventId: string;
  operation: 'upsert' | 'delete';
  bookmark: ManualBookmarkPayloadV2 | null;
  acceptedDeviceId: string;
  occurredAtClient: number;
  updatedAtServer: unknown;
  deletedAtServer: unknown | null;
};

export type EventReceiptV2 = {
  schemaVersion: 2;
  eventId: string;
  targetKind: 'progress' | 'bookmark';
  bookId: string;
  bookmarkId: string | null;
  targetKey: string;
  revision: number;
  createdAtServer: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hasExactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length
    && actual.every((key, index) => key === [...keys].sort()[index]);
};

const isBoundedString = (value: unknown, maxLength: number, allowEmpty = false) => (
  typeof value === 'string'
  && value.length <= maxLength
  && (allowEmpty || value.length > 0)
);

const isClientTime = (value: unknown) => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
);

const isRevision = (value: unknown) => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
);

export const isProgressPositionV2 = (value: unknown): value is ProgressPositionV2 => {
  if (!isRecord(value) || !hasExactKeys(value, ['cfi', 'anchorCfi', 'progressPercent'])) {
    return false;
  }
  return isBoundedString(value.cfi, 8_192)
    && (value.anchorCfi === null || isBoundedString(value.anchorCfi, 8_192))
    && typeof value.progressPercent === 'number'
    && Number.isFinite(value.progressPercent)
    && value.progressPercent >= 0
    && value.progressPercent <= 100;
};

export const isManualBookmarkPayloadV2 = (
  value: unknown,
): value is ManualBookmarkPayloadV2 => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'bookmarkId',
    'cfi',
    'name',
    'color',
    'progressPercent',
    'createdAtClient',
    'updatedAtClient',
  ])) return false;
  return isBoundedString(value.bookmarkId, 128)
    && isBoundedString(value.cfi, 8_192)
    && isBoundedString(value.name, 512, true)
    && isBoundedString(value.color, 64)
    && (
      value.progressPercent === null
      || (
        typeof value.progressPercent === 'number'
        && Number.isFinite(value.progressPercent)
        && value.progressPercent >= 0
        && value.progressPercent <= 100
      )
    )
    && isClientTime(value.createdAtClient)
    && isClientTime(value.updatedAtClient)
    && (value.updatedAtClient as number) >= (value.createdAtClient as number);
};

export const isProgressHeadV2 = (value: unknown): value is ProgressHeadV2 => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'bookId', 'revision', 'acceptedEventId', 'operation',
    'position', 'acceptedDeviceId', 'occurredAtClient', 'updatedAtServer',
    'deletedAtServer',
  ])) return false;
  const operationMatches = value.operation === 'set'
    ? isProgressPositionV2(value.position) && value.deletedAtServer === null
    : value.operation === 'reset'
      && value.position === null
      && value.deletedAtServer !== null;
  return value.schemaVersion === 2
    && isBoundedString(value.bookId, 512)
    && isRevision(value.revision)
    && isBoundedString(value.acceptedEventId, 128)
    && isBoundedString(value.acceptedDeviceId, 128)
    && isClientTime(value.occurredAtClient)
    && value.updatedAtServer !== null
    && value.updatedAtServer !== undefined
    && operationMatches;
};

export const isBookmarkHeadV2 = (value: unknown): value is BookmarkHeadV2 => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'bookId', 'bookmarkId', 'revision', 'acceptedEventId',
    'operation', 'bookmark', 'acceptedDeviceId', 'occurredAtClient',
    'updatedAtServer', 'deletedAtServer',
  ])) return false;
  const operationMatches = value.operation === 'upsert'
    ? isManualBookmarkPayloadV2(value.bookmark)
      && value.bookmark.bookmarkId === value.bookmarkId
      && value.deletedAtServer === null
    : value.operation === 'delete'
      && value.bookmark === null
      && value.deletedAtServer !== null;
  return value.schemaVersion === 2
    && isBoundedString(value.bookId, 512)
    && isBoundedString(value.bookmarkId, 128)
    && isRevision(value.revision)
    && isBoundedString(value.acceptedEventId, 128)
    && isBoundedString(value.acceptedDeviceId, 128)
    && isClientTime(value.occurredAtClient)
    && value.updatedAtServer !== null
    && value.updatedAtServer !== undefined
    && operationMatches;
};

export const isEventReceiptV2 = (value: unknown): value is EventReceiptV2 => (
  isRecord(value)
  && hasExactKeys(value, [
    'schemaVersion', 'eventId', 'targetKind', 'bookId', 'bookmarkId',
    'targetKey', 'revision', 'createdAtServer',
  ])
  && value.schemaVersion === 2
  && isBoundedString(value.eventId, 128)
  && isBoundedString(value.bookId, 512)
  && (
    value.targetKind === 'progress'
      ? value.bookmarkId === null
        && value.targetKey === progressTargetKeyV2(value.bookId as string)
      : value.targetKind === 'bookmark'
        ? isBoundedString(value.bookmarkId, 128)
          && value.targetKey === bookmarkTargetKeyV2(
            value.bookId as string,
            value.bookmarkId as string,
          )
        : false
  )
  && isBoundedString(value.targetKey, 1_024)
  && isRevision(value.revision)
  && value.createdAtServer !== null
  && value.createdAtServer !== undefined
);

const requireValid = <T>(value: unknown, validator: (candidate: unknown) => candidate is T) => {
  if (!validator(value)) throw new Error('유효하지 않은 v2 동기화 문서입니다.');
  return value;
};

export const parseProgressHeadV2 = (value: unknown) => requireValid(value, isProgressHeadV2);
export const parseBookmarkHeadV2 = (value: unknown) => requireValid(value, isBookmarkHeadV2);
export const parseEventReceiptV2 = (value: unknown) => requireValid(value, isEventReceiptV2);

export const getV1HistoryPath = (appId: string, uid: string) => (
  `artifacts/${appId}/users/${uid}/readingHistory`
);

export const getV2HistoryPath = (
  appId: string,
  uid: string,
  libraryScopeKey: LibraryScopeKey,
) => `artifacts/${appId}/users/${uid}/libraries/${getLibraryScopeId(libraryScopeKey)}/readingHistoryV2`;

export const getFirebaseSyncHistoryPath = (appId: string, uid: string) => (
  getV2HistoryPath(appId, uid, FIREBASE_SYNC_SCOPE_KEY)
);

export const progressTargetKeyV2 = (bookId: string) => `progress:${bookId}`;
export const bookmarkTargetKeyV2 = (bookId: string, bookmarkId: string) => (
  `bookmark:${bookId}:${bookmarkId}`
);
