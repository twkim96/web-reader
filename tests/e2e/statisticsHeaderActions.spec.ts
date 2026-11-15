import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('statistics header has icon actions and exports and shares only JSON', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('neverShowInstallPrompt', 'true');
    localStorage.setItem('viewer_settings', JSON.stringify({ autoOpenLastBook: false }));
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Guest Library', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const request = indexedDB.open('web-reader-db');
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const now = Date.now();
    const timezoneOffsetMinutes = new Date().getTimezoneOffset();
    const localDate = new Date(now - timezoneOffsetMinutes * 60000).toISOString().slice(0, 10);
    const tx = db.transaction('reading-sessions-v11', 'readwrite');
    tx.objectStore('reading-sessions-v11').put({
      ownerKey: `guest:${localStorage.getItem('web_reader_guest_install_id')}|library:local`,
      schemaVersion: 1, sessionId: 'header-actions-test', bookId: 'header-book', bookTitle: 'Header test',
      deviceId: 'test-device', mode: 'screen', startedAtClient: now - 60000, endedAtClient: now,
      durationMs: 60000, startProgressPercent: 0, endProgressPercent: 10,
      timezoneOffsetMinutes, localDate, completed: false,
      syncState: 'synced', retryCount: 0, nextAttemptAt: 0, lastErrorCode: null,
    });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async ({ files }: { files: File[] }) => {
      Reflect.set(window, '__sharedStatistics', { name: files[0].name, text: await files[0].text() });
    } });
  });
  await page.getByRole('button', { name: '독서 통계', exact: true }).click();
  const modal = page.locator('[data-reading-statistics-modal]');
  const header = modal.locator('[data-menu-sheet-header]');
  await expect(header.locator('.app-menu-sheet-header-actions button')).toHaveCount(4);
  await expect(header.locator('[data-reading-statistics-export="json"]')).toBeEnabled();
  await expect(modal.locator('[data-reading-statistics-export="markdown"]')).toHaveCount(0);
  await expect(header).toHaveText('독서 통계');
  await expect(header).toHaveCSS('border-bottom-width', '0px');
  const bounds = await header.locator('button').evaluateAll(buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect();
    return { width: rect.width, height: rect.height, right: rect.right };
  }));
  expect(bounds.every(button => button.width === bounds[0].width && button.height === bounds[0].height)).toBe(true);
  expect(bounds.every(button => button.right <= 320)).toBe(true);
  const pending = page.waitForEvent('download');
  await header.getByRole('button', { name: '독서 통계 JSON 저장', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  const payload = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(payload.schemaVersion).toBe(1);
  expect(payload.sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual(['header-actions-test']);
  await header.getByRole('button', { name: '독서 통계 공유', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__sharedStatistics')?.name)).toMatch(/\.json$/);
  expect(await page.evaluate(() => JSON.parse(Reflect.get(window, '__sharedStatistics').text).sessions.length)).toBe(1);
  await page.evaluate(() => Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }));
  const fallback = page.waitForEvent('download');
  await header.getByRole('button', { name: '독서 통계 공유', exact: true }).click();
  expect((await fallback).suggestedFilename()).toMatch(/\.json$/);
  await expect(modal.getByRole('status')).toContainText('JSON');
  const diagnostic = page.waitForEvent('download');
  await header.getByRole('button', { name: '진단 JSON 저장', exact: true }).click();
  expect((await diagnostic).suggestedFilename()).toMatch(/\.json$/);
});
