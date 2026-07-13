import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const {
  getAllLocalProgressV5,
  saveProgressToLocalV5,
} = await import('../src/lib/localDBV5.ts');
const {
  makeDriveScopeKey,
  makeFirebaseOwnerKey,
  makeOwnerKey,
  getSyncOwnerKey,
} = await import('../src/lib/ownerIdentity.ts');
const {
  migrateDriveProgressToFirebaseScopeV170,
} = await import('../src/lib/firebaseSyncScopeMigrationV170.ts');
const { getOutboxEventsV5 } = await import('../src/lib/syncOutboxV5.ts');

const sourceOwner = makeOwnerKey(
  makeFirebaseOwnerKey('alice'),
  makeDriveScopeKey('permission-a'),
);
const targetOwner = getSyncOwnerKey(sourceOwner);
const bookmark = {
  id: 'mark-1',
  type: 'manual',
  name: '표시',
  cfi: 'epubcfi(/6/2)',
  progressPercent: 25,
  createdAt: 90,
  color: '#fff',
};

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

test('copies Drive-scoped progress into the Firebase sync owner once and preserves the source', async () => {
  await saveProgressToLocalV5(sourceOwner, {
    bookId: 'book-1',
    cfi: 'epubcfi(/6/2)',
    anchorCfi: 'epubcfi(/6/2)',
    progressPercent: 25,
    lastRead: 100,
    bookmarks: [bookmark],
  });

  const first = await migrateDriveProgressToFirebaseScopeV170({
    sourceOwnerKey: sourceOwner,
    deviceId: 'device-1',
  });
  assert.deepEqual(first, { migrated: 1, skipped: false });
  assert.equal((await getAllLocalProgressV5(sourceOwner)).length, 1);
  assert.equal((await getAllLocalProgressV5(targetOwner))[0].progressPercent, 25);
  const events = await getOutboxEventsV5(targetOwner);
  assert.deepEqual(events.map((event) => event.target.kind).sort(), ['bookmark', 'progress']);
  assert.ok(events.every((event) => event.ownerKey === targetOwner));

  const second = await migrateDriveProgressToFirebaseScopeV170({
    sourceOwnerKey: sourceOwner,
    deviceId: 'device-1',
  });
  assert.deepEqual(second, { migrated: 1, skipped: true });
  assert.equal((await getOutboxEventsV5(targetOwner)).length, 2);
});

test('does not replace newer Firebase-scoped local progress', async () => {
  await saveProgressToLocalV5(sourceOwner, {
    bookId: 'book-1', cfi: 'old', progressPercent: 10, lastRead: 100, bookmarks: [],
  });
  await saveProgressToLocalV5(targetOwner, {
    bookId: 'book-1', cfi: 'new', progressPercent: 80, lastRead: 200, bookmarks: [],
  });

  const result = await migrateDriveProgressToFirebaseScopeV170({
    sourceOwnerKey: sourceOwner,
    deviceId: 'device-1',
  });
  assert.deepEqual(result, { migrated: 0, skipped: false });
  assert.equal((await getAllLocalProgressV5(targetOwner))[0].cfi, 'new');
  assert.equal((await getOutboxEventsV5(targetOwner)).length, 0);
});
