import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test('an empty shelf requests the public catalog when the filter is opened', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('neverShowInstallPrompt', 'true');
  });
  await page.route(/\/__\/auth\/iframe(?:\?|$)/, (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html></html>',
  }));
  let catalogRequested = false;
  await page.route('https://firestore.googleapis.com/**', (route) => {
    if (route.request().postData()?.includes('publicBookCatalogIndexV1')) catalogRequested = true;
    return route.abort();
  });

  await page.goto('/');
  const filter = page.locator('[data-shelf-filter-control]:visible').first();
  await expect(filter).toBeVisible();
  await expect(page.locator('[data-shelf-book-id]')).toHaveCount(0);
  // Give both the initial load and the online retry a chance to issue a request.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(900);
  expect(catalogRequested).toBe(false);

  await filter.click();
  await expect.poll(() => catalogRequested).toBe(true);
});
