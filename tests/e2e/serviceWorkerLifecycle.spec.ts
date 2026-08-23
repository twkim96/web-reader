import { expect, test } from '@playwright/test';

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
    const cache = await caches.open('pc-reader-v1.8.33');
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
