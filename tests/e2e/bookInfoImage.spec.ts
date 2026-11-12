import { expect, test } from '@playwright/test';

// The existing shell regression captures generated covers. This case exercises
// a real cached JPEG, which the modal receives as a blob: object URL.
for (const offline of [false, true]) {
  test(`book information exports a cached cover to PNG download and clipboard (${offline ? 'offline' : 'online'})`, async ({ page, context, browserName }) => {
    test.skip(browserName === 'webkit' && process.platform === 'darwin', 'Local macOS WebKit cannot persist the sample book Blob before reader startup.');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('isGuest', 'true');
      localStorage.setItem('neverShowInstallPrompt', 'true');
      localStorage.setItem('viewer_settings', JSON.stringify({ theme: 'midnight', accentColor: 'rose', autoOpenLastBook: false }));
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Guest Library', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '샘플 도서를 추가', exact: true }).click();
    const card = page.locator('[data-shelf-book-id]').first();
    await expect(card).toBeVisible({ timeout: 30000 });
    const id = await card.getAttribute('data-shelf-book-id');
    await page.evaluate(async id => {
      const open = indexedDB.open('web-reader-db');
      const db = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
      const metadata = db.transaction('metadata-v5', 'readonly').objectStore('metadata-v5').getAll();
      const records = await new Promise<Array<{ id: string; md5Checksum?: string; modifiedTime?: string; size?: number | string }>>(resolve => { metadata.onsuccess = () => resolve(metadata.result); });
      const book = records.find(book => book.id === id)!;
      const checksum = book.md5Checksum?.trim().toLowerCase();
      const fingerprint = checksum ? `md5:${checksum}` : book.modifiedTime && book.size != null ? `metadata:${book.modifiedTime}:${Number(book.size)}` : null;
      const canvas = document.createElement('canvas');
      canvas.width = 96; canvas.height = 144;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#17db45'; context.fillRect(0, 0, 96, 144);
      const image = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/jpeg'));
      const tx = db.transaction('book-covers-v14', 'readwrite');
      tx.objectStore('book-covers-v14').put({ ownerKey: 'guest:device-library|library:local', bookId: id, fingerprint, image, cachedAt: Date.now() });
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
      db.close();
      window.dispatchEvent(new CustomEvent('web-reader-book-cover-cache-change', { detail: { bookId: id } }));
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        write: async (items: ClipboardItem[]) => {
          Reflect.set(window, '__proofClipboardPNG', await items[0].getType('image/png'));
        },
      } });
    }, id);
    await card.locator('button[title="도서 정보"]').click();
    const modal = page.locator('[data-book-info-modal]');
    await expect(modal.locator('[data-book-info-cover]')).toHaveAttribute('src', /^blob:/);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (offline) await context.setOffline(true);
    await modal.locator('[data-book-info-copy-image]').click();
    await expect(modal.locator('[data-book-info-capture-status]')).toHaveText('독서 인증 이미지를 클립보드에 저장했습니다.', { timeout: 15000 });
    const png = await page.evaluate(async () => {
      const blob = Reflect.get(window, '__proofClipboardPNG') as Blob;
      const image = new Image(); image.src = URL.createObjectURL(blob); await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let coverPixels = 0;
      for (let index = 0; index < data.length; index += 4) if (data[index] < 55 && data[index + 1] > 190 && data[index + 2] < 100) coverPixels++;
      URL.revokeObjectURL(image.src);
      return { type: blob.type, size: blob.size, width: canvas.width, height: canvas.height, coverPixels };
    });
    expect(png.type).toBe('image/png'); expect(png.size).toBeGreaterThan(1000); expect(png.coverPixels).toBeGreaterThan(1000);
    const download = page.waitForEvent('download');
    await modal.locator('[data-book-info-capture]').click();
    expect((await download).suggestedFilename()).toMatch(/\.png$/);
    await expect(modal.locator('[data-book-info-capture-status]')).toHaveText('독서 인증 이미지를 다운로드했습니다.');
  });
}
