import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DriveUploadHttpError,
  uploadFileResumable,
} from '../src/lib/driveUpload.ts';

const CHUNK_SIZE = 256 * 1024;
const sessionUrl = 'https://upload.example/session';
const response = (status, body = '', headers = {}) => new Response(body, { status, headers });

test('creates a resumable session and advances through 308 chunk responses', async () => {
  const calls = [];
  const progress = [];
  const file = new Blob([new Uint8Array(CHUNK_SIZE + 10)], { type: 'text/plain' });

  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response(200, '', { Location: sessionUrl });
    if (calls.length === 2) return response(308, '', { Range: `bytes=0-${CHUNK_SIZE - 1}` });
    return response(200, JSON.stringify({ id: 'drive-id' }), { 'Content-Type': 'application/json' });
  };

  const result = await uploadFileResumable({
    file,
    fileName: 'book.txt',
    folderId: 'folder-id',
    token: 'token',
    mimeType: 'text/plain',
    chunkSize: CHUNK_SIZE,
    fetchImpl,
    onProgress: (value) => progress.push(value),
  });

  assert.equal(result.id, 'drive-id');
  assert.match(calls[0].url, /uploadType=resumable/);
  assert.equal(calls[0].options.headers['X-Upload-Content-Length'], String(file.size));
  assert.equal(calls[1].options.headers['Content-Range'], `bytes 0-${CHUNK_SIZE - 1}/${file.size}`);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer token');
  assert.equal(calls[2].options.headers['Content-Range'], `bytes ${CHUNK_SIZE}-${file.size - 1}/${file.size}`);
  assert.equal(progress.at(-1).uploadedBytes, file.size);
});

test('retries resumable session creation before uploading content', async () => {
  const calls = [];
  const retryCounts = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response(503, 'temporary');
    if (calls.length === 2) return response(200, '', { Location: sessionUrl });
    return response(200, JSON.stringify({ id: 'drive-id' }), { 'Content-Type': 'application/json' });
  };

  await uploadFileResumable({
    file: new Blob(['content']),
    fileName: 'book.txt',
    folderId: 'folder-id',
    token: 'token',
    mimeType: 'text/plain',
    chunkSize: CHUNK_SIZE,
    fetchImpl,
    sleep: async () => {},
    onProgress: ({ retryCount }) => retryCounts.push(retryCount),
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[2].options.method, 'PUT');
  assert.ok(retryCounts.includes(1));
});

test('queries upload status after a lost chunk response without resending accepted bytes', async () => {
  const calls = [];
  const file = new Blob([new Uint8Array(CHUNK_SIZE + 10)]);
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response(200, '', { Location: sessionUrl });
    if (calls.length === 2) throw new TypeError('network response lost');
    if (calls.length === 3) {
      return response(308, '', { Range: `bytes=0-${CHUNK_SIZE - 1}` });
    }
    return response(200, JSON.stringify({ id: 'drive-id' }), { 'Content-Type': 'application/json' });
  };

  const result = await uploadFileResumable({
    file,
    fileName: 'book.pdf',
    folderId: 'folder-id',
    token: 'token',
    mimeType: 'application/pdf',
    chunkSize: CHUNK_SIZE,
    fetchImpl,
    sleep: async () => {},
  });

  assert.equal(result.id, 'drive-id');
  assert.equal(calls.length, 4);
  assert.equal(calls[2].options.headers['Content-Range'], `bytes */${file.size}`);
  assert.equal(calls[2].options.body, undefined);
  assert.equal(calls[3].options.headers['Content-Range'], `bytes ${CHUNK_SIZE}-${file.size - 1}/${file.size}`);
  assert.equal(
    calls.filter(({ options }) => options.headers?.['Content-Range'] === `bytes 0-${CHUNK_SIZE - 1}/${file.size}`).length,
    1,
  );
});

test('resumes from a partially received offset reported by the server', async () => {
  const calls = [];
  const partialBytes = CHUNK_SIZE / 2;
  const file = new Blob([new Uint8Array(CHUNK_SIZE + 10)]);
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response(200, '', { Location: sessionUrl });
    if (calls.length === 2) return response(503, 'response lost');
    if (calls.length === 3) {
      return response(308, '', { Range: `bytes=0-${partialBytes - 1}` });
    }
    return response(200, JSON.stringify({ id: 'drive-id' }), { 'Content-Type': 'application/json' });
  };

  await uploadFileResumable({
    file,
    fileName: 'book.epub',
    folderId: 'folder-id',
    token: 'token',
    mimeType: 'application/epub+zip',
    chunkSize: CHUNK_SIZE,
    fetchImpl,
    sleep: async () => {},
  });

  assert.equal(
    calls[3].options.headers['Content-Range'],
    `bytes ${partialBytes}-${file.size - 1}/${file.size}`,
  );
  assert.equal(calls[3].options.body.size, file.size - partialBytes);
});

test('uses a completed status response after the final chunk response is lost', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response(200, '', { Location: sessionUrl });
    if (calls.length === 2) throw new TypeError('network response lost');
    return response(200, JSON.stringify({ id: 'completed-id' }), {
      'Content-Type': 'application/json',
    });
  };

  const result = await uploadFileResumable({
    file: new Blob(['content']),
    fileName: 'book.txt',
    folderId: 'folder-id',
    token: 'token',
    mimeType: 'text/plain',
    chunkSize: CHUNK_SIZE,
    fetchImpl,
    sleep: async () => {},
  });

  assert.equal(result.id, 'completed-id');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.headers['Content-Range'], 'bytes */7');
});

test('fails when status recovery reports an expired upload session', async () => {
  let calls = 0;
  await assert.rejects(
    uploadFileResumable({
      file: new Blob(['content']),
      fileName: 'book.txt',
      folderId: 'folder-id',
      token: 'token',
      mimeType: 'text/plain',
      chunkSize: CHUNK_SIZE,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return response(200, '', { Location: sessionUrl });
        if (calls === 2) return response(503, 'response lost');
        return response(404, 'session expired');
      },
      sleep: async () => {},
    }),
    (error) => (
      error instanceof DriveUploadHttpError
      && error.status === 404
      && error.responseText === 'session expired'
    ),
  );
  assert.equal(calls, 3);
});

test('backs off on rate limits and verifies the server offset before retrying', async () => {
  const calls = [];
  const delays = [];
  const file = new Blob(['content']);
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response(200, '', { Location: sessionUrl });
    if (calls.length === 2) {
      return response(403, JSON.stringify({
        error: { errors: [{ reason: 'rateLimitExceeded' }] },
      }), { 'Content-Type': 'application/json' });
    }
    if (calls.length === 3) return response(308);
    return response(200, JSON.stringify({ id: 'drive-id' }), { 'Content-Type': 'application/json' });
  };

  await uploadFileResumable({
    file,
    fileName: 'book.txt',
    folderId: 'folder-id',
    token: 'token',
    mimeType: 'text/plain',
    chunkSize: CHUNK_SIZE,
    fetchImpl,
    sleep: async (delay) => delays.push(delay),
  });

  assert.deepEqual(delays, [1000]);
  assert.equal(calls[2].options.headers['Content-Range'], `bytes */${file.size}`);
  assert.equal(calls[3].options.headers['Content-Range'], `bytes 0-${file.size - 1}/${file.size}`);
});

test('retries status queries without resending the interrupted chunk', async () => {
  const calls = [];
  const file = new Blob(['content']);
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response(200, '', { Location: sessionUrl });
    if (calls.length === 2) return response(503, 'chunk response lost');
    if (calls.length === 3) return response(503, 'status unavailable');
    if (calls.length === 4) return response(308);
    return response(200, JSON.stringify({ id: 'drive-id' }), { 'Content-Type': 'application/json' });
  };

  await uploadFileResumable({
    file,
    fileName: 'book.txt',
    folderId: 'folder-id',
    token: 'token',
    mimeType: 'text/plain',
    chunkSize: CHUNK_SIZE,
    fetchImpl,
    sleep: async () => {},
  });

  assert.equal(calls.length, 5);
  assert.equal(calls[2].options.headers['Content-Range'], `bytes */${file.size}`);
  assert.equal(calls[3].options.headers['Content-Range'], `bytes */${file.size}`);
  assert.equal(calls[4].options.headers['Content-Range'], `bytes 0-${file.size - 1}/${file.size}`);
});

test('preserves chunk authorization errors without attempting status recovery', async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    await assert.rejects(
      uploadFileResumable({
        file: new Blob(['content']),
        fileName: 'book.txt',
        folderId: 'folder-id',
        token: 'token',
        mimeType: 'text/plain',
        chunkSize: CHUNK_SIZE,
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) return response(200, '', { Location: sessionUrl });
          return response(status, 'denied');
        },
      }),
      (error) => error instanceof DriveUploadHttpError && error.status === status,
    );
    assert.equal(calls, 2);
  }
});

test('cancels before a recovery status request starts', async () => {
  const controller = new AbortController();
  let calls = 0;

  await assert.rejects(
    uploadFileResumable({
      file: new Blob(['content']),
      fileName: 'book.txt',
      folderId: 'folder-id',
      token: 'token',
      mimeType: 'text/plain',
      signal: controller.signal,
      chunkSize: CHUNK_SIZE,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return response(200, '', { Location: sessionUrl });
        return response(503, 'chunk response lost');
      },
      sleep: async () => {
        controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 2);
});

test('stops before network work when upload is already cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;

  await assert.rejects(
    uploadFileResumable({
      file: new Blob(['content']),
      fileName: 'book.txt',
      folderId: 'folder-id',
      token: 'token',
      mimeType: 'text/plain',
      signal: controller.signal,
      fetchImpl: async () => {
        called = true;
        return response(500);
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(called, false);
});

for (const status of [401, 403]) {
  test(`preserves ${status} responses for the Drive auth boundary`, async () => {
    await assert.rejects(
      uploadFileResumable({
        file: new Blob(['content']),
        fileName: 'book.txt',
        folderId: 'folder-id',
        token: 'token',
        mimeType: 'text/plain',
        fetchImpl: async () => response(status, 'denied'),
      }),
      (error) => error instanceof DriveUploadHttpError && error.status === status,
    );
  });
}
