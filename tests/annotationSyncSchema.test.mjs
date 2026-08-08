import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_ANNOTATION_PALETTE } from '../src/lib/annotationPalette.ts';
import {
  annotationPaletteTargetKeyV1,
  annotationTargetKeyV1,
  fromAnnotationSyncPayloadV1,
  isAnnotationBookAggregateV1,
  isAnnotationHeadV1,
  isAnnotationPaletteHeadV1,
  isAnnotationPalettePayloadV1,
  isAnnotationSyncPayloadV1,
  isAnnotationSyncReceiptV1,
  toAnnotationSyncPayloadV1,
} from '../src/lib/annotationSyncSchema.ts';

const annotation = (overrides = {}) => ({
  id: 'annotation-1',
  bookId: 'book-1',
  type: 'highlight',
  sectionIndex: 3,
  rangeCfi: 'epubcfi(/6/4!/4/2,/1:0,/1:4)',
  quote: '문장',
  prefix: '앞',
  suffix: '뒤',
  colorId: 'yellow',
  note: '메모',
  progressPercent: 25,
  chapter: '1장',
  createdAtClient: 1,
  updatedAtClient: 2,
  anchorState: 'unresolved',
  ...overrides,
});

const payload = () => toAnnotationSyncPayloadV1(annotation());

test('serializes annotations without propagating renderer-local anchor state', () => {
  const serialized = payload();
  assert.equal(isAnnotationSyncPayloadV1(serialized), true);
  assert.equal('anchorState' in serialized, false);
  assert.equal(fromAnnotationSyncPayloadV1(serialized).anchorState, 'active');
  assert.equal(isAnnotationSyncPayloadV1({ ...serialized, anchorState: 'unresolved' }), false);
});

test('validates a bounded book aggregate with one range owner', () => {
  const serialized = payload();
  assert.equal(isAnnotationBookAggregateV1({
    schemaVersion: 1,
    bookId: 'book-1',
    revision: 1,
    totalCount: 1,
    colorCounts: { yellow: 1, green: 0, blue: 0, pink: 0, purple: 0 },
    entries: {
      'annotation-1': { rangeCfi: serialized.rangeCfi, colorId: 'yellow' },
    },
    rangeCfis: [serialized.rangeCfi],
    acceptedEventId: 'event-1',
    acceptedAnnotationId: 'annotation-1',
    acceptedOperation: 'upsert',
    updatedAtServer: {},
  }), true);
});

test('rejects invalid annotation sync identities and non-integer client times', () => {
  assert.equal(isAnnotationSyncPayloadV1({ ...payload(), id: '' }), false);
  assert.equal(isAnnotationSyncPayloadV1({ ...payload(), bookId: 'x'.repeat(513) }), false);
  assert.equal(isAnnotationSyncPayloadV1({ ...payload(), updatedAtClient: 2.5 }), false);
  assert.throws(
    () => toAnnotationSyncPayloadV1(annotation({ bookId: 'x'.repeat(513) })),
    /payload/,
  );
});

test('accepts only one canonical five-color palette payload', () => {
  const palette = { items: DEFAULT_ANNOTATION_PALETTE.map((item) => ({ ...item })) };
  assert.equal(isAnnotationPalettePayloadV1(palette), true);
  assert.equal(isAnnotationPalettePayloadV1({ items: palette.items.slice(0, 4) }), false);
  assert.equal(isAnnotationPalettePayloadV1({
    items: [palette.items[1], palette.items[0], ...palette.items.slice(2)],
  }), false);
  assert.equal(isAnnotationPalettePayloadV1({
    items: palette.items.map((item, index) => index === 0 ? { ...item, extra: true } : item),
  }), false);
});

test('validates exact annotation and palette heads and receipts', () => {
  const serverTime = { seconds: 1 };
  const annotationHead = {
    schemaVersion: 1,
    bookId: 'book-1',
    annotationId: 'annotation-1',
    revision: 1,
    acceptedEventId: 'event-1',
    operation: 'upsert',
    annotation: payload(),
    acceptedDeviceId: 'device-1',
    acceptedSessionId: 'session-1',
    occurredAtClient: 2,
    updatedAtServer: serverTime,
    deletedAtServer: null,
  };
  const annotationReceipt = {
    schemaVersion: 1,
    eventId: 'event-1',
    targetKind: 'annotation',
    bookId: 'book-1',
    annotationId: 'annotation-1',
    targetKey: annotationTargetKeyV1('book-1', 'annotation-1'),
    revision: 1,
    createdAtServer: serverTime,
  };
  const paletteHead = {
    schemaVersion: 1,
    revision: 1,
    acceptedEventId: 'palette-event-1',
    operation: 'set',
    palette: { items: DEFAULT_ANNOTATION_PALETTE.map((item) => ({ ...item })) },
    acceptedDeviceId: 'device-1',
    acceptedSessionId: 'session-1',
    occurredAtClient: 2,
    updatedAtServer: serverTime,
  };
  const paletteReceipt = {
    schemaVersion: 1,
    eventId: 'palette-event-1',
    targetKind: 'palette',
    bookId: null,
    annotationId: null,
    targetKey: annotationPaletteTargetKeyV1(),
    revision: 1,
    createdAtServer: serverTime,
  };
  assert.equal(isAnnotationHeadV1(annotationHead), true);
  assert.equal(isAnnotationSyncReceiptV1(annotationReceipt), true);
  assert.equal(isAnnotationPaletteHeadV1(paletteHead), true);
  assert.equal(isAnnotationSyncReceiptV1(paletteReceipt), true);
  assert.equal(isAnnotationHeadV1({ ...annotationHead, annotationId: 'other' }), false);
  assert.equal(isAnnotationSyncReceiptV1({ ...paletteReceipt, bookId: 'book-1' }), false);
});
