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

test('retries transient chunk failures without rebuilding the upload session', async () => {
  let calls = 0;
  const retryCounts = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return response(200, '', { Location: sessionUrl });
    if (calls === 2) return response(503, 'temporary');
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

  assert.equal(calls, 3);
  assert.ok(retryCounts.includes(1));
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
