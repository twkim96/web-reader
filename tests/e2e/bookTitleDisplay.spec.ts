import { expect, test } from '@playwright/test';

test('summary titles toggle live, persist, and leave book details and stored names intact', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit' && process.platform === 'darwin', 'Local macOS WebKit cannot persist the sample EPUB Blob.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('neverShowInstallPrompt', 'true');
    // An older installation has no title preference yet.
    localStorage.setItem('viewer_settings', JSON.stringify({ theme: 'midnight', autoOpenLastBook: false }));
  });
  await page.reload();
  await page.getByRole('button', { name: '샘플 도서를 추가', exact: true }).click();
  const card = page.locator('[data-shelf-book-id]').first();
  await expect(card).toBeVisible({ timeout: 30000 });
  const id = (await card.getAttribute('data-shelf-book-id'))!;
  const originalName = '예시 소설 001-215화 (완결).epub';
  const originalTitle = '예시 소설 001-215화 (완결)';
  // Only the isolated test profile's fixture is renamed; its EPUB bytes stay valid.
  await page.evaluate(async ({ id, name }) => {
    const open = indexedDB.open('web-reader-db');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction('metadata-v5', 'readwrite');
    const store = tx.objectStore('metadata-v5');
    const get = store.getAll();
    get.onsuccess = () => {
      for (const book of get.result) if (book.id === id) store.put({ ...book, name });
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { id, name: originalName });
  await page.reload();
  const renamedCard = page.locator(`[data-shelf-book-id="${id}"]`);
  await expect(page.getByRole('button', { name: '예시 소설 열기', exact: true })).toBeVisible();
  await renamedCard.locator('button[title="도서 정보"]').click();
  await expect(page.locator('[data-book-info-modal]').getByRole('heading', { name: originalTitle, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '도서 정보 닫기', exact: true }).click();
  await page.getByRole('button', { name: '예시 소설 열기', exact: true }).click();
  await expect(page.locator('[data-reader-shell]')).toBeVisible();
  await expect(page.getByText('Loading...', { exact: true })).toBeHidden({ timeout: 30000 });

  const openSettings = async () => {
    const button = page.getByRole('button', { name: '설정', exact: true });
    if (!await button.isVisible()) await page.locator('[data-reader-content]').click({ position: { x: 180, y: 300 } });
    await button.click();
  };
  await openSettings();
  const toggle = page.getByRole('checkbox', { name: '제목 요약으로 보기', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.getByRole('button', { name: '리더 설정 닫기', exact: true }).click();
  await expect(page.locator('[data-reader-title-surface]')).toHaveText(originalTitle);
  await page.getByRole('button', { name: 'Close reader', exact: true }).click();
  await expect(page.getByRole('button', { name: `${originalTitle} 열기`, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: `${originalTitle} 열기`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `${originalTitle} 열기`, exact: true }).click();
  await expect(page.getByText('Loading...', { exact: true })).toBeHidden({ timeout: 30000 });
  await openSettings();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.getByRole('button', { name: '리더 설정 닫기', exact: true }).click();
  await expect(page.locator('[data-reader-title-surface]')).toHaveText('예시 소설');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('viewer_settings')!).summarizeBookTitles)).toBe(true);
  const storedNames = await page.evaluate(async id => {
    const open = indexedDB.open('web-reader-db');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const request = db.transaction('metadata-v5', 'readonly').objectStore('metadata-v5').getAll();
    const books = await new Promise<Array<{ id: string; name: string }>>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return books.filter(book => book.id === id).map(book => book.name);
  }, id);
  expect(storedNames.length).toBeGreaterThan(0);
  expect(storedNames.every(name => name === originalName)).toBe(true);
});
