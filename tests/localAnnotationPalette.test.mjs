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
