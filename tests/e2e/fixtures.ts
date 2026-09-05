import { test as base, expect } from '@playwright/test';

export const test = base.extend<{ consoleErrors: void }>({
  consoleErrors: [async ({ page }, use, testInfo) => {
    // Authentication is outside these guest/cache/sandbox tests. Keep the SDK's
    // helper iframe local instead of reaching the developer's configured origin.
    await page.route(/\/__\/auth\/iframe(?:\?|$)/, (route) => route.fulfill({
      status: 200, contentType: 'text/html', body: '<!doctype html><html></html>',
    }));
    const errors: string[] = [];
    const isExternalCatalogTransportError = (text: string) => (
      /\/(?:bookCoverCache|serviceWorkerLifecycle)\.spec\.ts$/.test(testInfo.file)
      && text.startsWith('/firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?')
      && text.endsWith('due to access control checks.')
    );
    page.on('pageerror', (error) => {
      if (!isExternalCatalogTransportError(error.message)) errors.push(error.message);
    });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      const url = message.location().url;
      // These tests deliberately provoke one browser-level rejection.
      if (testInfo.title === 'publication sanitizer blocks executable, navigation, storage, and remote URL payloads'
        && /Blocked script execution.*sandboxed.*allow-scripts|Blocked script execution.*allow-scripts/.test(text)) return;
      if (testInfo.title === 'runtime cache stores only allowlisted public static requests'
        && url.includes('/api/not-found?sw-api=') && /404/.test(text)) return;
      // Guest cover/cache tests do not assert the external public catalog.
      // Its documented offline fallback can log unavailable; auth/permission
      // errors and all other application errors remain failures.
      if (/\/(?:bookCoverCache|serviceWorkerLifecycle)\.spec\.ts$/.test(testInfo.file)
        && (/^\[PublicBookCatalog\] load failed: FirebaseError: \[code=unavailable\]/.test(text)
        || isExternalCatalogTransportError(text)
        || (/^\[.*\]\s+@firebase\/firestore: Firestore .*Could not reach Cloud Firestore backend/.test(text)
          && text.includes('[code=unavailable]')))) return;
      errors.push(`${text}${url ? ` (${url})` : ''}`);
    });
    await use();
    if (errors.length) await testInfo.attach('browser-errors', { body: errors.join('\n\n'), contentType: 'text/plain' });
    expect(errors, 'unexpected browser errors').toEqual([]);
  }, { auto: true }],
});

export { expect };
export type { Page } from '@playwright/test';
