import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_ANNOTATION_PALETTE } from '../src/lib/annotationPalette.ts';
import {
  ANNOTATION_AGGREGATE_MAX_UTF8_BYTES,
  annotationPaletteTargetKeyV1,
  annotationTargetKeyV1,
  getAnnotationAggregateUtf8SizeV1,
  isAnnotationBookAggregateV1,
  toAnnotationSyncPayloadV1,
} from '../src/lib/annotationSyncSchema.ts';
import {
  decideAnnotationPaletteTransaction,
  decideAnnotationTransaction,
} from '../src/lib/annotationSyncTransaction.ts';

const payload = (note = '메모') => toAnnotationSyncPayloadV1({
  id: 'annotation-1',
  bookId: 'book-1',
  type: 'highlight',
  sectionIndex: 0,
  rangeCfi: 'epubcfi(/6/4!/4/2,/1:0,/1:4)',
  quote: '문장',
  prefix: '',
  suffix: '',
  colorId: 'green',
  note,
  progressPercent: 20,
  chapter: '1장',
  createdAtClient: 1,
  updatedAtClient: note.length + 1,
  anchorState: 'active',
});

const annotationEvent = (
  eventId,
  baseRevision = 0,
  operation = 'annotation.upsert',
) => ({
  eventId,
  target: { kind: 'annotation', bookId: 'book-1', annotationId: 'annotation-1' },
  targetKey: annotationTargetKeyV1('book-1', 'annotation-1'),
  operation,
  payload: operation === 'annotation.delete' ? null : payload(eventId),
  deviceId: `device-${eventId}`,
  sessionId: `session-${eventId}`,
  baseRevision,
  occurredAtClient: baseRevision + 1,
});

const annotationEventFor = ({ id, rangeCfi, colorId = 'yellow', eventId }) => ({
  eventId,
  target: { kind: 'annotation', bookId: 'book-1', annotationId: id },
  targetKey: annotationTargetKeyV1('book-1', id),
  operation: 'annotation.upsert',
  payload: toAnnotationSyncPayloadV1({
    id,
    bookId: 'book-1',
    type: 'highlight',
    sectionIndex: 0,
    rangeCfi,
    quote: `문장 ${id}`,
    prefix: '',
    suffix: '',
    colorId,
    note: '',
    progressPercent: 20,
    chapter: '1장',
    createdAtClient: 1,
    updatedAtClient: 1,
    anchorState: 'active',
  }),
  deviceId: 'device',
  sessionId: 'session',
  baseRevision: 0,
  bookGeneration: 0,
  occurredAtClient: 1,
});

const paletteEvent = (eventId, baseRevision = 0) => ({
  eventId,
  target: { kind: 'palette' },
  targetKey: annotationPaletteTargetKeyV1(),
  operation: 'palette.set',
  payload: { items: DEFAULT_ANNOTATION_PALETTE.map((item) => ({ ...item })) },
  deviceId: `device-${eventId}`,
  sessionId: `session-${eventId}`,
  baseRevision,
  occurredAtClient: baseRevision + 1,
});

test('applies an annotation, replays its immutable receipt, and detects stale edits', () => {
  const first = decideAnnotationTransaction({
    event: annotationEvent('event-1'),
    storedHead: undefined,
    storedReceipt: undefined,
    storedAggregate: undefined,
    serverTime: 'server-1',
  });
  assert.equal(first.status, 'apply');
  assert.equal(first.head.revision, 1);
  assert.equal(first.head.operation, 'upsert');

  const replay = decideAnnotationTransaction({
    event: annotationEvent('event-1'),
    storedHead: first.head,
    storedReceipt: first.receipt,
    storedAggregate: first.aggregate,
    serverTime: 'server-2',
  });
  assert.equal(replay.status, 'already_applied');

  const stale = decideAnnotationTransaction({
    event: annotationEvent('stale-event'),
    storedHead: first.head,
    storedReceipt: undefined,
    storedAggregate: first.aggregate,
    serverTime: 'server-2',
  });
  assert.equal(stale.status, 'conflict');
  assert.equal(stale.remoteHead.revision, 1);
});

test('uses a revisioned tombstone and rejects identity mismatches', () => {
  const first = decideAnnotationTransaction({
    event: annotationEvent('event-1'),
    storedHead: undefined,
    storedReceipt: undefined,
    storedAggregate: undefined,
    serverTime: 'server-1',
  });
  const deleted = decideAnnotationTransaction({
    event: annotationEvent('event-2', 1, 'annotation.delete'),
    storedHead: first.head,
    storedReceipt: undefined,
    storedAggregate: first.aggregate,
    serverTime: 'server-2',
  });
  assert.equal(deleted.status, 'apply');
  assert.equal(deleted.head.revision, 2);
  assert.equal(deleted.head.operation, 'delete');
  assert.equal(deleted.head.annotation, null);
  assert.equal(deleted.head.deletedAtServer, 'server-2');

  assert.throws(() => decideAnnotationTransaction({
    event: { ...annotationEvent('bad'), targetKey: 'annotation:other' },
    storedHead: undefined,
    storedReceipt: undefined,
    storedAggregate: undefined,
    serverTime: 'server',
  }), /target key/);
});

test('force-deletes a book annotation at the latest remote revision', () => {
  const first = decideAnnotationTransaction({
    event: annotationEvent('event-1'),
    storedHead: undefined,
    storedReceipt: undefined,
    storedAggregate: undefined,
    serverTime: 'server-1',
  });
  const deletion = decideAnnotationTransaction({
    event: {
      ...annotationEvent('book-delete', 0, 'annotation.delete'),
      forceDelete: true,
    },
    storedHead: first.head,
    storedReceipt: undefined,
    storedAggregate: first.aggregate,
    serverTime: 'server-2',
  });
  assert.equal(deletion.status, 'apply');
  assert.equal(deletion.head.revision, 2);
  assert.equal(deletion.head.operation, 'delete');
});

test('uses marker revision instead of client clocks as the book generation', () => {
  const markerEvent = {
    eventId: 'marker-1',
    target: {
      kind: 'annotation',
      bookId: 'book-1',
      annotationId: 'book_delete_marker_v1',
    },
    targetKey: annotationTargetKeyV1('book-1', 'book_delete_marker_v1'),
    operation: 'annotation.delete',
    payload: null,
    deviceId: 'delete-device',
    sessionId: 'delete-session',
    baseRevision: 0,
    bookGeneration: 0,
    occurredAtClient: 10,
    forceDelete: true,
  };
  const marker = decideAnnotationTransaction({
    event: markerEvent,
    storedHead: undefined,
    storedReceipt: undefined,
    storedAggregate: undefined,
    storedBookDeleteMarker: undefined,
    serverTime: 'server-marker',
  });
  assert.equal(marker.status, 'apply');
  assert.equal(marker.head.bookGeneration, 1);

  const stale = decideAnnotationTransaction({
    event: {
      ...annotationEventFor({
        id: 'stale-future-clock',
        rangeCfi: 'epubcfi(/6/4!/4/2,/1:0,/1:4)',
        eventId: 'stale-future-clock-event',
      }),
      bookGeneration: 0,
      occurredAtClient: 9_999_999,
    },
    storedHead: undefined,
    storedReceipt: undefined,
    storedAggregate: marker.aggregate,
    storedBookDeleteMarker: marker.head,
    serverTime: 'server-stale',
  });
  assert.equal(stale.status, 'conflict');
  assert.equal(stale.conflictReason, 'annotation-book-generation');

  const fresh = decideAnnotationTransaction({
    event: {
      ...annotationEventFor({
        id: 'fresh-slow-clock',
        rangeCfi: 'epubcfi(/6/4!/4/2,/1:5,/1:9)',
        eventId: 'fresh-slow-clock-event',
      }),
      bookGeneration: 1,
      occurredAtClient: 1,
    },
    storedHead: undefined,
    storedReceipt: undefined,
    storedAggregate: marker.aggregate,
    storedBookDeleteMarker: marker.head,
    serverTime: 'server-fresh',
  });
  assert.equal(fresh.status, 'apply');
  assert.equal(fresh.head.bookGeneration, 1);
});

test('serializes different annotation ids through the book aggregate', () => {
  const rangeCfi = 'epubcfi(/6/4!/4/2,/1:0,/1:4)';
  const first = decideAnnotationTransaction({
    event: annotationEventFor({ id: 'a', rangeCfi, eventId: 'a-event' }),
    storedHead: undefined,
    storedReceipt: undefined,
    storedAggregate: undefined,
    serverTime: 'server-1',
  });
  assert.equal(first.status, 'apply');
  const duplicate = decideAnnotationTransaction({
    event: annotationEventFor({ id: 'b', rangeCfi, eventId: 'b-event' }),
    storedHead: undefined,
    storedReceipt: undefined,
    storedAggregate: first.aggregate,
    serverTime: 'server-2',
  });
  assert.equal(duplicate.status, 'conflict');
  assert.equal(duplicate.conflictReason, 'annotation-duplicate-range');
  assert.equal(first.aggregate.totalCount, 1);
});

test('rejects a twenty-first color entry through the book aggregate', () => {
  let aggregate;
  for (let index = 0; index < 20; index += 1) {
    const decision = decideAnnotationTransaction({
      event: annotationEventFor({
        id: `yellow-${index}`,
        rangeCfi: `epubcfi(/6/4!/4/2,/1:${index},/1:${index + 1})`,
        eventId: `yellow-event-${index}`,
      }),
      storedHead: undefined,
      storedReceipt: undefined,
      storedAggregate: aggregate,
      serverTime: `server-${index}`,
    });
    assert.equal(decision.status, 'apply');
    aggregate = decision.aggregate;
  }
  const overLimit = decideAnnotationTransaction({
    event: annotationEventFor({
      id: 'yellow-20',
      rangeCfi: 'epubcfi(/6/4!/4/2,/1:40,/1:41)',
      eventId: 'yellow-event-20',
    }),
    storedHead: undefined,
    storedReceipt: undefined,
    storedAggregate: aggregate,
    serverTime: 'server-20',
  });
  assert.equal(overLimit.status, 'conflict');
  assert.equal(overLimit.conflictReason, 'annotation-color-limit');
});

test('blocks aggregate growth past the byte budget but permits legacy aggregate shrinkage', () => {
  const colors = ['yellow', 'green', 'blue', 'pink', 'purple'];
  const cfiBodyLength = 16_000 - 'epubcfi()'.length;
  let aggregate;
  let sizeConflict;
  for (let index = 0; index < 100; index += 1) {
    const rangeCfi = `epubcfi(${'x'.repeat(cfiBodyLength - String(index).length)}${index})`;
    const decision = decideAnnotationTransaction({
      event: annotationEventFor({
        id: `large-${index}`,
        rangeCfi,
        colorId: colors[index % colors.length],
        eventId: `large-event-${index}`,
      }),
      storedHead: undefined,
      storedReceipt: undefined,
      storedAggregate: aggregate,
      serverTime: `server-large-${index}`,
    });
    if (decision.status === 'conflict') {
      sizeConflict = decision;
      break;
    }
    aggregate = decision.aggregate;
  }
  assert.equal(sizeConflict?.conflictReason, 'annotation-aggregate-size');
  assert.ok(getAnnotationAggregateUtf8SizeV1(aggregate) <= ANNOTATION_AGGREGATE_MAX_UTF8_BYTES);

  const entries = {};
  const rangeCfis = [];
  for (let index = 0; index < 30; index += 1) {
    const id = `legacy-${index}`;
    const rangeCfi = `epubcfi(${'y'.repeat(cfiBodyLength - String(index).length)}${index})`;
    entries[id] = { rangeCfi, colorId: colors[index % colors.length] };
    rangeCfis.push(rangeCfi);
  }
  const legacyAggregate = {
    schemaVersion: 1,
    bookId: 'book-1',
    revision: 30,
    totalCount: 30,
    colorCounts: { yellow: 6, green: 6, blue: 6, pink: 6, purple: 6 },
    entries,
    rangeCfis,
    acceptedEventId: 'legacy-event-29',
    acceptedAnnotationId: 'legacy-29',
    acceptedOperation: 'upsert',
    updatedAtServer: 'server-legacy',
  };
  assert.equal(isAnnotationBookAggregateV1(legacyAggregate), true);
  assert.ok(
    getAnnotationAggregateUtf8SizeV1(legacyAggregate) > ANNOTATION_AGGREGATE_MAX_UTF8_BYTES,
  );
  const legacyItem = {
    ...payload(),
    id: 'legacy-0',
    rangeCfi: rangeCfis[0],
    colorId: 'yellow',
  };
  const shrunk = decideAnnotationTransaction({
    event: {
      ...annotationEventFor({
        id: 'legacy-0',
        rangeCfi: rangeCfis[0],
        colorId: 'yellow',
        eventId: 'legacy-delete',
      }),
      operation: 'annotation.delete',
      payload: null,
      baseRevision: 1,
    },
    storedHead: {
      schemaVersion: 1,
      bookId: 'book-1',
      annotationId: 'legacy-0',
      revision: 1,
      acceptedEventId: 'legacy-upsert',
      operation: 'upsert',
      annotation: legacyItem,
      acceptedDeviceId: 'legacy-device',
      acceptedSessionId: 'legacy-session',
      occurredAtClient: 1,
      updatedAtServer: 'server-legacy',
      deletedAtServer: null,
    },
    storedReceipt: undefined,
    storedAggregate: legacyAggregate,
    serverTime: 'server-shrink',
  });
  assert.equal(shrunk.status, 'apply');
  assert.ok(
    getAnnotationAggregateUtf8SizeV1(shrunk.aggregate)
      < getAnnotationAggregateUtf8SizeV1(legacyAggregate),
  );
});

test('applies and replays one atomic palette revision chain', () => {
  const first = decideAnnotationPaletteTransaction({
    event: paletteEvent('palette-1'),
    storedHead: undefined,
    storedReceipt: undefined,
    serverTime: 'server-1',
  });
  assert.equal(first.status, 'apply');
  assert.equal(first.head.revision, 1);

  const replay = decideAnnotationPaletteTransaction({
    event: paletteEvent('palette-1'),
    storedHead: first.head,
    storedReceipt: first.receipt,
    serverTime: 'server-2',
  });
  assert.equal(replay.status, 'already_applied');

  const stale = decideAnnotationPaletteTransaction({
    event: paletteEvent('palette-stale'),
    storedHead: first.head,
    storedReceipt: undefined,
    serverTime: 'server-2',
  });
  assert.equal(stale.status, 'conflict');
  assert.equal(stale.remoteHead.revision, 1);
});
