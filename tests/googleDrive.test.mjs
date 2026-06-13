import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDriveBooks } from '../src/lib/googleDrive.ts';
import {
  getBookFingerprint,
  isCachedBookCurrent,
  shouldUseCachedBookContent,
} from '../src/lib/bookFingerprint.ts';

test('keeps supported Drive files by extension and preserves fingerprint metadata', () => {
  const files = normalizeDriveBooks([
    {
      id: 'pdf-id',
      name: 'manual.PDF',
      mimeType: 'application/octet-stream',
      size: '1024',
      modifiedTime: '2026-06-13T00:00:00Z',
      md5Checksum: 'abc',
    },
    {
      id: 'archive-id',
      name: 'images.cbz',
      mimeType: 'application/octet-stream',
      size: '2048',
    },
    {
      id: 'other-id',
      name: 'notes.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
  ]);

  assert.equal(files.length, 2);
  assert.deepEqual(files[0], {
    id: 'pdf-id',
    name: 'manual.PDF',
    mimeType: 'application/pdf',
    size: '1024',
    modifiedTime: '2026-06-13T00:00:00Z',
    md5Checksum: 'abc',
    sourceFormat: 'pdf',
    readerFormat: 'pdf',
    archiveFormat: undefined,
  });
  assert.equal(files[1].archiveFormat, 'cbz');
  assert.equal(files[1].readerFormat, 'archive');
});

test('uses Drive checksum first and invalidates only changed cached files', () => {
  const current = {
    id: 'archive-id',
    name: 'images.cbz',
    mimeType: 'application/zip',
    source: 'cloud',
    size: '2048',
    modifiedTime: '2026-06-13T00:00:00Z',
    md5Checksum: 'ABC',
  };

  assert.equal(getBookFingerprint(current), 'md5:abc');
  assert.equal(isCachedBookCurrent(current, {
    ...current,
    md5Checksum: 'abc',
  }), true);
  assert.equal(isCachedBookCurrent(current, {
    ...current,
    md5Checksum: 'def',
  }), false);
  assert.equal(shouldUseCachedBookContent(current, {
    ...current,
    md5Checksum: 'def',
  }, true), false);
  assert.equal(shouldUseCachedBookContent(current, {
    ...current,
    md5Checksum: 'def',
  }, false), true);
  assert.equal(getBookFingerprint({
    size: 2048,
    modifiedTime: '2026-06-13T00:00:00Z',
  }), 'metadata:2026-06-13T00:00:00Z:2048');
});
