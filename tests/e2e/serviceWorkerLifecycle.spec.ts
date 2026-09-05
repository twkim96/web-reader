import { expect, test } from './fixtures';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

test('same-version build updates its imported worker script and prepares the new offline shell', async ({ page }) => {
  const [worker, policy] = await Promise.all([
    readFile('public/sw.js', 'utf8'), readFile('public/sw-policy.js', 'utf8'),
  ]);
  let build = 'first';
  let unavailable = false;
  const server = createServer((request, response) => {
    if (unavailable) { request.socket.destroy(); return; }
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/sw.js' || request.url === '/sw-policy.js' || request.url === '/sw-build.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(request.url === '/sw.js' ? worker : request.url === '/sw-policy.js' ? policy
        : `self.PC_READER_BUILD_ID = "${build}";`);
    } else if (request.url?.startsWith('/_next/static/')) {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(`document.title = "${build}";`);
    } else if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<html><head><script src="/_next/static/${build}.js"></script></head><body>${build}</body></html>`);
    } else {
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    build = 'second';
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state))
      .toBe('installed');
    expect(await page.title()).toBe('first');
    await page.reload();
    await expect(page).toHaveTitle('first');
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
        registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
      });
    });
    // Fail transport at the server: WebKit's setOffline can bypass SW navigation.
    unavailable = true;
    await page.reload();
    await expect(page).toHaveTitle('second');
    await expect(page.locator('body')).toHaveText('second');
  } finally {
    unavailable = false;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

const waitForController = async (page: import('@playwright/test').Page) => {
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
};

test('runtime cache stores only allowlisted public static requests', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload();
  }
  await waitForController(page);

  const result = await page.evaluate(async () => {
    const nonce = crypto.randomUUID();
    const urls = {
      allowed: `/foliate-js/view-policy.js?sw-e2e=${nonce}`,
      authorized: `/foliate-js/view-policy.js?sw-auth=${nonce}`,
      ranged: `/foliate-js/view-policy.js?sw-range=${nonce}`,
      arbitrary: `/window.svg?sw-arbitrary=${nonce}`,
      api: `/api/not-found?sw-api=${nonce}`,
    };
    const buildScript = await (await fetch('/sw-build.js')).text();
    const buildId = JSON.parse(buildScript.split(' = ')[1].replace(';', ''));
    const cache = await caches.open('pc-reader-v1.8.36-' + buildId);
    await Promise.all(Object.values(urls).map((url) => cache.delete(url)));

    await fetch(urls.allowed);
    await fetch(urls.authorized, { headers: { Authorization: 'Bearer test-only' } });
    await fetch(urls.ranged, { headers: { Range: 'bytes=0-20' } });
    await fetch(urls.arbitrary);
    await fetch(urls.api);
    await new Promise((resolve) => setTimeout(resolve, 250));

    return Object.fromEntries(await Promise.all(Object.entries(urls).map(async ([key, url]) => [
      key,
      Boolean(await cache.match(url)),
    ])));
  });

  expect(result).toEqual({
    allowed: true,
    authorized: false,
    ranged: false,
    arbitrary: false,
    api: false,
  });
});

test('app service worker waits for explicit user approval before takeover', async ({ page }) => {
  await page.goto('/manifest.json');
  await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    const fixture = await navigator.serviceWorker.register('/sw-update-fixture.js', { scope: '/' });
    const worker = fixture.installing ?? fixture.waiting ?? fixture.active;
    if (worker && worker.state !== 'activated') {
      await new Promise<void>((resolve) => {
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated') resolve();
        });
      });
    }
  });

  await page.goto('/');
  await waitForController(page);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''))
    .toContain('/sw-update-fixture.js');
  await expect(page.getByText('새 버전을 사용할 수 있습니다.')).toBeVisible();
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''))
    .toContain('/sw-update-fixture.js');

  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: '저장 후 적용' }).click(),
  ]);
  await waitForController(page);
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''))
    .toContain('/sw.js');
});
