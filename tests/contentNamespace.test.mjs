import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const {
  getAllLocalProgressV5,
  getAllOfflineBooksV5,
  loadBookFromLocalV5,
  saveBookToLocalV5,
  saveProgressToLocalV5,
} = await import('../src/lib/localDBV5.ts');
const { createLocalBookId } = await import('../src/lib/localBookIdentity.ts');
const { getLocalAnnotationsV8, saveLocalAnnotationV8 } = await import(
  '../src/lib/localAnnotations.ts'
);
const {
  DEVICE_CONTENT_OWNER_KEY,
  makeFirebaseOwnerKey,
  makeOwnerKey,
} = await import('../src/lib/ownerIdentity.ts');

const annotationOwnerKey = makeOwnerKey(
  makeFirebaseOwnerKey('local-id-test'),
  'library:local',
);

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

test('same-name local imports receive independent content, progress, and annotation ids', async () => {
  const ids = ['first', 'second'];
  const firstId = createLocalBookId(() => ids.shift());
  const secondId = createLocalBookId(() => ids.shift());
  assert.notEqual(firstId, secondId);

  for (const [id, content] of [[firstId, 'first-content'], [secondId, 'second-content']]) {
    await saveBookToLocalV5(DEVICE_CONTENT_OWNER_KEY, {
      id,
      name: 'same.epub',
      mimeType: 'application/epub+zip',
      source: 'local',
    }, new Blob([content]));
  }
  await saveProgressToLocalV5(annotationOwnerKey, {
    bookId: firstId,
    cfi: 'first-cfi',
    progressPercent: 10,
    lastRead: 1,
    bookmarks: [],
  });
  await saveProgressToLocalV5(annotationOwnerKey, {
    bookId: secondId,
    cfi: 'second-cfi',
    progressPercent: 20,
    lastRead: 2,
    bookmarks: [],
  });
  const makeAnnotation = (bookId, id) => ({
    id,
    bookId,
    type: 'highlight',
    sectionIndex: 0,
    rangeCfi: `epubcfi(/6/2!/4/2,/1:0,/1:${id.length})`,
    quote: id,
    prefix: '',
    suffix: '',
    colorId: 'yellow',
    note: '',
    progressPercent: 10,
    chapter: '',
    createdAtClient: 1,
    updatedAtClient: 1,
    anchorState: 'active',
  });
  await saveLocalAnnotationV8(annotationOwnerKey, makeAnnotation(firstId, 'first-note'));
  await saveLocalAnnotationV8(annotationOwnerKey, makeAnnotation(secondId, 'second-note'));

  assert.equal(await (await loadBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, firstId)).text(), 'first-content');
  assert.equal(await (await loadBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, secondId)).text(), 'second-content');
  const progress = await getAllLocalProgressV5(annotationOwnerKey);
  assert.equal(progress.find(({ bookId }) => bookId === firstId).cfi, 'first-cfi');
  assert.equal(progress.find(({ bookId }) => bookId === secondId).cfi, 'second-cfi');
  assert.equal((await getLocalAnnotationsV8(annotationOwnerKey, firstId))[0].id, 'first-note');
  assert.equal((await getLocalAnnotationsV8(annotationOwnerKey, secondId))[0].id, 'second-note');
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
  const uploader = await readFile(
    new URL('../src/components/shelf/FileUploader.tsx', import.meta.url),
    'utf8',
  );
  assert.match(uploader, /id: driveBook\?\.id \?\? createLocalBookId\(\)/);
  assert.doesNotMatch(uploader, /id: driveBook\?\.id \?\? file\.name/);
});

test('Drive connection changes only Drive inventory and cache state', async () => {
  const source = await readFile(new URL('../src/hooks/useLibraryData.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /makeDriveScopeKey|putOwnerBindingV5|putOwnerSessionV5/);
  assert.doesNotMatch(source, /ownerRuntime\.activate\([^)]*drive/);
  assert.match(source, /const driveNamespace = `drive:/);
  assert.match(source, /getAllOfflineBooksV5\(DEVICE_CONTENT_OWNER_KEY\)/);
});
