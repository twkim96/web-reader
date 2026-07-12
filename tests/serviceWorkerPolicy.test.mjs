import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const policy = require('../public/sw-policy.js');

const request = (path, options = {}) => ({
  method: options.method ?? 'GET',
  headers: new Headers(options.headers),
  mode: options.mode ?? 'cors',
  url: `https://reader.test${path}`,
});

test('bypasses private, authenticated, ranged, non-GET, and cross-origin requests', () => {
  const privateCases = [
    request('/api/books'),
    request('/__/auth/handler'),
    request('/__/firebase/init.json'),
    request('/book.epub', { headers: { Authorization: 'Bearer secret' } }),
    request('/book.epub', { headers: { Range: 'bytes=0-100' } }),
    request('/upload', { method: 'POST' }),
    { ...request('/asset.js'), url: 'https://accounts.google.com/asset.js' },
  ];
  for (const candidate of privateCases) {
    assert.equal(policy.isPrivateRequest(candidate, new URL(candidate.url), 'https://reader.test'), true);
  }
  const publicRequest = request('/_next/static/app.js');
  assert.equal(policy.isPrivateRequest(publicRequest, new URL(publicRequest.url), 'https://reader.test'), false);
});

test('allowlists only app shell static resources for runtime caching', () => {
  for (const path of [
    '/manifest.json', '/icon-192.png', '/_next/static/chunk.js',
    '/foliate-js/view.js', '/fonts/reader.woff2', '/7z/7zz.wasm', '/zip/zip.js',
  ]) assert.equal(policy.isStaticAssetPath(path), true, path);
  for (const path of ['/api/public', '/books/list.json', '/account', '/arbitrary']) {
    assert.equal(policy.isStaticAssetPath(path), false, path);
  }
});

test('rejects private, no-store, opaque, and non-200 responses', () => {
  assert.equal(policy.isCacheableResponse(new Response('ok', { status: 200 })), true);
  assert.equal(policy.isCacheableResponse(new Response('x', { status: 200, headers: { 'Cache-Control': 'private' } })), false);
  assert.equal(policy.isCacheableResponse(new Response('x', { status: 200, headers: { 'Cache-Control': 'no-store' } })), false);
  assert.equal(policy.isCacheableResponse(new Response('x', { status: 206 })), false);
  assert.equal(policy.isCacheableResponse({ status: 200, type: 'opaque', headers: new Headers() }), false);
});

test('waits for explicit update approval and has no catch-all cache route', async () => {
  const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(source, /event\.data\?\.type === 'SKIP_WAITING'/);
  assert.equal((source.match(/self\.skipWaiting\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(source, /clients\.claim/);
  assert.doesNotMatch(source, /event\.respondWith\(networkFirst\(event\)\)/);
});
