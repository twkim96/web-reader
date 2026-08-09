import type { Annotation, AnnotationPaletteItem } from '../types';
import {
  ANNOTATION_BOOK_LIMIT,
  isAnnotation,
  isHighlightColorId,
} from './annotationPolicy';
import {
  ANNOTATION_PALETTE_LABEL_MAX_LENGTH,
  ANNOTATION_PALETTE_MEANING_MAX_LENGTH,
} from './annotationPalette';

export const toAnnotationSyncSchemaError = (error: unknown) => Object.assign(
  error instanceof Error ? error : new Error(String(error)),
  { code: 'invalid-argument' },
);

export type AnnotationSyncPayloadV1 = Omit<Annotation, 'anchorState'>;

export const ANNOTATION_SYNC_RANGE_CFI_MAX_LENGTH = 16_000;
export const ANNOTATION_AGGREGATE_MAX_UTF8_BYTES = 850_000;

export type AnnotationAggregateConflictReasonV1 =
  | 'annotation-duplicate-range'
  | 'annotation-color-limit'
  | 'annotation-book-limit'
  | 'annotation-aggregate-size'
  | 'annotation-book-generation';

export type AnnotationBookAggregateV1 = {
  schemaVersion: 1;
  bookId: string;
  revision: number;
  totalCount: number;
  colorCounts: Record<Annotation['colorId'], number>;
  entries: Record<string, { rangeCfi: string; colorId: Annotation['colorId'] }>;
  rangeCfis: string[];
  acceptedEventId: string;
  acceptedAnnotationId: string;
  acceptedOperation: 'upsert' | 'delete';
  updatedAtServer: unknown;
};

export type AnnotationPalettePayloadV1 = {
  items: AnnotationPaletteItem[];
};

export type AnnotationHeadV1 = {
  schemaVersion: 1;
  bookId: string;
  annotationId: string;
  revision: number;
  acceptedEventId: string;
  operation: 'upsert' | 'delete';
  annotation: AnnotationSyncPayloadV1 | null;
  acceptedDeviceId: string;
  acceptedSessionId: string;
  occurredAtClient: number;
  bookGeneration?: number;
  updatedAtServer: unknown;
  deletedAtServer: unknown | null;
};

export type AnnotationPaletteHeadV1 = {
  schemaVersion: 1;
  revision: number;
  acceptedEventId: string;
  operation: 'set';
  palette: AnnotationPalettePayloadV1;
  acceptedDeviceId: string;
  acceptedSessionId: string;
  occurredAtClient: number;
  updatedAtServer: unknown;
};

export type AnnotationSyncReceiptV1 = {
  schemaVersion: 1;
  eventId: string;
  targetKind: 'annotation' | 'palette';
  bookId: string | null;
  annotationId: string | null;
  targetKey: string;
  revision: number;
  createdAtServer: unknown;
};

export type AnnotationSyncMutationV1 = {
  eventId: string;
  target: { kind: 'annotation'; bookId: string; annotationId: string };
  targetKey: string;
  operation: 'annotation.upsert' | 'annotation.delete';
  payload: AnnotationSyncPayloadV1 | null;
  deviceId: string;
  sessionId: string;
  baseRevision: number;
  forceDelete?: boolean;
  bookGeneration?: number;
  occurredAtClient: number;
};

export type AnnotationPaletteSyncMutationV1 = {
  eventId: string;
  target: { kind: 'palette' };
  targetKey: string;
  operation: 'palette.set';
  payload: AnnotationPalettePayloadV1;
  deviceId: string;
  sessionId: string;
  baseRevision: number;
  occurredAtClient: number;
};

const PALETTE_COLOR_IDS = ['yellow', 'green', 'blue', 'pink', 'purple'] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hasExactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
};

const hasRequiredAndOnlyKeys = (
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
) => required.every((key) => key in value)
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

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

const getAggregateUtf8Size = (value: Record<string, unknown>) => {
  const { updatedAtServer: _updatedAtServer, ...serializable } = value;
  void _updatedAtServer;
  return new TextEncoder().encode(JSON.stringify(serializable)).byteLength;
};

export const getAnnotationAggregateUtf8SizeV1 = (
  value: AnnotationBookAggregateV1,
) => getAggregateUtf8Size(value as unknown as Record<string, unknown>);

export const annotationTargetKeyV1 = (bookId: string, annotationId: string) => (
  `annotation:${bookId}:${annotationId}`
);

export const annotationPaletteTargetKeyV1 = () => 'annotation-palette';

export const getFirebaseAnnotationSyncPath = (appId: string, uid: string) => (
  `artifacts/${appId}/users/${uid}/libraries/local/annotationSyncV1`
);

export const getFirebaseAnnotationBookAggregatePath = (
  appId: string,
  uid: string,
  bookId: string,
) => `${getFirebaseAnnotationSyncPath(appId, uid)}/${bookId}`;

export const getFirebaseAnnotationPalettePath = (appId: string, uid: string) => (
  `artifacts/${appId}/users/${uid}/libraries/local/annotationSettingsV1/palette`
);

export const isAnnotationSyncPayloadV1 = (
  value: unknown,
): value is AnnotationSyncPayloadV1 => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id', 'bookId', 'type', 'sectionIndex', 'rangeCfi', 'quote', 'prefix',
    'suffix', 'colorId', 'note', 'progressPercent', 'chapter',
    'createdAtClient', 'updatedAtClient',
  ])) return false;
  return isBoundedString(value.bookId, 512)
    && isBoundedString(value.rangeCfi, ANNOTATION_SYNC_RANGE_CFI_MAX_LENGTH)
    && isClientTime(value.createdAtClient)
    && (value.createdAtClient as number) > 0
    && isClientTime(value.updatedAtClient)
    && isAnnotation({ ...value, anchorState: 'active' });
};

export const toAnnotationSyncPayloadV1 = (
  annotation: Annotation,
): AnnotationSyncPayloadV1 => {
  const payload: AnnotationSyncPayloadV1 = {
    id: annotation.id,
    bookId: annotation.bookId,
    type: annotation.type,
    sectionIndex: annotation.sectionIndex,
    rangeCfi: annotation.rangeCfi,
    quote: annotation.quote,
    prefix: annotation.prefix,
    suffix: annotation.suffix,
    colorId: annotation.colorId,
    note: annotation.note,
    progressPercent: annotation.progressPercent,
    chapter: annotation.chapter,
    createdAtClient: annotation.createdAtClient,
    updatedAtClient: annotation.updatedAtClient,
  };
  if (!isAnnotationSyncPayloadV1(payload)) {
    throw new Error('동기화할 annotation payload가 올바르지 않습니다.');
  }
  return payload;
};

export const fromAnnotationSyncPayloadV1 = (
  payload: AnnotationSyncPayloadV1,
): Annotation => {
  if (!isAnnotationSyncPayloadV1(payload)) {
    throw new Error('원격 annotation payload가 올바르지 않습니다.');
  }
  return { ...payload, anchorState: 'active' };
};

export const isAnnotationBookAggregateV1 = (
  value: unknown,
): value is AnnotationBookAggregateV1 => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'bookId', 'revision', 'totalCount', 'colorCounts',
    'entries', 'rangeCfis', 'acceptedEventId', 'acceptedAnnotationId',
    'acceptedOperation', 'updatedAtServer',
  ])) return false;
  if (
    value.schemaVersion !== 1
    || !isBoundedString(value.bookId, 512)
    || !isRevision(value.revision)
    || !Number.isSafeInteger(value.totalCount)
    || (value.totalCount as number) < 0
    || (value.totalCount as number) > ANNOTATION_BOOK_LIMIT
    || !isRecord(value.colorCounts)
    || !hasExactKeys(value.colorCounts, [...PALETTE_COLOR_IDS])
    || !isRecord(value.entries)
    || !Array.isArray(value.rangeCfis)
    || !isBoundedString(value.acceptedEventId, 128)
    || !isBoundedString(value.acceptedAnnotationId, 128)
    || (value.acceptedOperation !== 'upsert' && value.acceptedOperation !== 'delete')
    || value.updatedAtServer === null
    || value.updatedAtServer === undefined
  ) return false;
  const colorCounts = value.colorCounts as Record<string, unknown>;
  const entriesRecord = value.entries as Record<string, unknown>;
  const counts = PALETTE_COLOR_IDS.map((colorId) => colorCounts[colorId]);
  if (!counts.every((count): count is number => (
    typeof count === 'number'
    && Number.isSafeInteger(count)
    && count >= 0
    && count <= 20
  ))) return false;
  if (counts.reduce((sum, count) => sum + count, 0) !== value.totalCount) return false;
  const entries = Object.entries(entriesRecord);
  const rangeCfis = value.rangeCfis as unknown[];
  const entryRangeCfis = entries.map(([, entry]) => (
    isRecord(entry) ? entry.rangeCfi : undefined
  ));
  if (
    entries.length !== value.totalCount
    || rangeCfis.length !== value.totalCount
    || !rangeCfis.every((rangeCfi) => (
      isBoundedString(rangeCfi, ANNOTATION_SYNC_RANGE_CFI_MAX_LENGTH)
    ))
    || new Set(rangeCfis).size !== rangeCfis.length
    || new Set(entryRangeCfis).size !== entries.length
    || !rangeCfis.every((rangeCfi) => entryRangeCfis.includes(rangeCfi))
  ) {
    return false;
  }
  return entries.every(([annotationId, entry]) => (
    /^[A-Za-z0-9_-]+$/.test(annotationId)
    && isRecord(entry)
    && hasExactKeys(entry, ['rangeCfi', 'colorId'])
    && isBoundedString(entry.rangeCfi, ANNOTATION_SYNC_RANGE_CFI_MAX_LENGTH)
    && isHighlightColorId(entry.colorId)
    && rangeCfis.includes(entry.rangeCfi)
  ));
};

export const isAnnotationPalettePayloadV1 = (
  value: unknown,
): value is AnnotationPalettePayloadV1 => {
  if (!isRecord(value) || !hasExactKeys(value, ['items']) || !Array.isArray(value.items)) {
    return false;
  }
  if (value.items.length !== PALETTE_COLOR_IDS.length) return false;
  return value.items.every((item, index) => (
    isRecord(item)
    && hasExactKeys(item, ['id', 'label', 'meaning'])
    && item.id === PALETTE_COLOR_IDS[index]
    && isHighlightColorId(item.id)
    && isBoundedString(item.label, ANNOTATION_PALETTE_LABEL_MAX_LENGTH)
    && isBoundedString(item.meaning, ANNOTATION_PALETTE_MEANING_MAX_LENGTH, true)
  ));
};

export const isAnnotationHeadV1 = (value: unknown): value is AnnotationHeadV1 => {
  if (!isRecord(value) || !hasRequiredAndOnlyKeys(value, [
    'schemaVersion', 'bookId', 'annotationId', 'revision', 'acceptedEventId',
    'operation', 'annotation', 'acceptedDeviceId', 'acceptedSessionId',
    'occurredAtClient', 'updatedAtServer', 'deletedAtServer',
  ], ['bookGeneration'])) return false;
  const operationMatches = value.operation === 'upsert'
    ? isAnnotationSyncPayloadV1(value.annotation)
      && value.annotation.id === value.annotationId
      && value.annotation.bookId === value.bookId
      && value.deletedAtServer === null
    : value.operation === 'delete'
      ? value.annotation === null
        && value.deletedAtServer !== null
        && value.deletedAtServer !== undefined
      : false;
  return value.schemaVersion === 1
    && isBoundedString(value.bookId, 512)
    && isBoundedString(value.annotationId, 128)
    && isRevision(value.revision)
    && isBoundedString(value.acceptedEventId, 128)
    && isBoundedString(value.acceptedDeviceId, 128)
    && isBoundedString(value.acceptedSessionId, 128)
    && isClientTime(value.occurredAtClient)
    && (value.bookGeneration === undefined || isClientTime(value.bookGeneration))
    && value.updatedAtServer !== null
    && value.updatedAtServer !== undefined
    && operationMatches;
};

export const isAnnotationPaletteHeadV1 = (
  value: unknown,
): value is AnnotationPaletteHeadV1 => (
  isRecord(value)
  && hasExactKeys(value, [
    'schemaVersion', 'revision', 'acceptedEventId', 'operation', 'palette',
    'acceptedDeviceId', 'acceptedSessionId', 'occurredAtClient', 'updatedAtServer',
  ])
  && value.schemaVersion === 1
  && isRevision(value.revision)
  && isBoundedString(value.acceptedEventId, 128)
  && value.operation === 'set'
  && isAnnotationPalettePayloadV1(value.palette)
  && isBoundedString(value.acceptedDeviceId, 128)
  && isBoundedString(value.acceptedSessionId, 128)
  && isClientTime(value.occurredAtClient)
  && value.updatedAtServer !== null
  && value.updatedAtServer !== undefined
);

export const isAnnotationSyncReceiptV1 = (
  value: unknown,
): value is AnnotationSyncReceiptV1 => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'eventId', 'targetKind', 'bookId', 'annotationId',
    'targetKey', 'revision', 'createdAtServer',
  ])) return false;
  const targetMatches = value.targetKind === 'annotation'
    ? isBoundedString(value.bookId, 512)
      && isBoundedString(value.annotationId, 128)
      && value.targetKey === annotationTargetKeyV1(
        value.bookId as string,
        value.annotationId as string,
      )
    : value.targetKind === 'palette'
      && value.bookId === null
      && value.annotationId === null
      && value.targetKey === annotationPaletteTargetKeyV1()
    ;
  return value.schemaVersion === 1
    && isBoundedString(value.eventId, 128)
    && targetMatches
    && isBoundedString(value.targetKey, 1_024)
    && isRevision(value.revision)
    && value.createdAtServer !== null
    && value.createdAtServer !== undefined;
};

export const parseAnnotationHeadV1 = (value: unknown) => {
  if (!isAnnotationHeadV1(value)) throw new Error('원격 annotation head가 올바르지 않습니다.');
  return value;
};

export const parseAnnotationPaletteHeadV1 = (value: unknown) => {
  if (!isAnnotationPaletteHeadV1(value)) throw new Error('원격 annotation palette가 올바르지 않습니다.');
  return value;
};

export const MAX_SYNCED_ANNOTATIONS_PER_BOOK = ANNOTATION_BOOK_LIMIT;
