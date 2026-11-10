import { expect, test } from '@playwright/test';
import JSZip from 'jszip';

test('archive minibar toggles webtoon independently and scrolling continues through the image edge', async ({ page, browserName }, testInfo) => {
  test.skip(browserName === 'webkit' && process.platform === 'darwin', 'Local macOS WebKit cannot persist the imported File Blob. Renderer behavior is covered in both engines by archiveWebtoon.spec.ts.');
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto('/');
  const image = await page.evaluate(() => {
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('neverShowInstallPrompt', 'true');
    localStorage.setItem('viewer_settings', JSON.stringify({ navMode: 'left-right', archiveWebtoonMode: false, autoOpenLastBook: false }));
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 1800;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#345678';
    context.fillRect(0, 0, 600, 1800);
    return canvas.toDataURL().split(',')[1];
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Guest Library', exact: true })).toBeVisible();
  const zip = new JSZip();
  zip.file('1.png', image, { base64: true });
  zip.file('2.png', image, { base64: true });
  await page.locator('button[title="Add Local Book"]:visible').first().click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'webtoon-proof.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }),
  });
  await page.getByRole('button', { name: '추가', exact: true }).click();
  const card = page.locator('[data-shelf-book-id]').filter({ hasText: 'webtoon-proof' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  const overlay = page.locator('[data-reader-interaction-overlay]');
  await expect(overlay).toBeVisible({ timeout: 30_000 });
  await overlay.click({ position: { x: 500, y: 350 } });
  const toggle = page.getByRole('button', { name: '웹툰 모드', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const toggleBox = await toggle.boundingBox();
  const statsBox = await page.getByRole('button', { name: '독서 통계', exact: true }).boundingBox();
  expect(toggleBox!.x).toBeLessThan(statsBox!.x);
  await toggle.evaluate(element => {
    element.style.setProperty('--accent-500', '#f02d73');
    element.style.setProperty('--app-menu-ink', '#c0c1c2');
  });
  await expect(toggle).toHaveCSS('color', 'rgb(192, 193, 194)');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(overlay).toHaveCount(0);
  await expect(toggle).toHaveCSS('color', 'rgb(240, 45, 115)');
  await expect(toggle.locator('svg')).toHaveCSS('color', 'rgb(240, 45, 115)');
  await testInfo.attach('archive-webtoon-minibar', { body: await page.screenshot(), contentType: 'image/png' });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('viewer_settings')!).archiveWebtoonMode)).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('viewer_settings')!).navMode)).toBe('left-right');
  // Close the toolbar and exercise native wheel scrolling inside the iframe.
  await page.locator('[data-reader-controls-overlay]').click({ position: { x: 500, y: 350 } });
  const probe = () => page.evaluate(() => {
    const view = document.querySelector('foliate-view') as HTMLElement & {
      renderer: HTMLElement & { index: number; getWebtoonBoundary(direction: number): boolean };
    };
    if (!view?.renderer) return { index: -1, top: -1, bottom: false, webtoon: null };
    return { index: view.renderer.index, top: view.renderer.scrollTop, bottom: view.renderer.getWebtoonBoundary(1), webtoon: view.renderer.getAttribute('webtoon') };
  });
  await page.mouse.move(500, 350);
  await page.mouse.wheel(0, 400);
  await expect.poll(async () => (await probe()).top).toBeGreaterThan(0);
  expect((await probe()).index).toBe(0);
  // Continuing the same gesture past the bottom turns, without an idle/restart.
  await page.mouse.wheel(0, 2800);
  await expect.poll(async () => (await probe()).index).toBe(1);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 550 }] });
  for (let index = 1; index <= 4; index++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 500, y: 550 - index * 40 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const fingerPosition = (await probe()).top;
  await expect.poll(async () => (await probe()).top).toBeGreaterThan(fingerPosition);
  await page.mouse.click(500, 350);
  await expect(toggle).toBeVisible();
  const savedPage = () => page.evaluate(async () => {
    const open = indexedDB.open('web-reader-db');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const request = db.transaction('progress-v5', 'readonly').objectStore('progress-v5').getAll();
    const rows = await new Promise<Array<{ cfi?: string }>>(resolve => { request.onsuccess = () => resolve(request.result); });
    db.close();
    return rows;
  });
  const expectedCfi = await page.evaluate(() => (document.querySelector('foliate-view') as HTMLElement & { lastLocation: { cfi: string } }).lastLocation.cfi);
  await expect.poll(async () => (await savedPage()).some(row => row.cfi === expectedCfi)).toBe(true);
  // A new reader instance restores the same image through the existing page CFI.

  await page.reload();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(overlay).toHaveCount(0);
  await expect.poll(probe).toMatchObject({ index: 1, webtoon: 'true' });
  // A fresh reader has no dirty progress. Zoomed panning across an image
  // boundary must mark the gesture as a user move before relocate is handled.
  await page.keyboard.press('Control+ArrowUp');
  await page.mouse.move(500, 300);
  await page.mouse.down();
  await page.mouse.move(500, 650, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await probe()).index).toBe(0);
  const panCfi = await page.evaluate(() => (document.querySelector('foliate-view') as HTMLElement & { lastLocation: { cfi: string } }).lastLocation.cfi);
  await expect.poll(async () => (await savedPage()).some(row => row.cfi === panCfi)).toBe(true);
  await page.mouse.click(500, 350);
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect.poll(probe).toMatchObject({ webtoon: 'false' });
  await expect(overlay).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('viewer_settings')!).navMode)).toBe('left-right');
});
