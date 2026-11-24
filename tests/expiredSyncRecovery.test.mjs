import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeLocalDB, initDB } from '../src/lib/localDB.ts';
import { LOCAL_DB_NAME, V5_OUTBOX_STORE } from '../src/lib/localDBSchema.ts';
import { makeFirebaseOwnerKey, makeOwnerKey } from '../src/lib/ownerIdentity.ts';
import { saveLocalAnnotationV8 } from '../src/lib/localAnnotations.ts';
import { reconcileAnnotationBookDeletionIntentsV10 } from '../src/lib/annotationBookDeletion.ts';
import { acquireSyncLeaseV5, claimNextProgressEventV5, enqueueProgressEventV5, resumePausedAuthEventsV5 } from '../src/lib/syncOutboxV5.ts';
import { quarantineExpiredProgressWork as quarantineProgress, hasExpiredProgressRecoveryPending,
  listExpiredProgressRecoveryBooks, recoverExpiredProgressFromServer as recoverProgress, quarantineExpiredSyncWork as quarantineWork,
  hasExpiredSyncRecoveryPending, listExpiredSyncRecoveryTargets, recoverExpiredSyncTargetFromServer as recoverTarget,
  preparePausedSyncRecovery, recoverPausedSyncTargetFromServer } from '../src/lib/expiredSyncRecovery.ts';

const fixtureServerNow = 1700000000000 + 181 * 864e5;
const quarantineExpiredProgressWork = (owner, book, now = fixtureServerNow) => quarantineProgress(owner, book, now);
const quarantineExpiredSyncWork = (owner, target, now = fixtureServerNow) => quarantineWork(owner, target, now);
const recoverExpiredProgressFromServer = (uid, owner, book, options = {}) => recoverProgress(uid, owner, book, { serverTrustedNow: fixtureServerNow, ...options });
const recoverExpiredSyncTargetFromServer = (uid, owner, target, options = {}) => recoverTarget(uid, owner, target, { serverTrustedNow: fixtureServerNow, ...options });

const owner = makeOwnerKey(makeFirebaseOwnerKey('test'), 'library:local');
const id = 'wl1_12345678-1234-4234-8234-123456789abc_1700000000000_12345678-1234-4234-8234-123456789def';
const position = { cfi: 'old', anchorCfi: null, progressPercent: 20 };
const event = (eventId = id, sequence = 1, status = 'in_flight') => ({
  ownerKey: owner, eventId, target: { kind: 'progress', bookId: 'book' }, targetKey: 'progress:book',
  operation: 'progress.set', payload: position, deviceId: 'device', sessionId: 'session', sequence,
  baseRevision: 0, occurredAtClient: 1, status, attempts: 1, nextAttemptAt: 10,
  lastErrorCode: null, claimedByTabId: 'tab', claimedLeaseEpoch: 1, claimToken: 'claim',
});
const old = { ownerKey: owner, bookId: 'book', cfi: 'old', progressPercent: 20, lastRead: 1,
  bookmarks: [{ id: 'manual', type: 'manual', cfi: 'saved', name: 'mark', color: 'red', createdAt: 1 }],
  ignoredRemoteRevision: 3 };
const head = { schemaVersion: 2, bookId: 'book', revision: 4, acceptedEventId: 'server', operation: 'set',
  position: { cfi: 'server', anchorCfi: null, progressPercent: 80 }, acceptedDeviceId: 'other',
  occurredAtClient: 5, updatedAtServer: {}, deletedAtServer: null };
async function reset() {
  await closeLocalDB();
  await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(LOCAL_DB_NAME); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
}
async function seed() {
  const db = await initDB();
  await db.put('progress-v5', old);
  await db.put(V5_OUTBOX_STORE, event());
  await db.put(V5_OUTBOX_STORE, event('unleased_old', 2, 'pending'));
  await db.put(V5_OUTBOX_STORE, event('superseded', 3, 'superseded'));
  await db.put('sync-conflicts-v5', { ownerKey: owner, conflictId: 'c', targetKey: 'progress:book', state: 'open', event: event(), remoteHead: null, latestLocalPosition: position, blockedEventIds: [id], createdAt: 1 });
  return db;
}
test.beforeEach(reset);
test.after(reset);

test('manual recovery replaces only the confirmed target after receiving its server head', async () => {
  const db = await seed();
  const paused = { ...event(id, 1, 'paused'), lastErrorCode: 'invalid-argument' };
  const other = { ...event('other', 1, 'pending'), target: { kind: 'progress', bookId: 'other' }, targetKey: 'progress:other' };
  await db.put(V5_OUTBOX_STORE, paused);
  await db.put(V5_OUTBOX_STORE, other);
  const [selection] = await preparePausedSyncRecovery(owner);
  assert.equal(selection.lastErrorCode, 'invalid-argument');
  await assert.rejects(recoverPausedSyncTargetFromServer('test', owner, selection, {
    fetchHead: async () => { throw new Error('unavailable'); },
  }), /unavailable/);
  assert.deepEqual(await db.get(V5_OUTBOX_STORE, [owner, id]), paused);
  assert.deepEqual(await db.get('progress-v5', [owner, 'book']), old);

  const result = await recoverPausedSyncTargetFromServer('test', owner, selection, { fetchHead: async () => head });
  assert.equal(result.status, 'resynced');
  assert.equal(result.progress.cfi, 'server');
  assert.deepEqual(result.progress.bookmarks, old.bookmarks);
  assert.deepEqual(await db.get(V5_OUTBOX_STORE, [owner, 'other']), other);
  for (const eventId of [id, 'unleased_old']) {
    assert.equal((await db.get(V5_OUTBOX_STORE, [owner, eventId])).status, 'superseded');
  }
  assert.deepEqual((await db.get(V5_OUTBOX_STORE, [owner, id])).payload, position);
  assert.equal((await db.get('sync-conflicts-v5', [owner, 'c'])).state, 'resolved_remote');
  assert.deepEqual(await preparePausedSyncRecovery(owner), []);
});

test('manual recovery keeps an edit that changed under the same event ID during the server read', async () => {
  const db = await seed();
  await db.put(V5_OUTBOX_STORE, event(id, 1, 'paused'));
  const [selection] = await preparePausedSyncRecovery(owner);
  const edit = { ...event('unleased_old', 2, 'pending'), payload: { ...position, cfi: 'new edit' } };
  const result = await recoverPausedSyncTargetFromServer('test', owner, selection, {
    fetchHead: async () => { await db.put(V5_OUTBOX_STORE, edit); return head; },
  });
  assert.deepEqual(result, { status: 'blocked' });
  assert.deepEqual(await db.get(V5_OUTBOX_STORE, [owner, 'unleased_old']), edit);
  assert.equal((await db.get(V5_OUTBOX_STORE, [owner, id])).status, 'paused');
  assert.deepEqual(await db.get('progress-v5', [owner, 'book']), old);
});

test('manual local retry keeps the original permission event and leaves schema failures paused', async () => {
  const db = await initDB();
  const permission = { ...event(id, 1, 'paused'), lastErrorCode: 'permission-denied' };
  const invalid = { ...event('invalid', 1, 'paused'), lastErrorCode: 'invalid-argument' };
  const other = { ...event('other', 1, 'paused'), lastErrorCode: 'permission-denied' };
  for (const row of [permission, invalid, other]) await db.put(V5_OUTBOX_STORE, row);
  assert.equal(await resumePausedAuthEventsV5(owner, 100, true, { eventId: 'invalid', isCurrent: () => true }), 0);
  assert.equal(await resumePausedAuthEventsV5(owner, 100, true, { eventId: id, isCurrent: () => false }), 0);
  assert.equal(await resumePausedAuthEventsV5(owner, 100, true, { eventId: id, isCurrent: () => true }), 1);
  assert.deepEqual(await db.get(V5_OUTBOX_STORE, [owner, id]), {
    ...permission, status: 'pending', nextAttemptAt: 100, lastErrorCode: null,
    claimedByTabId: null, claimedLeaseEpoch: null, claimToken: null,
  });
  assert.deepEqual(await db.get(V5_OUTBOX_STORE, [owner, 'invalid']), invalid);
  assert.deepEqual(await db.get(V5_OUTBOX_STORE, [owner, 'other']), other);
});

test('a paused row without a target does not hide the other recovery choices', async () => {
  const db = await initDB();
  await db.put(V5_OUTBOX_STORE, event(id, 1, 'paused'));
  await db.put(V5_OUTBOX_STORE, { ...event('invalid', 1, 'paused'), target: null, targetKey: 'invalid' });
  const targets = await preparePausedSyncRecovery(owner);
  assert.ok(targets.find(({ eventId }) => eventId === id).recovery);
  assert.equal(targets.find(({ eventId }) => eventId === 'invalid').recovery, null);
});

test('without trusted time leased and legacy events are never classified expired', async () => {
  const db = await initDB();
  await db.put(V5_OUTBOX_STORE, event(id, 1, 'pending'));
  await db.put(V5_OUTBOX_STORE, event('legacy-event', 2, 'pending'));
  assert.equal(await quarantineWork(owner, 'progress:book', null), 0);
  assert.equal((await db.get(V5_OUTBOX_STORE, [owner, id])).status, 'pending');
  assert.equal((await db.get(V5_OUTBOX_STORE, [owner, 'legacy-event'])).status, 'pending');
});

test('trusted expiry leaves a valid successor unchanged and lists conflict-only expiry', async () => {
  const db = await initDB();
  const trustedNow = 1700000000000 + 181 * 864e5;
  const freshId = `wl1_12345678-1234-4234-8234-123456789abc_${trustedNow}_12345678-1234-4234-8234-123456789dea`;
  await db.put(V5_OUTBOX_STORE, event(id, 1, 'conflict'));
  await db.put(V5_OUTBOX_STORE, { ...event(freshId, 2, 'blocked'), payload: { ...position, cfi: 'fresh' } });
  const targets = await listExpiredSyncRecoveryTargets(owner, trustedNow);
  assert.ok(targets.some(target => target.kind === 'progress' && target.bookId === 'book'));
  assert.equal(await quarantineExpiredSyncWork(owner, 'progress:book', trustedNow), 1);
  const fresh = await db.get(V5_OUTBOX_STORE, [owner, freshId]);
  assert.equal(fresh.status, 'blocked');
  assert.equal(fresh.payload.cfi, 'fresh');
  const result = await recoverExpiredProgressFromServer('test', owner, 'book', { serverTrustedNow: trustedNow, fetchHead: async () => head });
  assert.deepEqual(result, { status: 'conflict' });
  assert.equal((await db.get(V5_OUTBOX_STORE, [owner, freshId])).status, 'conflict');
  const conflict = await db.get('sync-conflicts-v5', [owner, freshId]);
  assert.equal(conflict.remoteHead.acceptedEventId, 'server');
  assert.equal(conflict.latestLocalPosition.cfi, 'fresh');
});

test('old conflict without an outbox row and reloaded unissued work enter recovery only with trusted time', async () => {
  const db = await initDB();
  const serverTrustedNow = 1700000000000 + 181 * 864e5;
  const orphan = event(id, 1, 'conflict');
  await db.put('sync-conflicts-v5', { ownerKey: owner, conflictId: id, targetKey: orphan.targetKey, state: 'deferred',
    event: orphan, remoteHead: null, latestLocalPosition: orphan.payload, blockedEventIds: [], createdAt: 1 });
  const unknown = { ...event('unleased_reloaded', 1, 'pending'), target: { kind: 'progress', bookId: 'other' }, targetKey: 'progress:other', attempts: 0 };
  await db.put(V5_OUTBOX_STORE, unknown);
  assert.equal((await listExpiredSyncRecoveryTargets(owner, null)).length, 0);
  const targets = await listExpiredSyncRecoveryTargets(owner, serverTrustedNow);
  assert.deepEqual(targets.map(target => target.bookId).sort(), ['book', 'other']);
  const result = await recoverExpiredProgressFromServer('test', owner, 'book', { serverTrustedNow, fetchHead: async () => head });
  assert.equal(result.status, 'resynced');
  assert.deepEqual((await db.get(V5_OUTBOX_STORE, [owner, id])).payload, position);
  assert.equal((await db.get(V5_OUTBOX_STORE, [owner, id])).recoveryPending, false);
});

test('quarantines whole active chain and retains its payload and terminal events', async () => {
  const db = await seed();
  assert.equal(await quarantineExpiredProgressWork(owner, 'book', fixtureServerNow), 2);
  const saved = await db.get(V5_OUTBOX_STORE, [owner, id]);
  assert.equal(saved.status, 'expired');
  assert.equal(saved.recoveryPending, true);
  assert.equal(saved.claimToken, null);
  assert.equal(saved.eventId, id);
  assert.deepEqual(saved.payload, position);
  assert.equal((await db.get(V5_OUTBOX_STORE, [owner, 'superseded'])).status, 'superseded');
  assert.equal((await db.get('sync-conflicts-v5', [owner, 'c'])).resolvedAt, fixtureServerNow);
  assert.deepEqual(await db.get('progress-v5', [owner, 'book']), old);
  assert.equal(await hasExpiredProgressRecoveryPending(owner, 'book'), true);
  assert.deepEqual(await listExpiredProgressRecoveryBooks(owner), ['book']);
  const lease = await acquireSyncLeaseV5(owner, 'tab2', 100, 100);
  assert.equal(await claimNextProgressEventV5(owner, 'tab2', lease.epoch, 101, () => 'new'), null);
});

test('network failure retains old canonical data and recovery remains pending', async () => {
  const db = await seed();
  await assert.rejects(recoverExpiredProgressFromServer('test', owner, 'book', { fetchHead: async () => { throw new Error('offline'); } }), /offline/);
  assert.deepEqual(await db.get('progress-v5', [owner, 'book']), old);
  assert.equal(await hasExpiredProgressRecoveryPending(owner, 'book'), true);
});

test('adopts server head atomically without rebinding or resubmitting old events', async () => {
  const db = await seed();
  const result = await recoverExpiredProgressFromServer('test', owner, 'book', { fetchHead: async () => head });
  assert.equal(result.status, 'resynced');
  assert.equal(result.progress.cfi, 'server');
  assert.equal(result.progress.syncRevision, 4);
  assert.deepEqual(result.progress.bookmarks, old.bookmarks);
  assert.equal(result.progress.ignoredRemoteRevision, undefined);
  assert.equal((await db.get('remote-heads-v5', [owner, 'progress:book'])).head.acceptedEventId, 'server');
  const saved = await db.get(V5_OUTBOX_STORE, [owner, id]);
  assert.equal(saved.recoveryPending, false);
  assert.equal(saved.eventId, id);
  assert.deepEqual(saved.payload, position);
  assert.equal(await hasExpiredProgressRecoveryPending(owner, 'book'), false);
  assert.deepEqual(await listExpiredProgressRecoveryBooks(owner), []);
});

test('missing head clears position but preserves bookmarks', async () => {
  const db = await seed();
  const result = await recoverExpiredProgressFromServer('test', owner, 'book', { fetchHead: async () => null });
  assert.equal(result.status, 'resynced');
  assert.equal(result.progress.cfi, '');
  assert.equal(result.progress.syncRevision, 0);
  assert.deepEqual(result.progress.bookmarks, old.bookmarks);
  assert.equal((await db.get(V5_OUTBOX_STORE, [owner, id])).recoveryPending, false);
});

test('new active work during fetch blocks adoption', async () => {
  const db = await seed();
  const result = await recoverExpiredProgressFromServer('test', owner, 'book', { fetchHead: async () => {
    await db.put(V5_OUTBOX_STORE, event('new', 4, 'pending'));
    return head;
  } });
  assert.deepEqual(result, { status: 'blocked' });
  assert.deepEqual(await db.get('progress-v5', [owner, 'book']), old);
  assert.equal(await hasExpiredProgressRecoveryPending(owner, 'book'), true);
});

test('bookmark recovery replaces only the target bookmark and preserves the original event', async () => {
  const db = await seed();
  const target = { kind: 'bookmark', bookId: 'book', bookmarkId: 'manual' };
  const original = { ...event('bookmark-event'), target, targetKey: 'bookmark:book:manual', operation: 'bookmark.delete', payload: null };
  await db.put(V5_OUTBOX_STORE, original);
  const remote = { schemaVersion: 2, bookId: 'book', bookmarkId: 'manual', revision: 2,
    acceptedEventId: 'remote-bookmark', operation: 'upsert', bookmark: { bookmarkId: 'manual', cfi: 'new', name: 'new', color: 'red', progressPercent: null, createdAtClient: 2, updatedAtClient: 3 },
    acceptedDeviceId: 'device', occurredAtClient: 3, updatedAtServer: {}, deletedAtServer: null };
  const result = await recoverExpiredSyncTargetFromServer('test', owner, target, { fetchHead: async () => remote });
  assert.equal(result.status, 'resynced');
  assert.equal(result.progress.cfi, 'old');
  assert.equal(result.progress.bookmarks[0].cfi, 'new');
  const saved = await db.get(V5_OUTBOX_STORE, [owner, 'bookmark-event']);
  assert.equal(saved.recoveryPending, false);
  assert.equal(saved.payload, null);
  assert.equal(saved.eventId, original.eventId);
});

test('missing bookmark and palette heads are adopted without creating outbox events', async () => {
  const db = await seed();
  const bookmark = { kind: 'bookmark', bookId: 'book', bookmarkId: 'manual' };
  const palette = { kind: 'palette' };
  await db.put(V5_OUTBOX_STORE, { ...event('bookmark'), target: bookmark, targetKey: 'bookmark:book:manual' });
  await db.put(V5_OUTBOX_STORE, { ...event('palette'), target: palette, targetKey: 'annotation-palette' });
  assert.equal((await recoverExpiredSyncTargetFromServer('test', owner, bookmark, { fetchHead: async () => null })).status, 'resynced');
  assert.deepEqual((await db.get('progress-v5', [owner, 'book'])).bookmarks, []);
  assert.equal((await recoverExpiredSyncTargetFromServer('test', owner, palette, { fetchHead: async () => null })).status, 'resynced');
  assert.equal((await db.get('annotation-settings-v9', owner)).palette.length, 5);
  assert.equal((await db.getAll(V5_OUTBOX_STORE)).length, 5);
});

test('owner change during fetch prevents canonical adoption and keeps pending recovery', async () => {
  const db = await seed();
  let current = true;
  const result = await recoverExpiredSyncTargetFromServer('test', owner, { kind: 'progress', bookId: 'book' }, {
    isCurrent: () => current, fetchHead: async () => { current = false; return head; },
  });
  assert.deepEqual(result, { status: 'blocked' });
  assert.deepEqual(await db.get('progress-v5', [owner, 'book']), old);
  assert.equal(await hasExpiredProgressRecoveryPending(owner, 'book'), true);
});

test('palette recovery adopts a validated server palette', async () => {
  const db = await seed();
  const target = { kind: 'palette' };
  await db.put(V5_OUTBOX_STORE, { ...event('palette-server'), target, targetKey: 'annotation-palette', payload: { items: [] } });
  const { DEFAULT_ANNOTATION_PALETTE } = await import('../src/lib/annotationPalette.ts');
  const items = DEFAULT_ANNOTATION_PALETTE.map((item, index) => index ? item : { ...item, label: 'Server' });
  const remote = { schemaVersion: 1, revision: 3, acceptedEventId: 'server-palette', operation: 'set',
    palette: { items }, acceptedDeviceId: 'device', acceptedSessionId: 'session', occurredAtClient: 3, updatedAtServer: {} };
  assert.equal((await recoverExpiredSyncTargetFromServer('test', owner, target, { fetchHead: async () => remote })).status, 'resynced');
  assert.equal((await db.get('annotation-settings-v9', owner)).palette[0].label, 'Server');
  assert.equal((await db.get(V5_OUTBOX_STORE, [owner, 'palette-server'])).recoveryPending, false);
});

const annotationTarget = { kind: 'annotation', bookId: 'book', annotationId: 'note' };
const annotationKey = 'annotation:book:note';
const annotation = { id: 'note', bookId: 'book', type: 'highlight', sectionIndex: 0,
  rangeCfi: 'epubcfi(/6/4!/4/2,/1:0,/1:4)', quote: 'remote', prefix: '', suffix: '', colorId: 'yellow', note: '',
  progressPercent: 20, chapter: 'chapter', createdAtClient: 1, updatedAtClient: 2 };
const annotationHead = { schemaVersion: 1, bookId: 'book', annotationId: 'note', revision: 2,
  acceptedEventId: 'remote-note', operation: 'upsert', annotation, acceptedDeviceId: 'other',
  acceptedSessionId: 'other-session', occurredAtClient: 2, bookGeneration: 0, updatedAtServer: {}, deletedAtServer: null };
async function seedAnnotation() {
  const db = await seed();
  await db.put(V5_OUTBOX_STORE, { ...event('note-event'), target: annotationTarget, targetKey: annotationKey,
    operation: 'annotation.upsert', payload: { ...annotation, quote: 'local' } });
  await db.put('annotations-v8', { ...annotation, ownerKey: owner, quote: 'local', anchorState: 'active' });
  return db;
}

test('manual server recovery safeguards paused cleanup from an acknowledged book deletion', async () => {
  const db = await initDB();
  await db.put('annotation-book-deletions-v10', { ownerKey: owner, bookId: 'book', markerRevision: 3, createdAt: 1 });
  const cleanup = { ...event('cleanup', 1, 'paused'), target: annotationTarget, targetKey: annotationKey,
    operation: 'annotation.delete', payload: null, deleteBeforeBookGeneration: 3 };
  await db.put(V5_OUTBOX_STORE, cleanup);
  const [selection] = await preparePausedSyncRecovery(owner);
  assert.equal(selection.recovery, null);
  assert.deepEqual(await recoverPausedSyncTargetFromServer('test', owner, selection, {
    fetchAnnotationBook: async () => assert.fail('Cleanup recovery must stop before reading the server'),
  }), { status: 'blocked' });
  assert.deepEqual(await db.get(V5_OUTBOX_STORE, [owner, 'cleanup']), cleanup);
});

test('manual recovery of a new annotation ignores a completed deletion recovery intent', async () => {
  const db = await seedAnnotation();
  const paused = await db.get(V5_OUTBOX_STORE, [owner, 'note-event']);
  await db.put(V5_OUTBOX_STORE, { ...paused, status: 'paused' });
  const marker = { ...annotationHead, annotationId: 'book_delete_marker_v1', revision: 3,
    acceptedEventId: 'marker', operation: 'delete', annotation: null, bookGeneration: 3, deletedAtServer: {} };
  const head = { ...annotationHead, bookGeneration: 3 };
  const intent = { ownerKey: owner, bookId: 'book', markerRevision: 3, createdAt: 1, expired: true, recoveryPending: true };
  await db.put('annotation-book-deletions-v10', intent);
  assert.equal((await preparePausedSyncRecovery(owner))[0].recovery, null);
  await db.put('annotation-book-deletions-v10', { ...intent, recoveryPending: false });
  const [selection] = await preparePausedSyncRecovery(owner);
  const fetchAnnotationBook = async () => ({ heads: [head], marker, targetHead: head });
  await db.put('annotation-book-deletions-v10', intent);
  assert.deepEqual(await recoverPausedSyncTargetFromServer('test', owner, selection, { fetchAnnotationBook }), { status: 'blocked' });
  await db.put('annotation-book-deletions-v10', { ...intent, recoveryPending: false });
  assert.deepEqual(await recoverPausedSyncTargetFromServer('test', owner, selection, { fetchAnnotationBook }), { status: 'resynced' });
  assert.equal((await db.get('annotations-v8', [owner, 'book', 'note'])).quote, 'remote');
});
test('annotation recovery adopts authoritative head while preserving expired payload', async () => {
  const db = await seedAnnotation();
  const result = await recoverExpiredSyncTargetFromServer('test', owner, annotationTarget, {
    fetchAnnotationBook: async () => ({ heads: [annotationHead], marker: null, targetHead: annotationHead }),
  });
  assert.equal(result.status, 'resynced');
  assert.equal((await db.get('annotations-v8', [owner, 'book', 'note'])).quote, 'remote');
  const saved = await db.get(V5_OUTBOX_STORE, [owner, 'note-event']);
  assert.equal(saved.payload.quote, 'local');
  assert.equal(saved.recoveryPending, false);
  assert.equal(saved.eventId, 'note-event');
  assert.equal((await db.getAll(V5_OUTBOX_STORE)).length, 4);
});

test('missing annotation removes only the recovered local annotation', async () => {
  const db = await seedAnnotation();
  const result = await recoverExpiredSyncTargetFromServer('test', owner, annotationTarget, {
    fetchAnnotationBook: async () => ({ heads: [], marker: null, targetHead: null }),
  });
  assert.equal(result.status, 'resynced');
  assert.equal(await db.get('annotations-v8', [owner, 'book', 'note']), undefined);
  assert.equal((await db.get(V5_OUTBOX_STORE, [owner, 'note-event'])).payload.quote, 'local');
});

test('deletion marker prevents adopting an older annotation generation', async () => {
  const db = await seedAnnotation();
  const marker = { ...annotationHead, annotationId: 'book_delete_marker_v1', revision: 3,
    acceptedEventId: 'marker', operation: 'delete', annotation: null, bookGeneration: 3, deletedAtServer: {} };
  const result = await recoverExpiredSyncTargetFromServer('test', owner, annotationTarget, {
    fetchAnnotationBook: async () => ({ heads: [annotationHead], marker, targetHead: annotationHead }),
  });
  assert.equal(result.status, 'resynced');
  assert.equal(await db.get('annotations-v8', [owner, 'book', 'note']), undefined);
  assert.equal((await db.get('remote-heads-v5', [owner, 'annotation:book:book_delete_marker_v1'])).revision, 3);
});

test('annotation recovery blocks new work', async () => {
  const db = await seedAnnotation();
  const result = await recoverExpiredSyncTargetFromServer('test', owner, annotationTarget, {
    fetchAnnotationBook: async () => {
      await db.put(V5_OUTBOX_STORE, { ...event('new-note', 2, 'pending'), target: annotationTarget, targetKey: annotationKey });
      return { heads: [annotationHead], marker: null };
    },
  });
  assert.equal(result.status, 'blocked');
  assert.equal((await db.get('annotations-v8', [owner, 'book', 'note'])).quote, 'local');
  assert.equal(await hasExpiredSyncRecoveryPending(owner, annotationKey), true);
});

const markerTarget = { kind: 'annotation', bookId: 'book', annotationId: 'book_delete_marker_v1' };
const intentStore = 'annotation-book-deletions-v10';
const marker = { ...annotationHead, annotationId: markerTarget.annotationId, revision: 1,
  acceptedEventId: 'remote-marker', operation: 'delete', annotation: null, bookGeneration: 1, deletedAtServer: {} };
async function seedBookDeletion() {
  const db = await seedAnnotation();
  await db.put(intentStore, { ownerKey: owner, bookId: 'book', createdAt: 1, lastCheckedAt: null, expired: true });
  await db.put('annotations-v8', { ...annotation, id: 'other-book', bookId: 'other', ownerKey: owner });
  return db;
}

test('legacy and reloaded deletion intents hydrate canonical annotations and unblock new local work', async () => {
  const previousFlag = process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
  process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = '1';
  try {
    const db = await initDB();
    for (const [index, fields] of [{}, { markerEventId: 'unleased_restored', writeLeaseEventId: 'unleased_restored', writeLeaseDeviceId: 'device' }].entries()) {
      const bookId = `restored-${index}`;
      const intent = { ownerKey: owner, bookId, createdAt: fixtureServerNow - 1000, lastCheckedAt: null, ...fields };
      await db.put(intentStore, intent);
      const target = { ...markerTarget, bookId };
      const local = { ...annotation, bookId, id: 'canonical' };
      const remote = { ...annotationHead, bookId, annotationId: local.id, annotation: local };
      let calls = 0;
      // Reconcile has already consumed its interval before trusted time is known.
      await reconcileAnnotationBookDeletionIntentsV10('test', owner, { deviceId: 'device', sessionId: 'session' },
        fixtureServerNow, async () => { calls++; return []; });
      assert.equal(calls, 0);
      assert.equal((await listExpiredSyncRecoveryTargets(owner, null)).some(item => item.bookId === bookId), false);
      assert.ok((await listExpiredSyncRecoveryTargets(owner, fixtureServerNow)).some(item => item.bookId === bookId));
      assert.deepEqual(await db.get(intentStore, [owner, bookId]), intent);
      const result = await recoverTarget('test', owner, target, { serverTrustedNow: fixtureServerNow,
        fetchAnnotationBook: async () => { calls++; return { heads: [remote], marker: null, targetHead: null }; } });
      assert.deepEqual(result, { status: 'resynced' });
      assert.equal(calls, 1);
      assert.equal((await db.getAll(V5_OUTBOX_STORE)).length, index);
      assert.equal((await db.get('annotations-v8', [owner, bookId, local.id])).quote, 'remote');
      const recovered = await db.get(intentStore, [owner, bookId]);
      assert.equal(recovered.expired, true);
      assert.equal(recovered.recoveryPending, false);
      assert.equal(recovered.writeLeaseEventId, fields.writeLeaseEventId);
      assert.equal((await listExpiredSyncRecoveryTargets(owner, fixtureServerNow)).some(item => item.bookId === bookId), false);
      const saved = await saveLocalAnnotationV8(owner, { ...local, id: 'new-local', quote: 'new local',
        rangeCfi: 'epubcfi(/6/4!/4/2,/1:8,/1:12)', anchorState: 'active' },
        { deviceId: 'device', sessionId: 'session', createEventId: () =>
          `wl1_12345678-1234-4234-8234-123456789abc_${fixtureServerNow}_${crypto.randomUUID()}` });
      assert.equal(saved.status, 'saved');
      assert.deepEqual(await db.get(intentStore, [owner, bookId]), recovered);
      assert.equal((await db.getAll(V5_OUTBOX_STORE)).filter(item => item.forceDelete).length, 0);
    }
  } finally {
    if (previousFlag === undefined) delete process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
    else process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = previousFlag;
  }
});

test('live pending deletion waits and preserves its marker and intent after the writer closes', async () => {
  const previousFlag = process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
  process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = '1';
  const writerId = crypto.randomUUID();
  const lockName = `web-reader:unleased-sync-writer:${writerId}`;
  let writerLive = true;
  const previousLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true,
    value: { query: async () => ({ held: writerLive ? [{ name: lockName }] : [] }) } });
  try {
    const db = await initDB();
    const markerEventId = `unleased_v1_${writerId}_${crypto.randomUUID()}`;
    const intent = { ownerKey: owner, bookId: 'live-pending', createdAt: fixtureServerNow, lastCheckedAt: null,
      markerEventId, writeLeaseEventId: markerEventId, writeLeaseDeviceId: 'device' };
    const target = { ...markerTarget, bookId: intent.bookId };
    const markerEvent = { ...event(markerEventId, 1, 'pending'), target, targetKey: 'annotation:live-pending:book_delete_marker_v1',
      operation: 'annotation.delete', payload: null, attempts: 0, claimedByTabId: null, claimedLeaseEpoch: null, claimToken: null };
    await db.put(intentStore, intent);
    await db.put(V5_OUTBOX_STORE, markerEvent);
    assert.deepEqual(await listExpiredSyncRecoveryTargets(owner, fixtureServerNow), []);
    let calls = 0;
    assert.deepEqual(await recoverTarget('test', owner, target, {
      serverTrustedNow: fixtureServerNow, fetchAnnotationBook: async () => { calls++; return { heads: [], marker: null }; },
    }), { status: 'blocked' });
    assert.equal(calls, 0);
    assert.deepEqual(await db.get(intentStore, [owner, intent.bookId]), intent);
    assert.deepEqual(await db.get(V5_OUTBOX_STORE, [owner, markerEventId]), markerEvent);

    writerLive = false;
    assert.deepEqual(await listExpiredSyncRecoveryTargets(owner, fixtureServerNow), [target]);
    assert.deepEqual(await recoverTarget('test', owner, target, {
      serverTrustedNow: fixtureServerNow,
      fetchAnnotationBook: async () => { calls++; return { heads: [], marker: null }; },
    }), { status: 'resynced' });
    assert.equal(calls, 1);
    assert.deepEqual(await db.get(intentStore, [owner, intent.bookId]), {
      ...intent, expired: true, recoveryPending: false,
    });
    assert.deepEqual(await db.getAll(V5_OUTBOX_STORE), [{
      ...markerEvent, status: 'expired', recoveryPending: false, lastErrorCode: 'sync/write-lease-expired', nextAttemptAt: null,
    }]);
  } finally {
    if (previousLocks) Object.defineProperty(navigator, 'locks', previousLocks);
    else delete navigator.locks;
    if (previousFlag === undefined) delete process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
    else process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = previousFlag;
  }
});

test('restored deletion recovery respects cancellation and owner changes during canonical fetch', async () => {
  const db = await initDB();
  for (const action of ['cancel', 'owner-change']) {
    const bookId = `guard-${action}`;
    await db.put(intentStore, { ownerKey: owner, bookId, createdAt: fixtureServerNow, lastCheckedAt: null });
    let current = true;
    const result = await recoverTarget('test', owner, { ...markerTarget, bookId }, {
      serverTrustedNow: fixtureServerNow, isCurrent: () => current,
      fetchAnnotationBook: async () => {
        if (action === 'cancel') await db.delete(intentStore, [owner, bookId]);
        else current = false;
        return { heads: [{ ...annotationHead, bookId, annotation: { ...annotation, bookId } }], marker: null, targetHead: null };
      },
    });
    assert.deepEqual(result, { status: 'blocked' });
    assert.equal(await db.get('annotations-v8', [owner, bookId, annotation.id]), undefined);
  }
  assert.equal((await db.getAll(V5_OUTBOX_STORE)).length, 0);
});
test('expired book intent restores the authoritative book without new events', async () => {
  const db = await seedBookDeletion();
  const remote = { ...annotationHead, bookGeneration: 1 };
  assert.ok((await listExpiredSyncRecoveryTargets(owner)).some((item) => item.annotationId === markerTarget.annotationId));
  const result = await recoverExpiredSyncTargetFromServer('test', owner, markerTarget, {
    fetchAnnotationBook: async () => ({ heads: [remote], marker, targetHead: marker }),
  });
  assert.equal(result.status, 'resynced');
  assert.equal((await db.get('annotations-v8', [owner, 'book', 'note'])).quote, 'remote');
  assert.ok(await db.get('annotations-v8', [owner, 'other', 'other-book']));
  assert.equal((await db.get('remote-heads-v5', [owner, 'annotation:book:book_delete_marker_v1'])).revision, 1);
  const saved = await db.get(V5_OUTBOX_STORE, [owner, 'note-event']);
  assert.equal(saved.payload.quote, 'local');
  assert.equal(saved.status, 'expired');
  assert.equal(saved.recoveryPending, false);
  assert.equal((await db.get(intentStore, [owner, 'book'])).recoveryPending, false);
  assert.equal((await db.getAll(V5_OUTBOX_STORE)).length, 4);
  assert.equal((await listExpiredSyncRecoveryTargets(owner)).some((item) => item.annotationId === markerTarget.annotationId), false);
});

test('book recovery keeps a fresh annotation successor as a conflict against the fetched head', async () => {
  const db = await seedBookDeletion();
  const serverTrustedNow = 1700000000000 + 181 * 864e5;
  const nextId = `wl1_12345678-1234-4234-8234-123456789abc_${serverTrustedNow}_${crypto.randomUUID()}`;
  const local = { ...annotation, quote: 'fresh' };
  await db.put(V5_OUTBOX_STORE, { ...event(nextId, 2, 'pending'), target: annotationTarget,
    targetKey: annotationKey, operation: 'annotation.upsert', payload: local, attempts: 0 });
  await db.put('annotations-v8', { ...local, ownerKey: owner, anchorState: 'active' });
  const remote = { ...annotationHead, bookGeneration: 1 };
  const result = await recoverExpiredSyncTargetFromServer('test', owner, markerTarget, {
    serverTrustedNow, fetchAnnotationBook: async () => ({ heads: [remote], marker, targetHead: marker }),
  });
  assert.equal(result.status, 'conflict');
  assert.equal((await db.get('annotations-v8', [owner, 'book', 'note'])).quote, 'fresh');
  const conflict = await db.get('sync-conflicts-v5', [owner, nextId]);
  assert.equal(conflict.remoteHead.acceptedEventId, 'remote-note');
  assert.equal(conflict.remoteBookGeneration, 1);
  assert.equal(conflict.latestLocalPosition.quote, 'fresh');
  assert.equal((await db.get(intentStore, [owner, 'book'])).recoveryPending, false);
});

test('book recovery preserves pending intent on failure, concurrent changes and owner change', async () => {
  const db = await seedBookDeletion();
  await assert.rejects(recoverExpiredSyncTargetFromServer('test', owner, markerTarget, { fetchAnnotationBook: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal((await db.get(intentStore, [owner, 'book'])).recoveryPending, true);
  let current = true;
  assert.equal((await recoverExpiredSyncTargetFromServer('test', owner, markerTarget, {
    isCurrent: () => current, fetchAnnotationBook: async () => { current = false; return { heads: [], marker: null }; },
  })).status, 'blocked');
  assert.equal((await recoverExpiredSyncTargetFromServer('test', owner, markerTarget, {
    fetchAnnotationBook: async () => { await db.put(V5_OUTBOX_STORE, { ...event('concurrent', 3, 'pending'), target: annotationTarget, targetKey: annotationKey }); return { heads: [], marker: null }; },
  })).status, 'blocked');
  assert.equal((await db.get('annotations-v8', [owner, 'book', 'note'])).quote, 'local');
  assert.equal((await db.get(intentStore, [owner, 'book'])).recoveryPending, true);
});

test('book recovery refuses newer cached remote head appearing during fetch', async () => {
  const db = await seedBookDeletion();
  const result = await recoverExpiredSyncTargetFromServer('test', owner, markerTarget, {
    fetchAnnotationBook: async () => {
      await db.put('remote-heads-v5', { ownerKey: owner, targetKey: annotationKey, revision: 3, head: { ...annotationHead, revision: 3 }, updatedAt: 1 });
      return { heads: [annotationHead], marker: null };
    },
  });
  assert.equal(result.status, 'blocked');
  assert.equal((await db.get(intentStore, [owner, 'book'])).recoveryPending, true);
});

test('annotation fetch failure and owner change leave recovery pending', async () => {
  const db = await seedAnnotation();
  await assert.rejects(recoverExpiredSyncTargetFromServer('test', owner, annotationTarget, {
    fetchAnnotationBook: async () => { throw new Error('offline'); },
  }), /offline/);
  let current = true;
  assert.equal((await recoverExpiredSyncTargetFromServer('test', owner, annotationTarget, {
    isCurrent: () => current, fetchAnnotationBook: async () => { current = false; return { heads: [annotationHead], marker: null }; },
  })).status, 'blocked');
  assert.equal((await db.get('annotations-v8', [owner, 'book', 'note'])).quote, 'local');
  assert.equal(await hasExpiredSyncRecoveryPending(owner, annotationKey), true);
});

test('inconsistent aggregate and target reads fail without adopting', async () => {
  const db = await seedAnnotation();
  await assert.rejects(recoverExpiredSyncTargetFromServer('test', owner, annotationTarget, {
    fetchAnnotationBook: async () => ({ heads: [annotationHead], marker: null, targetHead: null }),
  }), /disagrees/);
  assert.equal((await db.get('annotations-v8', [owner, 'book', 'note'])).quote, 'local');
  assert.equal(await hasExpiredSyncRecoveryPending(owner, annotationKey), true);
});

test('lists distinct pending event targets for recovery', async () => {
  const db = await seed();
  await db.put(V5_OUTBOX_STORE, { ...event('annotation-1'), target: annotationTarget, targetKey: annotationKey });
  await db.put(V5_OUTBOX_STORE, { ...event('annotation-2', 2), target: annotationTarget, targetKey: annotationKey });
  await quarantineExpiredSyncWork(owner, annotationKey, fixtureServerNow);
  await quarantineExpiredSyncWork(owner, 'progress:book', fixtureServerNow);
  const targets = await listExpiredSyncRecoveryTargets(owner);
  assert.equal(targets.length, 2);
  assert.ok(targets.some((target) => target.kind === 'annotation' && target.bookId === 'book' && target.annotationId === 'note'));
  assert.ok(targets.some((target) => target.kind === 'progress' && target.bookId === 'book'));
});

test('missing progress head with cached remote remains blocked and preserves local data', async () => {
  const db = await seed();
  await db.put('remote-heads-v5', { ownerKey: owner, targetKey: 'progress:book', revision: head.revision, head, updatedAt: 1 });
  const result = await recoverExpiredProgressFromServer('test', owner, 'book', { fetchHead: async () => null });
  assert.deepEqual(result, { status: 'blocked' });
  assert.deepEqual(await db.get('progress-v5', [owner, 'book']), old);
  assert.equal((await db.get('remote-heads-v5', [owner, 'progress:book'])).revision, head.revision);
  assert.equal(await hasExpiredProgressRecoveryPending(owner, 'book'), true);
});

test('finite lease guard rejects a new progress write until recovery completes', async () => {
  const db = await seed();
  await quarantineExpiredProgressWork(owner, 'book', fixtureServerNow);
  const before = await db.getAll(V5_OUTBOX_STORE);
  const previousFlag = process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
  process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = '1';
  try {
    await assert.rejects(enqueueProgressEventV5(owner, {
      bookId: 'book', operation: 'progress.set', position: { cfi: 'new', anchorCfi: null, progressPercent: 40 },
      deviceId: 'device', sessionId: 'new-session', eventId: 'new-event', occurredAtClient: 150,
    }), (error) => error.code === 'sync/resync-required');
    assert.deepEqual(await db.getAll(V5_OUTBOX_STORE), before);
    assert.deepEqual(await db.get('progress-v5', [owner, 'book']), old);
    assert.equal(await hasExpiredProgressRecoveryPending(owner, 'book'), true);
  } finally {
    if (previousFlag === undefined) delete process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
    else process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = previousFlag;
  }
});

test('canonical recovery exposes each valid successor as an explicit conflict, including arrivals during fetch', async () => {
  const db = await initDB();
  const serverTrustedNow = 1700000000000 + 181 * 864e5;
  const freshId = () => `wl1_12345678-1234-4234-8234-123456789abc_${serverTrustedNow}_${crypto.randomUUID()}`;
  const bookmark = { kind: 'bookmark', bookId: 'book', bookmarkId: 'manual' };
  const palette = { kind: 'palette' };
  const { DEFAULT_ANNOTATION_PALETTE } = await import('../src/lib/annotationPalette.ts');
  const palettePayload = { items: DEFAULT_ANNOTATION_PALETTE };
  const cases = [
    { target: { kind: 'progress', bookId: 'book' }, key: 'progress:book', operation: 'progress.set', payload: position, remote: head },
    { target: bookmark, key: 'bookmark:book:manual', operation: 'bookmark.delete', payload: null,
      remote: { schemaVersion: 2, bookId: 'book', bookmarkId: 'manual', revision: 2, acceptedEventId: 'remote-bookmark', operation: 'delete', bookmark: null, acceptedDeviceId: 'device', occurredAtClient: 3, updatedAtServer: {}, deletedAtServer: {} } },
    { target: annotationTarget, key: annotationKey, operation: 'annotation.upsert', payload: annotation, remote: annotationHead },
    { target: palette, key: 'annotation-palette', operation: 'palette.set', payload: palettePayload,
      remote: { schemaVersion: 1, revision: 3, acceptedEventId: 'server-palette', operation: 'set', palette: palettePayload, acceptedDeviceId: 'device', acceptedSessionId: 'session', occurredAtClient: 3, updatedAtServer: {} } },
  ];
  for (const [index, item] of cases.entries()) {
    const oldId = `wl1_12345678-1234-4234-8234-123456789abc_1700000000000_${crypto.randomUUID()}`;
    const nextId = freshId();
    const make = (eventId, sequence) => ({ ...event(eventId, sequence, 'pending'), target: item.target, targetKey: item.key,
      operation: item.operation, payload: item.payload, attempts: 0, claimedByTabId: null, claimedLeaseEpoch: null, claimToken: null });
    await db.put(V5_OUTBOX_STORE, make(oldId, 1));
    if (index % 2 === 0) await db.put(V5_OUTBOX_STORE, make(nextId, 2));
    const addDuringFetch = async () => { if (index % 2) await db.put(V5_OUTBOX_STORE, make(nextId, 2)); };
    const result = await recoverExpiredSyncTargetFromServer('test', owner, item.target, {
      serverTrustedNow,
      fetchHead: async () => { await addDuringFetch(); return item.remote; },
      fetchAnnotationBook: async () => { await addDuringFetch(); return { heads: [annotationHead], marker: null, targetHead: annotationHead }; },
    });
    assert.deepEqual(result, { status: 'conflict' }, item.target.kind);
    const saved = await db.get(V5_OUTBOX_STORE, [owner, nextId]);
    const conflict = await db.get('sync-conflicts-v5', [owner, nextId]);
    assert.equal(saved.status, 'conflict', item.target.kind);
    assert.deepEqual(saved.payload, item.payload);
    assert.equal(conflict.remoteHead.acceptedEventId, item.remote.acceptedEventId);
    assert.deepEqual(conflict.latestLocalPosition, item.payload);
    assert.equal((await db.get(V5_OUTBOX_STORE, [owner, oldId])).recoveryPending, false);
  }
});

test('fresh progress and bookmark successors conflict with a verified missing server head', async () => {
  const db = await initDB();
  for (const target of [{ kind: 'progress', bookId: 'book' }, { kind: 'bookmark', bookId: 'book', bookmarkId: 'manual' }]) {
    const key = target.kind === 'progress' ? 'progress:book' : 'bookmark:book:manual';
    const nextId = `wl1_12345678-1234-4234-8234-123456789abc_${fixtureServerNow}_${crypto.randomUUID()}`;
    const original = { ...event(id, 1, 'pending'), target, targetKey: key };
    const fresh = { ...event(nextId, 2, 'pending'), target, targetKey: key,
      operation: target.kind === 'progress' ? 'progress.set' : 'bookmark.delete', payload: target.kind === 'progress' ? position : null };
    await db.put(V5_OUTBOX_STORE, original);
    await db.put(V5_OUTBOX_STORE, fresh);
    const result = await recoverExpiredSyncTargetFromServer('test', owner, target, { fetchHead: async () => null });
    assert.deepEqual(result, { status: 'conflict' });
    const conflict = await db.get('sync-conflicts-v5', [owner, nextId]);
    assert.equal(conflict.remoteHead, null);
    assert.equal(conflict.event.eventId, nextId);
    assert.deepEqual(conflict.latestLocalPosition, fresh.payload);
    assert.equal((await db.get('sync-meta-v5', [owner, key])).knownRevision, 0);
    assert.equal((await db.get(V5_OUTBOX_STORE, [owner, nextId])).status, 'conflict');
    await db.delete(V5_OUTBOX_STORE, [owner, id]);
  }
});
