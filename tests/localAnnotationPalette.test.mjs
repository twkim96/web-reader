import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const { DEFAULT_ANNOTATION_PALETTE } = await import('../src/lib/annotationPalette.ts');
const {
  initializeLocalAnnotationPaletteV9,
  saveLocalAnnotationPaletteV9,
} = await import('../src/lib/localAnnotationPalette.ts');
const { getOutboxEventsV5 } = await import('../src/lib/syncOutboxV5.ts');
const { makeFirebaseOwnerKey, makeOwnerKey } = await import('../src/lib/ownerIdentity.ts');

const ownerKey = makeOwnerKey(makeFirebaseOwnerKey('palette-atomic'), 'library:local');
const defaults = DEFAULT_ANNOTATION_PALETTE.map((item) => ({ ...item }));

const resetDatabase = async () => {
  await closeLocalDB();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
};

test.beforeEach(resetDatabase);
test.after(resetDatabase);

test('commits the canonical palette and outbox intent in one transaction', async () => {
  await initializeLocalAnnotationPaletteV9(ownerKey, defaults);
  const changed = defaults.map((item) => item.id === 'yellow'
    ? { ...item, meaning: '원자 저장' }
    : item);
  await saveLocalAnnotationPaletteV9(ownerKey, changed, {
    deviceId: 'device-1',
    sessionId: 'session-1',
    createEventId: () => 'palette-event-1',
  });
  assert.equal((await initializeLocalAnnotationPaletteV9(ownerKey, defaults))[0].meaning, '원자 저장');
  const events = await getOutboxEventsV5(ownerKey);
  assert.equal(events.length, 1);
  assert.equal(events[0].target.kind, 'palette');
  assert.equal(events[0].payload.items[0].meaning, '원자 저장');
});

test('rolls back the canonical palette when its outbox event cannot be added', async () => {
  await initializeLocalAnnotationPaletteV9(ownerKey, defaults);
  await saveLocalAnnotationPaletteV9(ownerKey, defaults, {
    deviceId: 'device-1',
    sessionId: 'session-1',
    createEventId: () => 'duplicate-event',
  });
  const changed = defaults.map((item) => item.id === 'yellow'
    ? { ...item, meaning: '커밋되면 안 됨' }
    : item);
  await assert.rejects(saveLocalAnnotationPaletteV9(ownerKey, changed, {
    deviceId: 'device-2',
    sessionId: 'session-2',
    createEventId: () => 'duplicate-event',
  }));
  assert.equal((await initializeLocalAnnotationPaletteV9(ownerKey, defaults))[0].meaning, '중요');
  assert.equal((await getOutboxEventsV5(ownerKey)).length, 1);
});

const { adoptRemoteAnnotationPaletteV9, getLocalAnnotationPaletteV9 } = await import('../src/lib/localAnnotationPalette.ts');
const { storeRemoteHeadsBatchV5, hasActiveSyncTargetWorkV5 } = await import('../src/lib/syncOutboxV5.ts');
const { annotationPaletteTargetKeyV1 } = await import('../src/lib/annotationSyncSchema.ts');
const remoteHead = (revision = 1) => ({
  schemaVersion: 1, revision, acceptedEventId: `remote-${revision}`, operation: 'set',
  palette: { items: defaults.map((item) => ({ ...item, meaning: `remote-${revision}` })) },
  acceptedDeviceId: 'remote-device', acceptedSessionId: 'remote-session',
  occurredAtClient: revision, updatedAtServer: {},
});

test('remote adoption rechecks a cross-tab local edit after an earlier no-work check', async () => {
  const head = remoteHead();
  await initializeLocalAnnotationPaletteV9(ownerKey, defaults);
  await storeRemoteHeadsBatchV5(ownerKey, [head]);
  assert.equal(await hasActiveSyncTargetWorkV5(ownerKey, annotationPaletteTargetKeyV1()), false);
  // Another tab commits between the listener's old preflight and its write.
  const changed = defaults.map((item) => ({ ...item, meaning: 'other-tab-local' }));
  await saveLocalAnnotationPaletteV9(ownerKey, changed, {
    deviceId: 'other-tab', sessionId: 'other-session', createEventId: () => 'other-tab-edit',
  });
  const result = await adoptRemoteAnnotationPaletteV9(ownerKey, head);
  assert.equal(result.status, 'blocked-by-local-work');
  assert.deepEqual(await getLocalAnnotationPaletteV9(ownerKey, defaults), changed);
  assert.deepEqual((await getOutboxEventsV5(ownerKey))[0].payload.items, changed);
});

for (const state of ['open', 'deferred']) {
  test(`remote adoption preserves a ${state} palette conflict with no pending event`, async () => {
    const head = remoteHead();
    await initializeLocalAnnotationPaletteV9(ownerKey, defaults);
    await storeRemoteHeadsBatchV5(ownerKey, [head]);
    const { initDB } = await import('../src/lib/localDB.ts');
    const db = await initDB();
    await db.put('sync-conflicts-v5', {
      ownerKey, conflictId: 'palette-conflict', targetKey: annotationPaletteTargetKeyV1(), state,
      event: null, remoteHead: head, latestLocalPosition: { items: defaults }, blockedEventIds: [], createdAt: 1,
    });
    assert.equal((await adoptRemoteAnnotationPaletteV9(ownerKey, head)).status, 'blocked-by-local-work');
    assert.deepEqual(await getLocalAnnotationPaletteV9(ownerKey, defaults), defaults);
  });
}

test('only the latest cached palette revision can be adopted, including duplicate snapshots', async () => {
  const first = remoteHead(1);
  const second = remoteHead(2);
  await initializeLocalAnnotationPaletteV9(ownerKey, defaults);
  await storeRemoteHeadsBatchV5(ownerKey, [first]);
  await storeRemoteHeadsBatchV5(ownerKey, [second]);
  assert.equal((await adoptRemoteAnnotationPaletteV9(ownerKey, first)).status, 'stale-remote');
  assert.equal((await adoptRemoteAnnotationPaletteV9(ownerKey, second)).status, 'applied');
  assert.equal((await adoptRemoteAnnotationPaletteV9(ownerKey, second)).status, 'applied');
  assert.equal((await adoptRemoteAnnotationPaletteV9(ownerKey, { ...second, acceptedEventId: 'wrong-event' })).status, 'stale-remote');
  assert.deepEqual(await getLocalAnnotationPaletteV9(ownerKey, defaults), second.palette.items);
  assert.equal((await getOutboxEventsV5(ownerKey)).length, 0);
});

test('a changed local UI or owner cancels palette adoption before the canonical write', async () => {
  const head = remoteHead();
  await initializeLocalAnnotationPaletteV9(ownerKey, defaults);
  await storeRemoteHeadsBatchV5(ownerKey, [head]);
  let checks = 0;
  assert.equal((await adoptRemoteAnnotationPaletteV9(ownerKey, head, () => ++checks === 1)).status, 'cancelled');
  assert.equal(checks, 2);
  assert.deepEqual(await getLocalAnnotationPaletteV9(ownerKey, defaults), defaults);
});

test('adopting a head received before an older ACK advances the next palette event base revision', async () => {
  const { initDB } = await import('../src/lib/localDB.ts');
  const db = await initDB();
  const head = remoteHead(2);
  await storeRemoteHeadsBatchV5(ownerKey, [head]);
  // A snapshot observed while local work was active did not advance its base.
  await db.put('sync-meta-v5', {
    ownerKey, targetKey: annotationPaletteTargetKeyV1(), knownRevision: 1, nextSequence: 2, updatedAt: 1,
  });
  assert.equal((await adoptRemoteAnnotationPaletteV9(ownerKey, head)).status, 'applied');
  await saveLocalAnnotationPaletteV9(ownerKey, defaults, {
    deviceId: 'device-1', sessionId: 'session-1', createEventId: () => 'after-adoption',
  });
  const [event] = await getOutboxEventsV5(ownerKey);
  assert.equal(event.baseRevision, 2);
  assert.equal(event.sequence, 2);
});
