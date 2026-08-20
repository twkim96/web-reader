import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

import {
  ArchiveImageError,
  createZipImageBook,
  inspectZipImageArchive,
  prepareZipImageBook,
  selectArchiveImageEntries,
  shouldUseZipWebWorkers,
} from '../src/lib/archiveImages.ts';
import {
  MAX_SEVEN_ZIP_TOTAL_EXPANDED_BYTES,
  createArchiveImageBook,
  createArchiveImageIndex,
  restoreArchiveImageInspection,
} from '../src/lib/archiveImageBook.ts';
import { BOOK_COVER_MAX_SOURCE_BYTES } from '../src/lib/bookCoverPolicy.ts';

const entry = (name, options = {}) => ({
  name,
  directory: false,
  encrypted: false,
  size: 10,
  source: null,
  ...options,
});

const pngDimensionsBlob = (width, height) => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return new Blob([bytes], { type: 'image/png' });
};

test('uses the same-thread ZIP decoder on iPad Safari, including desktop-mode iPads', () => {
  assert.equal(shouldUseZipWebWorkers(true, {
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
    platform: 'iPad',
    maxTouchPoints: 5,
  }), false);
  assert.equal(shouldUseZipWebWorkers(true, {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    platform: 'MacIntel',
    maxTouchPoints: 5,
  }), false);
  assert.equal(shouldUseZipWebWorkers(true, {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    platform: 'MacIntel',
    maxTouchPoints: 0,
  }), true);
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
  const accepted = selectArchiveImageEntries([
    entry('1.jpg', { size: 10 }),
    entry('payload.bin', { size: MAX_SEVEN_ZIP_TOTAL_EXPANDED_BYTES - 10 }),
  ], {
    maxTotalExpandedBytes: MAX_SEVEN_ZIP_TOTAL_EXPANDED_BYTES,
  });
  assert.equal(accepted.entries.length, 1);

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
      && /1024MB/.test(error.message)
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

test('rejects oversized image dimensions before creating Blob URLs', async () => {
  const imageBlob = pngDimensionsBlob(8193, 8192);
  let closed = 0;
  let createdUrls = 0;
  const nativeCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = (...args) => {
    createdUrls += 1;
    return nativeCreateObjectURL(...args);
  };
  const book = createArchiveImageBook({
    entries: [{
      name: 'huge.png',
      normalizedName: 'huge.png',
      size: imageBlob.size,
      encrypted: false,
      mimeType: 'image/png',
      source: null,
    }],
    fileName: 'oversized.cbz',
    loadBlob: async () => imageBlob,
    close: () => {
      closed += 1;
    },
  });

  try {
    await assert.rejects(book.sections[0].load(), (error) => (
      error instanceof ArchiveImageError
      && error.code === 'image-dimensions-too-large'
    ));
    assert.equal(createdUrls, 0);
    assert.equal(closed, 1);
  } finally {
    URL.createObjectURL = nativeCreateObjectURL;
  }
});

test('revokes cached page URLs when a later image exceeds dimension limits', async () => {
  const normalBlob = pngDimensionsBlob(1200, 1800);
  const oversizedBlob = pngDimensionsBlob(8193, 8192);
  let closed = 0;
  let createdUrls = 0;
  let revokedUrls = 0;
  const nativeCreateObjectURL = URL.createObjectURL;
  const nativeRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = (...args) => {
    createdUrls += 1;
    return nativeCreateObjectURL(...args);
  };
  URL.revokeObjectURL = (...args) => {
    revokedUrls += 1;
    return nativeRevokeObjectURL(...args);
  };
  const book = createArchiveImageBook({
    entries: [
      {
        name: '1.png',
        normalizedName: '1.png',
        size: normalBlob.size,
        encrypted: false,
        mimeType: 'image/png',
        source: normalBlob,
      },
      {
        name: '2.png',
        normalizedName: '2.png',
        size: oversizedBlob.size,
        encrypted: false,
        mimeType: 'image/png',
        source: oversizedBlob,
      },
    ],
    fileName: 'mixed.cbz',
    loadBlob: async (archiveEntry) => archiveEntry.source,
    close: () => {
      closed += 1;
    },
  });

  try {
    await book.sections[0].load();
    await assert.rejects(book.sections[1].load(), (error) => (
      error instanceof ArchiveImageError
      && error.code === 'image-dimensions-too-large'
    ));
    assert.equal(createdUrls, 2);
    assert.equal(revokedUrls, 2);
    assert.equal(closed, 1);
    book.destroy();
    assert.equal(closed, 1);
  } finally {
    URL.createObjectURL = nativeCreateObjectURL;
    URL.revokeObjectURL = nativeRevokeObjectURL;
  }
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

test('rejects oversized dimensions from a real ZIP page extraction', async () => {
  const zip = new JSZip();
  zip.file(
    'huge.png',
    new Uint8Array(await pngDimensionsBlob(8193, 8192).arrayBuffer()),
  );
  const blob = await zip.generateAsync({ type: 'blob' });
  const book = await createZipImageBook(blob, 'oversized.cbz');

  await assert.rejects(book.sections[0].load(), (error) => (
    error instanceof ArchiveImageError
    && error.code === 'image-dimensions-too-large'
  ));
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

test('reuses the loaded first ZIP page as the archive cover source', async () => {
  const imageBlob = pngDimensionsBlob(1200, 1800);
  let loads = 0;
  const book = createArchiveImageBook({
    entries: [{
      name: '1.png',
      normalizedName: '1.png',
      size: imageBlob.size,
      encrypted: false,
      mimeType: 'image/png',
      source: imageBlob,
    }],
    fileName: 'cover.cbz',
    loadBlob: async (archiveEntry) => {
      loads += 1;
      return archiveEntry.source;
    },
    close: () => {},
  });

  await book.sections[0].load();
  assert.equal(await book.getCover(), imageBlob);
  assert.equal(loads, 1);
  book.destroy();
});

test('extracts the naturally sorted first ZIP image for import cover caching', async () => {
  const first = pngDimensionsBlob(600, 900);
  const zip = new JSZip();
  zip.file('pages/10.png', new Uint8Array(await pngDimensionsBlob(10, 10).arrayBuffer()));
  zip.file('pages/1.png', new Uint8Array(await first.arrayBuffer()));
  const blob = await zip.generateAsync({ type: 'blob' });

  const inspection = await inspectZipImageArchive(blob, { includeCoverSource: true });

  assert.equal(inspection.names[0], 'pages/1.png');
  assert.ok(inspection.coverSource instanceof Blob);
  assert.equal(inspection.coverSource.size, first.size);
  assert.deepEqual(
    new Uint8Array(await inspection.coverSource.arrayBuffer()),
    new Uint8Array(await first.arrayBuffer()),
  );
});

test('does not extract an archive cover source above the cover byte limit', async () => {
  let loads = 0;
  const book = createArchiveImageBook({
    entries: [{
      name: '1.png',
      normalizedName: '1.png',
      size: BOOK_COVER_MAX_SOURCE_BYTES + 1,
      encrypted: false,
      mimeType: 'image/png',
      source: null,
    }],
    fileName: 'large-cover.cbz',
    loadBlob: async () => {
      loads += 1;
      return new Blob();
    },
    close: () => {},
  });

  assert.equal(await book.getCover(), null);
  assert.equal(loads, 0);
  book.destroy();
});

test('passes page cancellation to extraction without closing the archive', async () => {
  const controller = new AbortController();
  let receivedSignal;
  let closed = 0;
  const book = createArchiveImageBook({
    entries: [{
      name: '1.jpg',
      normalizedName: '1.jpg',
      size: 5,
      encrypted: false,
      mimeType: 'image/jpeg',
      source: null,
    }],
    fileName: 'cancel.cbz',
    loadBlob: async (_entry, signal) => {
      receivedSignal = signal;
      controller.abort();
      throw new DOMException('cancelled', 'AbortError');
    },
    close: () => {
      closed += 1;
    },
  });

  await assert.rejects(
    book.sections[0].load(controller.signal),
    { name: 'AbortError' },
  );
  assert.equal(receivedSignal, controller.signal);
  assert.equal(closed, 0);
  book.destroy();
  assert.equal(closed, 1);
});

test('does not reuse an aborted pending page load', async () => {
  const staleController = new AbortController();
  const latestController = new AbortController();
  let calls = 0;
  const book = createArchiveImageBook({
    entries: [{
      name: '1.jpg',
      normalizedName: '1.jpg',
      size: 5,
      encrypted: false,
      mimeType: 'image/jpeg',
      source: null,
    }],
    fileName: 'rapid.cb7',
    loadBlob: (_entry, signal) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(new Blob(['image']));

      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('cancelled', 'AbortError')),
          { once: true },
        );
      });
    },
    close: () => {},
  });

  const stale = book.sections[0].load(staleController.signal);
  staleController.abort();
  const latest = book.sections[0].load(latestController.signal);

  await assert.rejects(stale, { name: 'AbortError' });
  assert.match(await latest, /^blob:/);
  assert.equal(calls, 2);
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
