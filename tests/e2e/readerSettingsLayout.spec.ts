import { expect, test } from '@playwright/test';

test('reader fonts stay on one scrollable row and selected local font reaches the book', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit' && process.platform === 'darwin', 'Local macOS WebKit cannot persist the sample EPUB Blob.');
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('neverShowInstallPrompt', 'true');
    localStorage.setItem('viewer_settings', JSON.stringify({ theme: 'midnight', fontFamily: 'ridi', autoOpenLastBook: false }));
  });
  await page.reload();
  await page.getByRole('button', { name: '샘플 도서를 추가', exact: true }).click();
  await page.locator('[data-shelf-book-id]').first().click();
  await expect(page.locator('[data-reader-shell]')).toBeVisible();
  await expect(page.getByText('Loading...', { exact: true })).toBeHidden({ timeout: 30000 });
  const settings = page.getByRole('button', { name: '설정', exact: true });
  if (!await settings.isVisible()) await page.locator('[data-reader-content]').click({ position: { x: 150, y: 350 } });
  await settings.click();
  const row = page.locator('[data-reader-font-options]');
  await expect(row.locator('button')).toHaveText(['리디 바탕', '조선 명조', '조선 굴림', 'SANS']);
  const geometry = await row.evaluate(element => ({
    tops: [...element.children].map(button => button.getBoundingClientRect().top),
    scrollable: element.scrollWidth > element.clientWidth,
    scrollbar: getComputedStyle(element).scrollbarWidth,
  }));
  expect(new Set(geometry.tops).size).toBe(1);
  expect(geometry.scrollable).toBe(true);
  expect(geometry.scrollbar).toBe('none');
  const rowBounds = (await row.boundingBox())!;
  const start = { x: rowBounds.x + rowBounds.width * 0.8, y: rowBounds.y + rowBounds.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 130, start.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => row.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await expect(row.getByRole('button', { name: '리디 바탕', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await row.getByRole('button', { name: 'SANS', exact: true }).focus();
  await row.getByRole('button', { name: 'SANS', exact: true }).press('Enter');
  await expect(row.getByRole('button', { name: 'SANS', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await row.getByRole('button', { name: '조선 명조', exact: true }).click();
  await expect(row.getByRole('button', { name: '조선 명조', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(async () => {
    const view = document.querySelector('foliate-view') as HTMLElement & { renderer?: { getContents(): Array<{ doc: Document }> } };
    const doc = view?.renderer?.getContents()[0]?.doc;
    if (!doc || !doc.defaultView?.getComputedStyle(doc.body).fontFamily.includes('ChosunilboNM')) return false;
    await doc.fonts.ready;
    return [...doc.fonts].some(font => font.family.includes('ChosunilboNM') && font.status === 'loaded');
  }), { timeout: 30000 }).toBe(true);
  await row.getByRole('button', { name: '조선 굴림', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const view = document.querySelector('foliate-view') as HTMLElement & { renderer?: { getContents(): Array<{ doc: Document }> } };
    const doc = view?.renderer?.getContents()[0]?.doc;
    if (!doc || !doc.defaultView?.getComputedStyle(doc.body).fontFamily.includes('ChosunGu')) return false;
    await doc.fonts.ready;
    return [...doc.fonts].some(font => font.family.includes('ChosunGu') && font.status === 'loaded');
  }), { timeout: 30000 }).toBe(true);
  await page.getByRole('button', { name: 'Expand size details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Collapse size details', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: '리더 설정 닫기', exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('viewer_settings')!).fontFamily)).toBe('chosunGu');
  const autoRead = page.getByRole('button', { name: '현재 위치부터 자동읽기', exact: true });
  if (!await autoRead.isVisible()) await page.locator('[data-reader-content]').click({ position: { x: 150, y: 350 } });
  await autoRead.click();
  await expect(page.locator('[data-auto-read-stage]')).toHaveCSS('font-family', /ChosunGu/);
  await expect.poll(() => page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].some(font => font.family.includes('ChosunGu') && font.status === 'loaded');
  })).toBe(true);
});
