import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchDriveFiles,
  getDriveLibraryFolderId,
  GoogleDriveFolderConflictError,
  normalizeDriveBooks,
} from '../src/lib/googleDrive.ts';
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

test('prefers the app-marked library folder over same-name folders', async (t) => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({
      files: [{
        id: 'marked-folder',
        name: 'web viewer',
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: { twreaderLibrary: 'v1' },
      }],
    }), { status: 200 });
  };

  assert.equal(await getDriveLibraryFolderId('token'), 'marked-folder');
  assert.equal(requests.length, 1);
  assert.match(decodeURIComponent(requests[0]), /appProperties has/);
});

test('does not choose an arbitrary folder when duplicate names are unmarked', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(JSON.stringify({
      files: requestCount === 1
        ? []
        : [
          { id: 'folder-a', name: 'web viewer', mimeType: 'application/vnd.google-apps.folder' },
          { id: 'folder-b', name: 'web viewer', mimeType: 'application/vnd.google-apps.folder' },
        ],
    }), { status: 200 });
  };

  await assert.rejects(
    getDriveLibraryFolderId('token'),
    GoogleDriveFolderConflictError,
  );
  assert.equal(requestCount, 2);
});

test('migrates one existing folder and tolerates a read-only marker update', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (options.method === 'PATCH') {
      return new Response('', { status: 403 });
    }

    const query = new URL(String(url)).searchParams.get('q') ?? '';
    return new Response(JSON.stringify({
      files: query.includes('appProperties has')
        ? []
        : [{
          id: 'existing-folder',
          name: 'web viewer',
          mimeType: 'application/vnd.google-apps.folder',
        }],
    }), { status: 200 });
  };

  assert.equal(await getDriveLibraryFolderId('token'), 'existing-folder');
  assert.equal(requests.length, 3);
  assert.equal(requests[2].options.method, 'PATCH');
  assert.match(String(requests[2].options.body), /twreaderLibrary/);
});

test('lists books only from the resolved library folder', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let requestUrl = '';
  globalThis.fetch = async (url) => {
    requestUrl = String(url);
    return new Response(JSON.stringify({ files: [] }), { status: 200 });
  };

  await fetchDriveFiles('token', 'canonical-folder');
  const query = new URL(requestUrl).searchParams.get('q');
  assert.equal(query, "'canonical-folder' in parents and trashed=false");
});
