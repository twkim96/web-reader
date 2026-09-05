import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deleteDriveFile,
  fetchFullFileBlob,
  fetchFullFile,
  fetchAndConsumeWithTimeout,
  fetchWithTimeout,
  fetchDriveFiles,
  getDriveLibraryFolderId,
  getDriveUserPermissionId,
  GoogleDriveFolderConflictError,
  GoogleDriveAuthError,
  invalidateDriveCachesForOwner,
  normalizeDriveBooks,
} from '../src/lib/googleDrive.ts';
import {
  getBookFingerprint,
  isCachedBookCurrent,
  shouldUseCachedBookContent,
} from '../src/lib/bookFingerprint.ts';

test('keeps cancellation connected through full download body consumption and cleans up on success', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const download of [fetchFullFile, fetchFullFileBlob]) {
    let signal;
    let body;
    globalThis.fetch = async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({ start(controller) {
        body = controller;
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      } }));
    };
    const caller = new AbortController();
    const pending = download('book', 'token', caller.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await new Promise(setImmediate);
    body.enqueue(new Uint8Array([1]));
    caller.abort();
    await rejected;
    assert.equal(signal.aborted, true);

    const successfulCaller = new AbortController();
    const successful = download('book', 'token', successfulCaller.signal);
    await new Promise(setImmediate);
    body.enqueue(new Uint8Array([1, 2]));
    body.close();
    const result = await successful;
    assert.equal(result.byteLength ?? result.size, 2);
    successfulCaller.abort();
    assert.equal(signal.aborted, false, 'completed requests remove the caller abort listener');
  }
});

test('download deadline remains active when headers arrive but the body stalls', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let signal;
  globalThis.fetch = async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }));
  };
  await assert.rejects(fetchAndConsumeWithTimeout('https://fixture.test', {}, 5,
    (response) => response.arrayBuffer()), /Network timeout/);
  assert.equal(signal.aborted, true);
});

test('treats an already missing Drive file as a successful idempotent delete', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.method, 'DELETE');
    return new Response('', { status: 404 });
  };
  await assert.doesNotReject(deleteDriveFile('already-deleted', 'token'));
});

test('resolves a stable Drive permission id before opening an owner namespace', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/drive\/v3\/about\?fields=user%28permissionId%29|\/drive\/v3\/about\?fields=user\(permissionId\)/);
    assert.equal(options.headers.Authorization, 'Bearer permission-token');
    return new Response(JSON.stringify({ user: { permissionId: 'permission-123' } }), { status: 200 });
  };
  assert.equal(await getDriveUserPermissionId('permission-token'), 'permission-123');
});

test('preserves Drive authorization expiry while resolving permission id', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response('', { status: 401 });
  await assert.rejects(getDriveUserPermissionId('expired-token'), GoogleDriveAuthError);
});

const abortableFetch = (_url, options = {}) => new Promise((_resolve, reject) => {
  const rejectAbort = () => reject(new DOMException('aborted', 'AbortError'));
  if (options.signal?.aborted) {
    rejectAbort();
    return;
  }
  options.signal?.addEventListener('abort', rejectAbort, { once: true });
});

test('preserves caller cancellation separately from an internal timeout', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = abortableFetch;

  const controller = new AbortController();
  const request = fetchWithTimeout(
    'https://example.test/file',
    { signal: controller.signal },
    1000,
  );
  controller.abort();

  await assert.rejects(request, { name: 'AbortError' });
});

test('reports an internal fetch timeout without exposing it as user cancellation', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = abortableFetch;

  await assert.rejects(
    fetchWithTimeout('https://example.test/file', {}, 5),
    /Network timeout/,
  );
});

test('passes reader cancellation into a full Drive Blob download', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let requestedUrl = '';
  globalThis.fetch = (url, options) => {
    requestedUrl = String(url);
    return abortableFetch(url, options);
  };

  const controller = new AbortController();
  const request = fetchFullFileBlob('folder/file id', 'token', controller.signal);
  controller.abort();

  await assert.rejects(request, { name: 'AbortError' });
  assert.match(requestedUrl, /folder%2Ffile%20id/);
});

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

  assert.equal(await getDriveLibraryFolderId('token-registry', { cacheKey: 'registry-session' }), 'registered-folder');
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
    getDriveLibraryFolderId('token-duplicate', { cacheKey: 'duplicate-session' }),
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

  assert.equal(await getDriveLibraryFolderId('token-store', { cacheKey: 'store-session' }), 'existing-folder');
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

  assert.equal(await getDriveLibraryFolderId('token-old-scope', { cacheKey: 'old-scope-session' }), 'existing-folder');
  assert.equal(requests.length, 3);
  assert.equal(requests[2].options.method, 'POST');
});

test('coalesces concurrent appData registry writes for one Drive account', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let registryCreates = 0;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.includes('spaces=appDataFolder')) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (new URL(requestUrl).searchParams.get('q')?.includes("name = 'web viewer'")) {
      return new Response(JSON.stringify({
        files: [{
          id: 'account-folder',
          name: 'web viewer',
          mimeType: 'application/vnd.google-apps.folder',
        }],
      }), { status: 200 });
    }
    if (options.method === 'POST') {
      registryCreates += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ id: 'registry-file' }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  const results = await Promise.all([
    getDriveLibraryFolderId('token-concurrent', { cacheKey: 'concurrent-session' }),
    getDriveLibraryFolderId('token-concurrent', { cacheKey: 'concurrent-session' }),
  ]);
  assert.deepEqual(results, ['account-folder', 'account-folder']);
  assert.equal(registryCreates, 1);
});

test('keeps canonical folder caches isolated by owner session without using token keys', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const appDataReads = new Map();
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    const authorization = options.headers?.Authorization ?? '';
    const account = authorization.endsWith('token-account-a') ? 'a' : 'b';

    if (requestUrl.includes('spaces=appDataFolder')) {
      appDataReads.set(account, (appDataReads.get(account) ?? 0) + 1);
      return new Response(JSON.stringify({
        files: [{ id: `registry-${account}` }],
      }), { status: 200 });
    }
    if (requestUrl.includes(`/registry-${account}?alt=media`)) {
      return new Response(JSON.stringify({
        version: 1,
        folderId: `folder-${account}`,
      }), { status: 200 });
    }
    if (requestUrl.includes(`/folder-${account}?fields=`)) {
      return new Response(JSON.stringify({
        id: `folder-${account}`,
        name: 'web viewer',
        mimeType: 'application/vnd.google-apps.folder',
        trashed: false,
      }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  assert.equal(await getDriveLibraryFolderId('token-account-a', { cacheKey: 'owner-a::session' }), 'folder-a');
  assert.equal(await getDriveLibraryFolderId('token-account-b', { cacheKey: 'owner-b::session' }), 'folder-b');
  assert.equal(await getDriveLibraryFolderId('token-account-a', { cacheKey: 'owner-a::session' }), 'folder-a');
  assert.deepEqual(Object.fromEntries(appDataReads), { a: 1, b: 1 });
});

test('purges every stale session cache for one owner without touching another owner', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let registryReads = 0;
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes('spaces=appDataFolder')) {
      registryReads += 1;
      return new Response(JSON.stringify({ files: [{ id: 'purge-registry' }] }), { status: 200 });
    }
    if (requestUrl.includes('/purge-registry?alt=media')) {
      return new Response(JSON.stringify({ version: 1, folderId: 'purge-folder' }), { status: 200 });
    }
    return new Response(JSON.stringify({
      id: 'purge-folder',
      name: 'web viewer',
      mimeType: 'application/vnd.google-apps.folder',
      trashed: false,
    }), { status: 200 });
  };

  await getDriveLibraryFolderId('token', { cacheKey: 'drive:p::session-1' });
  await getDriveLibraryFolderId('token', { cacheKey: 'drive:p::session-2' });
  await getDriveLibraryFolderId('token', { cacheKey: 'drive:q::session-1' });
  assert.equal(registryReads, 3);
  invalidateDriveCachesForOwner('drive:p');
  await getDriveLibraryFolderId('token', { cacheKey: 'drive:p::session-2' });
  await getDriveLibraryFolderId('token', { cacheKey: 'drive:q::session-1' });
  assert.equal(registryReads, 4);
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

test('single-flights concurrent empty-account folder creation', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let folderCreates = 0;
  let registryCreates = 0;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.includes('spaces=appDataFolder')) {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (new URL(requestUrl).searchParams.get('q')?.includes("name = 'web viewer'")) {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (requestUrl.includes('/upload/drive/v3/files')) {
      registryCreates += 1;
      return new Response(JSON.stringify({ id: 'registry-file' }), { status: 200 });
    }
    if (options.method === 'POST') {
      folderCreates += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ id: 'created-folder' }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  const results = await Promise.all([
    getDriveLibraryFolderId('token-create-single-flight', { cacheKey: 'create-session', createIfMissing: true }),
    getDriveLibraryFolderId('token-create-single-flight', { cacheKey: 'create-session', createIfMissing: true }),
    getDriveLibraryFolderId('token-create-single-flight', { cacheKey: 'create-session', createIfMissing: true }),
  ]);

  assert.deepEqual(results, ['created-folder', 'created-folder', 'created-folder']);
  assert.equal(folderCreates, 1);
  assert.equal(registryCreates, 1);
});

test('clears a failed folder single-flight so the next call can retry', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let appDataReads = 0;
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.includes('spaces=appDataFolder')) {
      appDataReads += 1;
      if (appDataReads === 1) return new Response('temporary', { status: 500 });
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (new URL(requestUrl).searchParams.get('q')?.includes("name = 'web viewer'")) {
      return new Response(JSON.stringify({
        files: [{
          id: 'retry-folder',
          name: 'web viewer',
          mimeType: 'application/vnd.google-apps.folder',
        }],
      }), { status: 200 });
    }
    if (requestUrl.includes('/upload/drive/v3/files') && options.method === 'POST') {
      return new Response(JSON.stringify({ id: 'registry-file' }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  await assert.rejects(
    getDriveLibraryFolderId('token-folder-retry', { cacheKey: 'retry-session' }),
    /라이브러리 폴더 설정 조회 실패/,
  );
  assert.equal(await getDriveLibraryFolderId('token-folder-retry', { cacheKey: 'retry-session' }), 'retry-folder');
  assert.equal(appDataReads, 2);
});

test('reads named folder candidates through every Drive page', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const folderPages = [];
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    const parsed = new URL(requestUrl);
    if (requestUrl.includes('spaces=appDataFolder')) {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (parsed.searchParams.get('q')?.includes("name = 'web viewer'")) {
      folderPages.push(parsed.searchParams.get('pageToken'));
      if (!parsed.searchParams.get('pageToken')) {
        return new Response(JSON.stringify({
          files: [{
            id: 'folder-page-1',
            name: 'web viewer',
            mimeType: 'application/vnd.google-apps.folder',
          }],
          nextPageToken: 'folder-next',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        files: [{
          id: 'folder-page-2',
          name: 'web viewer',
          mimeType: 'application/vnd.google-apps.folder',
        }],
      }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  await assert.rejects(
    getDriveLibraryFolderId('token-folder-pages', { cacheKey: 'pages-session' }),
    GoogleDriveFolderConflictError,
  );
  assert.deepEqual(folderPages, [null, 'folder-next']);
});

test('returns supported books from all Drive list pages', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const pageTokens = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const pageToken = parsed.searchParams.get('pageToken');
    pageTokens.push(pageToken);
    if (!pageToken) {
      return new Response(JSON.stringify({
        files: [{ id: 'first', name: 'first.epub', mimeType: 'application/epub+zip' }],
        nextPageToken: 'books-next',
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      files: [
        { id: 'second', name: 'second.pdf', mimeType: 'application/pdf' },
        { id: 'ignored', name: 'ignored.docx', mimeType: 'application/octet-stream' },
      ],
    }), { status: 200 });
  };

  const result = await fetchDriveFiles('token-book-pages', 'canonical-folder');
  assert.deepEqual(result.files.map(({ id }) => id), ['first', 'second']);
  assert.deepEqual(pageTokens, [null, 'books-next']);
});

test('rejects a repeated Drive list page token', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(JSON.stringify({
    files: [],
    nextPageToken: 'repeat-token',
  }), { status: 200 });

  await assert.rejects(
    fetchDriveFiles('token-repeated-page', 'canonical-folder'),
    /페이지 토큰이 반복/,
  );
});
