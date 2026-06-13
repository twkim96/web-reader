import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARCHIVE_FILE_MAX_BYTES,
  GENERAL_FILE_MAX_BYTES,
  getBookTitleFromFileName,
  getReaderFormat,
  getSourceBookFormat,
  updateImportSelection,
} from '../src/lib/bookFormats.ts';

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

test('accepts general books up to 150MB each and 500MB total', () => {
  const selected = [
    file('a.txt', GENERAL_FILE_MAX_BYTES),
    file('b.epub', GENERAL_FILE_MAX_BYTES),
  ];
  const accepted = updateImportSelection(selected, [
    file('c.pdf', 100 * 1024 * 1024),
    file('d.txt', 100 * 1024 * 1024),
  ], { allowExtendedFormats: true });

  assert.equal(accepted.error, null);
  assert.equal(accepted.files.length, 4);

  const oversized = updateImportSelection([], [
    file('large.pdf', GENERAL_FILE_MAX_BYTES + 1),
  ], { allowExtendedFormats: true });
  assert.match(oversized.error, /150MB/);

  const overTotal = updateImportSelection(selected, [
    file('c.pdf', 101 * 1024 * 1024),
    file('d.txt', 100 * 1024 * 1024),
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

test('enforces the configured maximum file count', () => {
  const files = Array.from({ length: 11 }, (_, index) => file(`${index}.txt`, 1));
  const result = updateImportSelection([], files, {
    allowExtendedFormats: false,
    maxFiles: 10,
  });
  assert.match(result.error, /최대 10개/);
  assert.deepEqual(result.files, []);
});
