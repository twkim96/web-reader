import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllowedRedirects, readBoundedBody, ResponseSizeError } from '../src/server/boundedFetch.ts';
import { createNovelpiaAuthProvider } from '../src/server/bookMetadata/config.ts';

test('NovelPia authentication preparation keeps the crawler signal through response bodies', async (t) => {
  const originalFetch = globalThis.fetch;
  const oldEmail = process.env.NOVELPIA_EMAIL;
  const oldPassword = process.env.NOVELPIA_PASSWORD;
  process.env.NOVELPIA_EMAIL = 'fixture@example.test';
  process.env.NOVELPIA_PASSWORD = 'fixture-only';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (oldEmail === undefined) delete process.env.NOVELPIA_EMAIL; else process.env.NOVELPIA_EMAIL = oldEmail;
    if (oldPassword === undefined) delete process.env.NOVELPIA_PASSWORD; else process.env.NOVELPIA_PASSWORD = oldPassword;
  });
  let signal;
  globalThis.fetch = async (url, options) => {
    signal = options.signal;
    assert.equal(options.redirect, 'error');
    const response = new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }));
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };
  const caller = new AbortController();
  const result = createNovelpiaAuthProvider().withSession(async () => assert.fail('must not reach work'), caller.signal);
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await new Promise(setImmediate);
  caller.abort();
  await rejected;
  assert.equal(signal.aborted, true);
});

test('stops reading on the first oversized chunk with missing or false length', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel() { cancelled = true; },
    }), { headers });
    await assert.rejects(readBoundedBody(response, 3), ResponseSizeError);
    assert.equal(cancelled, true);
  }
  assert.deepEqual(await readBoundedBody(new Response('ok'), 2), new TextEncoder().encode('ok'));
});

test('validates redirect destinations before sending any request to them', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requested = [];
  globalThis.fetch = async (url, options) => {
    requested.push(url.href);
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://unapproved.test/private' } });
  };
  await assert.rejects(fetchAllowedRedirects(new URL('https://allowed.test/image'), {},
    (url) => url.hostname === 'allowed.test'), /not allowed/);
  assert.deepEqual(requested, ['https://allowed.test/image']);
  globalThis.fetch = async (url) => url.pathname === '/image'
    ? new Response(null, { status: 302, headers: { location: '/final' } })
    : new Response('image');
  assert.equal(await (await fetchAllowedRedirects(new URL('https://allowed.test/image'), {},
    (url) => url.hostname === 'allowed.test')).text(), 'image');
});
