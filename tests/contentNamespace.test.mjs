import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const {
  getAllOfflineBooksV5,
  loadBookFromLocalV5,
  saveBookToLocalV5,
} = await import('../src/lib/localDBV5.ts');
const { DEVICE_CONTENT_OWNER_KEY } = await import('../src/lib/ownerIdentity.ts');

test.after(async () => {
  await closeLocalDB();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
});

test('device books use one namespace independent of Firebase and Drive accounts', async () => {
  await saveBookToLocalV5(DEVICE_CONTENT_OWNER_KEY, {
    id: 'book-1',
    name: 'Book',
    mimeType: 'application/epub+zip',
    source: 'local',
  }, new Blob(['book-content']));
  assert.equal((await getAllOfflineBooksV5(DEVICE_CONTENT_OWNER_KEY)).length, 1);
  assert.equal(await (await loadBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, 'book-1')).text(), 'book-content');
});

test('runtime book storage callers do not use the active Firebase owner key', async () => {
  const files = [
    '../src/hooks/useLibraryData.ts',
    '../src/components/shelf/FileUploader.tsx',
    '../src/components/ManageModal.tsx',
    '../src/components/shelf/useOfflineBookIds.ts',
    '../src/hooks/reader/useReaderBookSource.ts',
    '../src/app/page.tsx',
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:saveBookToLocalV5|loadBookFromLocalV5|loadBookMetadataFromLocalV5|getAllOfflineBooksV5|getOfflineBookIdsV5|removeBookFromLocalV5|saveArchiveInspectionToLocalV5|loadArchiveInspectionFromLocalV5)\(\s*owner\.ownerKey/);
  }
});

test('Drive connection changes only Drive inventory and cache state', async () => {
  const source = await readFile(new URL('../src/hooks/useLibraryData.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /makeDriveScopeKey|putOwnerBindingV5|putOwnerSessionV5/);
  assert.doesNotMatch(source, /ownerRuntime\.activate\([^)]*drive/);
  assert.match(source, /const driveNamespace = `drive:/);
  assert.match(source, /getAllOfflineBooksV5\(DEVICE_CONTENT_OWNER_KEY\)/);
});
