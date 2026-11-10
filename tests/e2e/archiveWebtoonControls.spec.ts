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
  await expect(toggle).toHaveCSS('color', 'rgb(240, 45, 115)');
  await expect(toggle.locator('svg')).toHaveCSS('color', 'rgb(240, 45, 115)');
  await testInfo.attach('archive-webtoon-minibar', { body: await page.screenshot(), contentType: 'image/png' });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('viewer_settings')!).archiveWebtoonMode)).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('viewer_settings')!).navMode)).toBe('left-right');
  // Close the toolbar, then exercise the actual non-passive overlay wheel handler.
  await page.locator('[data-reader-controls-overlay]').click({ position: { x: 500, y: 350 } });
  const probe = () => page.evaluate(() => {
    const view = document.querySelector('foliate-view') as HTMLElement & {
      renderer: HTMLElement & { index: number; getWebtoonBoundary(direction: number): boolean };
    };
    return { index: view.renderer.index, top: view.renderer.scrollTop, bottom: view.renderer.getWebtoonBoundary(1), webtoon: view.renderer.getAttribute('webtoon') };
  });
  await overlay.dispatchEvent('wheel', { deltaY: 400, deltaMode: 0 });
  await expect.poll(async () => (await probe()).top).toBeGreaterThan(0);
  expect((await probe()).index).toBe(0);
  // Continuing the same gesture past the bottom turns, without an idle/restart.
  await overlay.dispatchEvent('wheel', { deltaY: 5000, deltaMode: 0 });
  await expect.poll(probe).toMatchObject({ index: 1, top: 0 });
  const touch = async (type: string, y: number) => overlay.evaluate((element, { type, y }) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const point = { clientX: 500, clientY: y };
    Object.defineProperties(event, {
      touches: { value: type === 'touchend' ? [] : [point] },
      changedTouches: { value: [point] },
    });
    element.dispatchEvent(event);
  }, { type, y });
  await touch('touchstart', 500);
  await page.waitForTimeout(16);
  await touch('touchmove', 400);
  const fingerPosition = (await probe()).top;
  await touch('touchend', 400);
  await expect.poll(async () => (await probe()).top).toBeGreaterThan(fingerPosition);
  // A swipe may produce no compatibility click. The next genuine tap still
  // opens the menu and stops the previous gesture's momentum.
  await touch('touchstart', 400);
  await touch('touchend', 400);
  await overlay.dispatchEvent('click');
  await expect(toggle).toBeVisible();
  // A new reader instance must restore the independent archive mode.
  await page.reload();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(overlay).toBeVisible({ timeout: 30_000 });
  await expect.poll(probe).toMatchObject({ webtoon: 'true' });
  await overlay.click({ position: { x: 500, y: 350 } });
  await toggle.click();
  await expect.poll(probe).toMatchObject({ webtoon: 'false' });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('viewer_settings')!).navMode)).toBe('left-right');
});
