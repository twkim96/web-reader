import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

import {
  ArchiveImageError,
  createZipImageBook,
  inspectZipImageArchive,
  prepareZipImageBook,
  selectArchiveImageEntries,
} from '../src/lib/archiveImages.ts';
import {
  MAX_SEVEN_ZIP_TOTAL_EXPANDED_BYTES,
  createArchiveImageBook,
  createArchiveImageIndex,
  restoreArchiveImageInspection,
} from '../src/lib/archiveImageBook.ts';

const entry = (name, options = {}) => ({
  name,
  directory: false,
  encrypted: false,
  size: 10,
  source: null,
  ...options,
});

test('filters mixed archive entries and naturally sorts supported images', () => {
  const inspection = selectArchiveImageEntries([
    entry('pages/10.JPG'),
    entry('pages/2.png'),
    entry('pages/1.webp'),
    entry('pages/readme.txt'),
    entry('pages/vector.svg'),
    entry('__MACOSX/pages/3.jpg'),
    entry('pages/.hidden.jpg'),
    entry('pages/.DS_Store'),
    entry('pages/folder/', { directory: true }),
  ]);

  assert.deepEqual(
    inspection.entries.map(({ normalizedName }) => normalizedName),
    ['pages/1.webp', 'pages/2.png', 'pages/10.JPG'],
  );
  assert.equal(inspection.totalImageBytes, 30);
});

test('normalizes leading current-directory segments from archive paths', () => {
  const inspection = selectArchiveImageEntries([entry('././pages/1.png')]);
  assert.equal(inspection.entries[0].normalizedName, 'pages/1.png');
});

test('rejects archives without images and encrypted image entries', () => {
  assert.throws(
    () => selectArchiveImageEntries([entry('notes.txt')]),
    (error) => error instanceof ArchiveImageError && error.code === 'no-images',
  );
  assert.throws(
    () => selectArchiveImageEntries([entry('1.jpg', { encrypted: true })]),
    (error) => error instanceof ArchiveImageError && error.code === 'encrypted',
  );
});

test('rejects an image whose expanded size exceeds the per-page guard', () => {
  assert.throws(
    () => selectArchiveImageEntries([
      entry('huge.png', { size: 100 * 1024 * 1024 + 1 }),
    ]),
    (error) => error instanceof ArchiveImageError && error.code === 'image-too-large',
  );
});

test('rejects negative, non-finite, and unsafe archive entry sizes', () => {
  for (const size of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => selectArchiveImageEntries([entry('1.jpg', { size })]),
      (error) => error instanceof ArchiveImageError && error.code === 'damaged',
    );
  }
});

test('can guard total 7z expansion including non-image entries', () => {
  assert.throws(
    () => selectArchiveImageEntries([
      entry('1.jpg', { size: 10 }),
      entry('payload.bin', { size: MAX_SEVEN_ZIP_TOTAL_EXPANDED_BYTES }),
    ], {
      maxTotalExpandedBytes: MAX_SEVEN_ZIP_TOTAL_EXPANDED_BYTES,
    }),
    (error) => (
      error instanceof ArchiveImageError
      && error.code === 'expanded-size-too-large'
    ),
  );
});

test('closes an archive source when extracted Blob size differs from its index', async () => {
  let closed = 0;
  const book = createArchiveImageBook({
    entries: [{
      name: '1.jpg',
      normalizedName: '1.jpg',
      size: 10,
      encrypted: false,
      mimeType: 'image/jpeg',
      source: null,
    }],
    fileName: 'damaged.cbz',
    loadBlob: async () => new Blob(['short']),
    close: () => {
      closed += 1;
    },
  });

  await assert.rejects(
    book.sections[0].load(),
    (error) => error instanceof ArchiveImageError && error.code === 'damaged',
  );
  assert.equal(closed, 1);
});

test('inspects a real mixed ZIP without extracting non-image entries', async () => {
  const zip = new JSZip();
  zip.file('10.jpg', 'ten');
  zip.file('2.png', 'two');
  zip.file('notes.txt', 'ignored');
  const blob = await zip.generateAsync({ type: 'blob' });

  const inspection = await inspectZipImageArchive(blob);
  assert.deepEqual(inspection.names, ['2.png', '10.jpg']);
  assert.equal(inspection.imageCount, 2);
});

test('shares an in-flight page extraction for concurrent loads', async () => {
  const zip = new JSZip();
  zip.file('1.jpg', 'image');
  const blob = await zip.generateAsync({ type: 'blob' });
  const book = await createZipImageBook(blob, 'pages.cbz');

  const [firstUrl, secondUrl] = await Promise.all([
    book.sections[0].load(),
    book.sections[0].load(),
  ]);

  assert.equal(firstUrl, secondUrl);
  book.destroy();
});

test('restores a validated image index against fresh archive entry handles', () => {
  const firstInspection = selectArchiveImageEntries([
    entry('10.jpg', { source: 'old-10' }),
    entry('2.png', { source: 'old-2' }),
  ]);
  const index = createArchiveImageIndex(firstInspection);
  const restored = restoreArchiveImageInspection([
    entry('10.jpg', { source: 'new-10' }),
    entry('2.png', { source: 'new-2' }),
  ], index);

  assert.deepEqual(
    restored.entries.map(({ normalizedName, source }) => [normalizedName, source]),
    [['2.png', 'new-2'], ['10.jpg', 'new-10']],
  );
  assert.throws(
    () => restoreArchiveImageInspection([
      entry('10.jpg', { source: 'changed', size: 11 }),
      entry('2.png', { source: 'new-2' }),
    ], index),
    (error) => error instanceof ArchiveImageError && error.code === 'damaged',
  );
  assert.throws(
    () => restoreArchiveImageInspection([
      entry('10.jpg', { source: 'new-10' }),
      entry('2.png', { source: 'new-2' }),
      entry('3.webp', { source: 'unexpected' }),
    ], index),
    (error) => error instanceof ArchiveImageError && error.code === 'damaged',
  );
});

test('restores duplicate archive paths without sharing entry handles', () => {
  const firstInspection = selectArchiveImageEntries([
    entry('1.jpg', { source: 'old-first' }),
    entry('1.jpg', { source: 'old-second' }),
  ]);
  const restored = restoreArchiveImageInspection([
    entry('1.jpg', { source: 'new-first' }),
    entry('1.jpg', { source: 'new-second' }),
  ], createArchiveImageIndex(firstInspection));

  assert.deepEqual(
    restored.entries.map(({ source }) => source),
    ['new-first', 'new-second'],
  );
});

test('opens a ZIP book from its cached serializable image index', async () => {
  const zip = new JSZip();
  zip.file('10.jpg', 'ten');
  zip.file('2.png', 'two');
  zip.file('notes.txt', 'ignored');
  const blob = await zip.generateAsync({ type: 'blob' });
  const { index } = await inspectZipImageArchive(blob);
  const { book } = await prepareZipImageBook(blob, 'cached.cbz', index);

  assert.deepEqual(book.sections.map(({ id }) => id), ['2.png', '10.jpg']);
  book.destroy();
});
