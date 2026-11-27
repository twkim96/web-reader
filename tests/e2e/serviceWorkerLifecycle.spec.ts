import { expect, test } from './fixtures';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

test('same-version build updates its imported worker script and prepares the new offline shell', async ({ page }) => {
  // Playwright routing disables Chromium's browser cache and forces request
  // revalidation. This local fixture has no authentication iframe to intercept.
  await page.unrouteAll();
  const fontPaths = [
    '/fonts/RIDIBatang.woff2',
    '/fonts/ChosunGu.woff',
    '/fonts/GowunBatang-Regular.woff',
    '/fonts/GowunDodum-Regular.woff',
  ];
  let ridiFallbackRequests = 0;
  const [worker, policy, fonts] = await Promise.all([
    readFile('public/sw.js', 'utf8'), readFile('public/sw-policy.js', 'utf8'),
    Promise.all(fontPaths.map(async path => [path, await readFile(`public${path}`)] as const)).then(entries => new Map(entries)),
  ]);
  let build = 'first';
  const readerChunk = () => `/_next/static/${build === 'second' ? 'immutable/' : ''}chunks/${build}-reader.js`;
  let unavailable = false;
  const server = createServer((request, response) => {
    if (unavailable) { request.socket.destroy(); return; }
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/fonts/RIDIBatang.otf') ridiFallbackRequests += 1;
    const font = fonts.get(request.url ?? '');
    if (font) {
      response.setHeader('Content-Type', request.url?.endsWith('.woff2') ? 'font/woff2' : 'font/woff');
      response.end(font);
    } else if (request.url === '/sw.js' || request.url === '/sw-policy.js' || request.url === '/sw-build.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(request.url === '/sw.js' ? worker : request.url === '/sw-policy.js' ? policy
        : `self.PC_READER_BUILD_ID = "${build}"; self.PC_READER_HAS_OFFLINE_ASSETS = true;`);
    } else if (request.url === `/offline-assets.json?build=${build}`) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ buildId: build, assets: [readerChunk()] }));
    } else if (request.url === readerChunk()) {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(`export default "${build}";`);
    } else if (request.url?.startsWith('/_next/static/')) {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(`document.title = "${build}";`);
    } else if (request.url === '/catalog/discovery.v1.json') {
      response.setHeader('Cache-Control', 'public, max-age=0');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ generation: build }));
    } else if (request.url === '/api/mypage?view=reviews') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ reviews: [{ workId: 'private-fixture' }] }));
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
  const appUrl = `http://127.0.0.1:${address.port}/`;
  const catalogGeneration = () => page.evaluate(async () => {
    const result = await fetch('/catalog/discovery.v1.json');
    return (await result.json()).generation;
  });
  const privateReviews = () => page.evaluate(async () => {
    const result = await fetch('/api/mypage?view=reviews', { headers: { Authorization: 'Bearer fixture' } });
    return (await result.json()).reviews;
  });
  try {
    await page.goto(appUrl);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    expect(await catalogGeneration()).toBe('first');
    expect(await privateReviews()).toEqual([{ workId: 'private-fixture' }]);
    expect(await page.evaluate(async () => (await caches.match('/api/mypage?view=reviews')) === undefined)).toBe(true);
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
    expect(await catalogGeneration()).toBe('second');
    // Reopen the installed app with transport down. A browser reload can mark
    // its subresource requests for revalidation, unlike a fresh navigation.
    await page.goto('about:blank');
    unavailable = true;
    await page.goto(appUrl);
    await expect(page).toHaveTitle('second');
    await expect(page.locator('body')).toHaveText('second');
    const offlineReaderBuild = await page.evaluate(async () => {
      const path = '/_next/static/immutable/chunks/second-reader.js';
      return (await import(path)).default;
    });
    expect(offlineReaderBuild).toBe('second');
    expect(await catalogGeneration()).toBe('second');
    const loadedFonts = await page.evaluate(async paths => Promise.all(paths.map(async (path, index) => {
      const response = await fetch(path, { cache: 'no-store' });
      const face = new FontFace(`OfflineProbe${index}`, await response.arrayBuffer());
      await face.load();
      return response.ok && face.status === 'loaded';
    })), fontPaths);
    expect(loadedFonts).toEqual([true, true, true, true]);
    expect(ridiFallbackRequests).toBe(0);
    expect(await page.evaluate(async () => (await caches.match('/api/mypage?view=reviews')) === undefined)).toBe(true);
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
    const buildId = JSON.parse(buildScript.split(';', 1)[0].split(' = ')[1]);
    const cache = await caches.open('pc-reader-v1.8.37-' + buildId);
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

test.describe('touch update approval', () => {
  test.use({ hasTouch: true });
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

    const secondTab = await page.context().newPage();
    await secondTab.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><html></html>',
    }));
    await secondTab.goto('/');
    const secondApply = secondTab.getByRole('button', { name: '저장 후 적용', exact: true });
    await expect(secondApply).toBeEnabled();
    await secondTab.evaluate(() => { document.documentElement.dataset.originalTab = 'true'; });

    // Hold only the activation message so the real button's in-progress state
    // can be observed before controllerchange reloads the app.
    await page.evaluate(() => {
      const post = ServiceWorker.prototype.postMessage;
      Reflect.set(window, '__updateActivationMessages', 0);
      ServiceWorker.prototype.postMessage = function (this: ServiceWorker, message: unknown) {
        if ((message as { type?: string })?.type !== 'SKIP_WAITING') return post.call(this, message);
        Reflect.set(window, '__updateActivationMessages', Reflect.get(window, '__updateActivationMessages') + 1);
        Reflect.set(window, '__releaseServiceWorkerUpdate', () => post.call(this, message));
      };
    });
    await page.getByRole('button', { name: '저장 후 적용', exact: true }).tap();
    const processing = page.getByRole('button', { name: '처리 중…', exact: true });
    await expect(processing).toBeDisabled();
    await expect(processing).toHaveAttribute('aria-busy', 'true');
    await processing.evaluate(button => (button as HTMLButtonElement).click());
    expect(await page.evaluate(() => Reflect.get(window, '__updateActivationMessages'))).toBe(1);
    await Promise.all([
      page.waitForEvent('load'),
      page.evaluate(() => Reflect.get(window, '__releaseServiceWorkerUpdate')()),
    ]);
    await waitForController(page);
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''))
      .toContain('/sw.js');
    await expect.poll(() => secondTab.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''))
      .toContain('/sw.js');
    expect(await secondTab.evaluate(() => document.documentElement.dataset.originalTab)).toBe('true');
    await Promise.all([secondTab.waitForEvent('load'), secondApply.tap()]);
    await expect(secondApply).toBeHidden();
    expect(await secondTab.evaluate(() => document.documentElement.dataset.originalTab)).toBeUndefined();
    await secondTab.close();
  });
});
