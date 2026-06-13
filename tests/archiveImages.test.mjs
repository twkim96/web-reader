import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

import {
  ArchiveImageError,
  createZipImageBook,
  inspectZipImageArchive,
  selectArchiveImageEntries,
} from '../src/lib/archiveImages.ts';

const entry = (filename, options = {}) => ({
  filename,
  directory: false,
  encrypted: false,
  uncompressedSize: 10,
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
    { ...entry('pages/folder/'), directory: true },
  ]);

  assert.deepEqual(
    inspection.entries.map(({ normalizedName }) => normalizedName),
    ['pages/1.webp', 'pages/2.png', 'pages/10.JPG'],
  );
  assert.equal(inspection.totalImageBytes, 30);
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
      entry('huge.png', { uncompressedSize: 100 * 1024 * 1024 + 1 }),
    ]),
    (error) => error instanceof ArchiveImageError && error.code === 'image-too-large',
  );
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
