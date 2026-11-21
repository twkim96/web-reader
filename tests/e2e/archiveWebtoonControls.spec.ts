import { expect, test } from './persistentBookFixtures';
import type { Page } from '@playwright/test';
import JSZip from 'jszip';

test.use({ serviceWorkers: 'block' });

const clickWebtoonCenter = (page: Page, browserName: string) => browserName === 'chromium'
  ? page.mouse.click(500, 350)
  // Route the tap through the publication document in headless WebKit.
  : page.evaluate(() => {
    const view = document.querySelector('foliate-view') as HTMLElement & {
      renderer: { getContents(): { doc: Document }[] };
    };
    const doc = view.renderer.getContents()[0].doc;
    doc.elementFromPoint(500, 350)?.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, clientX: 500, clientY: 350,
    }));
  });

test('archive minibar toggles webtoon independently and scrolling continues through the image edge', async ({ page, browserName }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.addInitScript(() => {
    if (window !== window.top || localStorage.getItem('isGuest') === 'true') return;
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('neverShowInstallPrompt', 'true');
    localStorage.setItem('viewer_settings', JSON.stringify({ navMode: 'left-right', archiveWebtoonMode: false, autoOpenLastBook: false }));
  });
  await page.goto('/');
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 1800;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#345678';
    context.fillRect(0, 0, 600, 1800);
    return canvas.toDataURL().split(',')[1];
  });
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
  // Close the toolbar before sending scroll input.
  await page.locator('[data-reader-controls-overlay]').click({ position: { x: 500, y: 350 } });
  const probe = () => page.evaluate(() => {
    const view = document.querySelector('foliate-view') as HTMLElement & {
      renderer: HTMLElement & { index: number; userScale: number; getWebtoonBoundary(direction: number): boolean };
    };
    if (!view?.renderer) return { index: -1, top: -1, bottom: false, webtoon: null };
    return { index: view.renderer.index, top: view.renderer.scrollTop, bottom: view.renderer.getWebtoonBoundary(1), webtoon: view.renderer.getAttribute('webtoon'), scale: view.renderer.userScale };
  });
  if (browserName === 'chromium') {
    await page.mouse.move(500, 350);
    await page.mouse.wheel(0, 400);
    await expect.poll(async () => (await probe()).top).toBeGreaterThan(0);
    expect((await probe()).index).toBe(0);
    // Continuing the same gesture past the bottom turns, without an idle/restart.
    await page.mouse.wheel(0, 2800);
    await expect.poll(async () => (await probe()).index).toBe(1);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    const touchStart = (await probe()).top;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 550 }] });
    for (let step = 1; step <= 4; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 500, y: 550 - step * 40 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => (await probe()).top).toBeGreaterThan(touchStart);

    const swipeDistance = 160;
    const fling = () => cdp.send('Input.synthesizeScrollGesture', {
      x: 500, y: 550, yDistance: -swipeDistance, speed: 2400,
      gestureSourceType: 'touch', preventFling: false,
    });
    // A plain sandboxed scroller establishes whether this headless browser
    // generates momentum at all, independently of reader gesture handlers.
    await page.evaluate(() => new Promise<void>((resolve) => {
      const control = document.createElement('div');
      control.id = 'touch-scroll-control';
      control.style.cssText = 'position:fixed;inset:0;z-index:2147483647';
      const iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-same-origin');
      iframe.style.cssText = 'display:block;width:100%;height:100%;border:0';
      iframe.srcdoc = '<!doctype html><style>html{overflow:auto;touch-action:pan-x pan-y;overscroll-behavior:contain}body{margin:0;height:6000px}</style>';
      iframe.onload = () => resolve();
      control.attachShadow({ mode: 'open' }).append(iframe);
      document.body.append(control);
    }));
    let controlDistance: number;
    try {
      await fling();
      controlDistance = await page.evaluate(() => new Promise<number>(resolve => {
        const frame = document.querySelector('#touch-scroll-control')!.shadowRoot!.querySelector('iframe')!;
        const scroller = frame.contentDocument!.scrollingElement!;
        // Allow time for compositor-delivered post-release scrolling.
        setTimeout(() => resolve(scroller.scrollTop), 400);
      }));
    } finally {
      await page.locator('#touch-scroll-control').evaluate(node => node.remove());
    }
    if (controlDistance > swipeDistance) {
      const swipeStart = (await probe()).top;
      await fling();
      await expect.poll(async () => (await probe()).top - swipeStart).toBeGreaterThan(swipeDistance);
    } else {
      console.info(`Headless Chromium touch control: ${controlDistance}px for a ${swipeDistance}px synthetic swipe. The raw touch-scroll assertion passed.`);
    }
  } else {
    // Playwright WebKit's synthetic wheel did not reach the sandboxed iframe.
    // Exercise the reader's keyboard scrolling through the same page boundary.
    await page.keyboard.press('PageDown');
    await expect.poll(probe).toMatchObject({ index: 0 });
    await expect.poll(async () => (await probe()).top).toBeGreaterThan(0);
    for (let press = 0; press < 5; press += 1) await page.keyboard.press('PageDown');
    await expect.poll(async () => (await probe()).index).toBe(1);
  }
  await clickWebtoonCenter(page, browserName);
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
  // The renderer reports its target index before the image opens and the reader installs its shortcuts.
  await expect(page.getByRole('status').filter({ hasText: '압축 파일 확인 중...' })).toBeHidden();
  if (browserName === 'chromium') {
    // Zoomed panning must mark a user move in a fresh reader before relocate.
    await page.keyboard.press('Control+ArrowUp');
    await expect.poll(async () => (await probe()).scale).toBeGreaterThan(1);
    await page.mouse.move(500, 300);
    await page.mouse.down();
    await page.mouse.move(500, 650, { steps: 6 });
    await page.mouse.up();
  } else {
    await page.keyboard.press('PageUp');
    await page.keyboard.press('PageUp');
  }
  await expect.poll(async () => (await probe()).index).toBe(0);
  const panCfi = await page.evaluate(() => (document.querySelector('foliate-view') as HTMLElement & { lastLocation: { cfi: string } }).lastLocation.cfi);
  await expect.poll(async () => (await savedPage()).some(row => row.cfi === panCfi)).toBe(true);
  await clickWebtoonCenter(page, browserName);
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect.poll(probe).toMatchObject({ webtoon: 'false' });
  await expect(overlay).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('viewer_settings')!).navMode)).toBe('left-right');
});
