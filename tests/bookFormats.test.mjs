import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARCHIVE_FILE_MAX_BYTES,
  ACTIVE_SOURCE_FORMATS,
  BOOK_FILE_LIMITS_MB,
  getBookTitleFromFileName,
  getBookMaxBytes,
  getBookOpenLimitError,
  getReaderFormat,
  getSourceBookFormat,
  updateImportSelection,
} from '../src/lib/bookFormats.ts';
import { buildTocProgress } from '../src/hooks/foliate/toc.ts';

const file = (name, size, type = '') => ({ name, size, type });

test('detects supported formats by extension before MIME fallback', () => {
  assert.equal(getSourceBookFormat('book.EPUB', 'application/zip'), 'epub');
  assert.equal(getSourceBookFormat('comic.cbz'), 'cbz');
  assert.equal(getSourceBookFormat('archive', 'application/x-7z-compressed'), '7z');
  assert.equal(getReaderFormat('txt'), 'epub');
  assert.equal(getReaderFormat('pdf'), 'pdf');
  assert.equal(getReaderFormat('zip'), 'archive');
  assert.equal(getBookTitleFromFileName('sample.CBZ'), 'sample');
});

test('enforces per-format limits and keeps the 500MB general total', () => {
  const formats = [
    ['txt', 'book.txt'],
    ['epub', 'book.epub'],
    ['pdf', 'book.pdf'],
  ];

  for (const [format, name] of formats) {
    const maxBytes = getBookMaxBytes(format);
    const accepted = updateImportSelection([], [file(name, maxBytes)], {
      allowExtendedFormats: true,
    });
    assert.equal(accepted.error, null);

    const oversized = updateImportSelection([], [file(name, maxBytes + 1)], {
      allowExtendedFormats: true,
    });
    assert.match(oversized.error, new RegExp(`${BOOK_FILE_LIMITS_MB[format]}MB`));
  }

  const selected = [
    file('a.pdf', getBookMaxBytes('pdf')),
    file('b.pdf', getBookMaxBytes('pdf')),
    file('c.txt', getBookMaxBytes('txt')),
  ];
  const overTotal = updateImportSelection(selected, [
    file('d.epub', getBookMaxBytes('epub')),
  ], { allowExtendedFormats: true });
  assert.match(overTotal.error, /500MB/);
  assert.deepEqual(overTotal.files, selected);
});

test('accepts exactly one archive up to 300MB', () => {
  const accepted = updateImportSelection([], [
    file('images.zip', ARCHIVE_FILE_MAX_BYTES),
  ], { allowExtendedFormats: true });
  assert.equal(accepted.error, null);
  assert.equal(accepted.files.length, 1);

  const oversized = updateImportSelection([], [
    file('images.7z', ARCHIVE_FILE_MAX_BYTES + 1),
  ], { allowExtendedFormats: true });
  assert.match(oversized.error, /300MB/);
});

test('keeps the existing selection when archive exclusivity is violated', () => {
  const general = [file('book.epub', 1)];
  const addArchive = updateImportSelection(general, [file('images.zip', 1)], {
    allowExtendedFormats: true,
  });
  assert.match(addArchive.error, /단독/);
  assert.deepEqual(addArchive.files, general);

  const archive = [file('images.zip', 1)];
  const addGeneral = updateImportSelection(archive, [file('book.txt', 1)], {
    allowExtendedFormats: true,
  });
  assert.match(addGeneral.error, /함께/);
  assert.deepEqual(addGeneral.files, archive);

  const mixed = updateImportSelection([], [
    file('book.txt', 1),
    file('images.zip', 1),
  ], { allowExtendedFormats: true });
  assert.match(mixed.error, /하나만/);
  assert.deepEqual(mixed.files, []);
});

test('can keep extended formats hidden until their readers are enabled', () => {
  const hiddenPdf = updateImportSelection([], [file('book.pdf', 1)], {
    allowExtendedFormats: false,
  });
  assert.match(hiddenPdf.error, /\.txt, \.epub/);

  const epub = updateImportSelection([], [file('book.epub', 1)], {
    allowExtendedFormats: false,
  });
  assert.equal(epub.error, null);
});

test('enables PDF, ZIP, CBZ, and 7z readers', () => {
  const zip = updateImportSelection([], [file('images.zip', 1)], {
    enabledFormats: ACTIVE_SOURCE_FORMATS,
  });
  assert.equal(zip.error, null);

  const pdf = updateImportSelection([], [file('book.pdf', 1)], {
    enabledFormats: ACTIVE_SOURCE_FORMATS,
  });
  assert.equal(pdf.error, null);

  const sevenZip = updateImportSelection([], [file('images.7z', 1)], {
    enabledFormats: ACTIVE_SOURCE_FORMATS,
  });
  assert.equal(sevenZip.error, null);
});

test('enforces the configured maximum file count', () => {
  const files = Array.from({ length: 11 }, (_, index) => file(`${index}.txt`, 1));
  const result = updateImportSelection([], files, {
    allowExtendedFormats: false,
    maxFiles: 10,
  });
  assert.match(result.error, /최대 10개/);
  assert.deepEqual(result.files, []);
});

test('blocks oversized Drive books before download', () => {
  for (const [format, extension] of [
    ['txt', 'txt'],
    ['epub', 'epub'],
    ['pdf', 'pdf'],
  ]) {
    const maxBytes = getBookMaxBytes(format);
    assert.equal(
      getBookOpenLimitError(`book.${extension}`, 'application/octet-stream', maxBytes),
      null,
    );
    assert.match(
      getBookOpenLimitError(`large.${extension}`, 'application/octet-stream', maxBytes + 1),
      new RegExp(`${BOOK_FILE_LIMITS_MB[format]}MB`),
    );
  }
  assert.equal(
    getBookOpenLimitError('images.cbz', 'application/octet-stream', String(ARCHIVE_FILE_MAX_BYTES)),
    null,
  );
  assert.match(
    getBookOpenLimitError('large.cbz', 'application/octet-stream', String(ARCHIVE_FILE_MAX_BYTES + 1)),
    /300MB/,
  );
});

test('builds TOC progress when an adapter exposes numeric section IDs', () => {
  const progress = buildTocProgress({
    book: {
      sections: [
        { id: 0, size: 1000 },
        { id: 1, size: 1000 },
      ],
      toc: [{ href: '1', label: 'Second page' }],
    },
    resolveNavigation: () => ({ index: 0 }),
  });

  assert.equal(progress[0].progress, 50);
});
