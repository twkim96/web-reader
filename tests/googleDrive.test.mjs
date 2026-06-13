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

test('prefers the appData library folder over same-name folders', async (t) => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const requestUrl = String(url);
    if (requestUrl.includes('spaces=appDataFolder')) {
      return new Response(JSON.stringify({
        files: [
          { id: 'registry-file' },
          { id: 'duplicate-registry-file' },
        ],
      }), { status: 200 });
    }
    if (requestUrl.includes('/registry-file?alt=media')) {
      return new Response(JSON.stringify({
        version: 1,
        folderId: 'registered-folder',
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      id: 'registered-folder',
      name: 'web viewer',
      mimeType: 'application/vnd.google-apps.folder',
      trashed: false,
    }), { status: 200 });
  };

  assert.equal(await getDriveLibraryFolderId('token'), 'registered-folder');
  assert.equal(requests.length, 4);
  assert.match(requests[0].url, /spaces=appDataFolder/);
  assert.equal(requests[3].options.method, 'DELETE');
  assert.match(requests[3].url, /duplicate-registry-file/);
  assert.doesNotMatch(
    requests.map(({ url }) => url).join('\n'),
    /name%20%3D%20'web%20viewer'/,
  );
});

test('does not choose an arbitrary folder when duplicate names are unregistered', async (t) => {
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

test('stores one existing folder in appData for other devices', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('spaces=appDataFolder')) {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (options.method === 'POST') {
      return new Response(JSON.stringify({ id: 'registry-file' }), { status: 200 });
    }
    return new Response(JSON.stringify({
      files: [{
        id: 'existing-folder',
        name: 'web viewer',
        mimeType: 'application/vnd.google-apps.folder',
      }],
    }), { status: 200 });
  };

  assert.equal(await getDriveLibraryFolderId('token'), 'existing-folder');
  assert.equal(requests.length, 3);
  assert.equal(requests[2].options.method, 'POST');
  assert.match(requests[2].url, /uploadType=multipart/);
});

test('keeps the existing folder usable with an old drive.file-only token', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('spaces=appDataFolder') || options.method === 'POST') {
      return new Response('', { status: 403 });
    }
    return new Response(JSON.stringify({
      files: [{
        id: 'existing-folder',
        name: 'web viewer',
        mimeType: 'application/vnd.google-apps.folder',
      }],
    }), { status: 200 });
  };

  assert.equal(await getDriveLibraryFolderId('token'), 'existing-folder');
  assert.equal(requests.length, 3);
  assert.equal(requests[2].options.method, 'POST');
});

test('coalesces concurrent appData registry writes for a cached folder', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  });

  const storage = new Map([
    ['google_drive_library_folder_id', 'cached-folder'],
  ]);
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };

  let registryCreates = 0;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.includes('/cached-folder?fields=')) {
      return new Response(JSON.stringify({
        id: 'cached-folder',
        name: 'web viewer',
        mimeType: 'application/vnd.google-apps.folder',
        trashed: false,
      }), { status: 200 });
    }
    if (requestUrl.includes('spaces=appDataFolder')) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (options.method === 'POST') {
      registryCreates += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ id: 'registry-file' }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  const results = await Promise.all([
    getDriveLibraryFolderId('token'),
    getDriveLibraryFolderId('token'),
  ]);
  assert.deepEqual(results, ['cached-folder', 'cached-folder']);
  assert.equal(registryCreates, 1);
  assert.equal(storage.get('google_drive_library_registry_synced'), 'cached-folder');
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
