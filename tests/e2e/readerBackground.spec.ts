import { expect, test } from '@playwright/test';

test('reader shell paints through the publication canvas and all outer margins', async ({ page, browserName }, testInfo) => {
  test.skip(browserName === 'webkit' && process.platform === 'darwin', 'Local macOS Playwright WebKit fails while storing the sample EPUB Blob, before reader startup. Transparent frame painting is covered by the standalone renderer test.');
  await page.setViewportSize({ width: 1280, height: 890 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('neverShowInstallPrompt', 'true');
    localStorage.setItem('viewer_settings', JSON.stringify({
      theme: 'midnight', navMode: 'left-right', landscapeTwoPage: true,
      fontFamily: 'sans', autoOpenLastBook: false,
    }));
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Guest Library', exact: true })).toBeVisible();
  // Open a real reader through the existing guest sample-book flow.
  await page.getByRole('button', { name: '샘플 도서를 추가', exact: true }).click();
  const card = page.locator('[data-shelf-book-id]').first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(page.locator('[data-reader-shell]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const view = document.querySelector('foliate-view') as HTMLElement & {
      renderer?: { getContents(): Array<{ doc: Document }> };
    };
    const doc = view?.renderer?.getContents()[0]?.doc;
    if (!doc) return null;
    const root = doc.defaultView!.getComputedStyle(doc.documentElement);
    const body = doc.defaultView!.getComputedStyle(doc.body);
    return { root: root.backgroundColor, body: body.backgroundColor, image: root.backgroundImage };
  })).toEqual({ root: 'rgba(0, 0, 0, 0)', body: 'rgba(0, 0, 0, 0)', image: 'none' });

  for (const [systemTheme, color] of [['dark', '#304050'], ['light', '#e8d6b4']] as const) {
    await page.emulateMedia({ colorScheme: systemTheme });
    // A different parent color must be visible through the frame immediately,
    // without synchronizing a second paint surface inside the iframe.
    await page.locator('[data-reader-shell]').evaluate((shell, color) => {
      (shell as HTMLElement).style.backgroundColor = color;
      (shell as HTMLElement).style.backgroundImage = 'none';
    }, color);
    const samplePoints = await page.evaluate(() => {
      const view = document.querySelector('foliate-view') as HTMLElement & {
        renderer: { getContents(): Array<{ doc: Document }> };
      };
      const doc = view.renderer.getContents()[0].doc;
      const frameTop = doc.defaultView!.frameElement!.getBoundingClientRect().top;
      // The top inset and first two pixels of the frame avoid book text.
      return [
        { x: 10, y: 2 },
        ...[10, 100, 620, 650, 720, 1260].map(x => ({ x, y: Math.round(frameTop) + 2 })),
      ];
    });
    const rgb = color.slice(1).match(/../g)!.map(hex => parseInt(hex, 16));
    let screenshot: Buffer;
    await expect.poll(async () => {
      screenshot = await page.screenshot({ scale: 'css' });
      return page.evaluate(async ({ data, points }) => {
        const img = new Image();
        img.src = data;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(img, 0, 0);
        return points.map(({ x, y }) => Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3));
      }, { data: `data:image/png;base64,${screenshot.toString('base64')}`, points: samplePoints });
    }).toEqual(samplePoints.map(() => rgb));
    await testInfo.attach(`reader-shell-${systemTheme}`, { body: screenshot!, contentType: 'image/png' });
  }
});
