import { expect, test } from '@playwright/test';

test('additional bundled fonts decode Korean and Latin text', async ({ page }) => {
  await page.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto('/');
  for (const family of ['NanumSquare', 'GowunBatang', 'GowunDodum']) {
    await expect.poll(() => page.evaluate(async family => {
      const faces = await document.fonts.load(`20px "${family}"`, '가나다라마바사 ABC123');
      return faces.some(face => face.family.includes(family) && face.status === 'loaded');
    }, family)).toBe(true);
  }
});

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
  const disclosure = page.getByRole('button', { name: '글자 크기 상세 펼치기', exact: true });
  // Accent tokens may be scoped to the reader rather than the document root.
  // Both the control and its currentColor SVG must follow that local theme.
  const reader = page.locator('[data-reader-shell]');
  const savedStyle = await reader.getAttribute('style');
  for (const color of ['rgb(225, 29, 72)', 'rgb(212, 175, 55)']) {
    await reader.evaluate((element, accent) => (element as HTMLElement).style.setProperty('--accent-500', accent), color);
    await expect(disclosure).toHaveCSS('color', color);
    await expect(disclosure.locator('svg')).toHaveCSS('stroke', color);
  }
  await reader.evaluate((element, style) => {
    if (style === null) element.removeAttribute('style');
    else element.setAttribute('style', style);
  }, savedStyle);
  const row = page.locator('[data-reader-font-options]');
  await expect(row.locator('button')).toHaveText(['리디 바탕', '조선 명조', '조선 굴림', '나눔스퀘어', '고운바탕', '고운돋움', 'SANS']);
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
  await page.getByRole('button', { name: '글자 크기 상세 펼치기', exact: true }).click();
  await expect(page.getByRole('button', { name: '글자 크기 상세 접기', exact: true })).toHaveAttribute('aria-expanded', 'true');
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
  await page.getByRole('button', { name: '자동읽기 닫기', exact: true }).click();
  const selectedBookFontIsLoaded = (family: string) => page.evaluate(async family => {
    const view = document.querySelector('foliate-view') as HTMLElement & { renderer?: { getContents(): Array<{ doc: Document }> } };
    const doc = view?.renderer?.getContents()[0]?.doc;
    if (!doc || !doc.defaultView?.getComputedStyle(doc.body).fontFamily.includes(family)) return false;
    await doc.fonts.ready;
    return [...doc.fonts].some(font => font.family.includes(family) && font.status === 'loaded');
  }, family);
  for (const [label, family, key] of [
    ['나눔스퀘어', 'NanumSquare', 'nanumSquare'],
    ['고운바탕', 'GowunBatang', 'gowunBatang'],
    ['고운돋움', 'GowunDodum', 'gowunDodum'],
  ]) {
    if (!await settings.isVisible()) await page.locator('[data-reader-content]').click({ position: { x: 150, y: 350 } });
    await settings.click();
    await row.getByRole('button', { name: label, exact: true }).click();
    await expect.poll(() => selectedBookFontIsLoaded(family), { timeout: 30000 }).toBe(true);
    await page.getByRole('button', { name: '리더 설정 닫기', exact: true }).click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('viewer_settings')!).fontFamily)).toBe(key);
    if (!await autoRead.isVisible()) await page.locator('[data-reader-content]').click({ position: { x: 150, y: 350 } });
    await autoRead.click();
    await expect(page.locator('[data-auto-read-stage]')).toHaveCSS('font-family', new RegExp(family));
    await expect.poll(() => page.evaluate(async family => {
      await document.fonts.ready;
      return [...document.fonts].some(font => font.family.includes(family) && font.status === 'loaded');
    }, family)).toBe(true);
    await page.getByRole('button', { name: '자동읽기 닫기', exact: true }).click();
  }
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(async () => (
    await Promise.all(['/fonts/NanumSquareR.woff', '/fonts/GowunBatang-Regular.woff', '/fonts/GowunDodum-Regular.woff'].map(url => caches.match(url)))
  ).every(Boolean))).toBe(true);
  // A newly installed worker controls the next navigation, not this first tab.
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.locator('[data-shelf-book-id]').first().click();
  await expect(page.getByText('Loading...', { exact: true })).toBeHidden({ timeout: 30000 });
  await expect.poll(() => selectedBookFontIsLoaded('GowunDodum'), { timeout: 30000 }).toBe(true);
  await page.context().setOffline(true);
  // Bypass HTTP cache and load fresh FontFace instances from the worker's
  // cached responses, independent of the document's already loaded fonts.
  expect(await page.evaluate(async () => {
    return Promise.all(['/fonts/NanumSquareR.woff', '/fonts/GowunBatang-Regular.woff', '/fonts/GowunDodum-Regular.woff'].map(async (url, index) => {
      const response = await fetch(url, { cache: 'no-store' });
      const font = new FontFace(`OfflineProbe${index}`, await response.arrayBuffer());
      await font.load();
      return response.ok && font.status === 'loaded';
    }));
  })).toEqual([true, true, true]);
  await page.context().setOffline(false);
});

test('Korean spacing controls apply and persist seven levels without texturing dialogs', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit' && process.platform === 'darwin', 'Local macOS WebKit cannot persist the sample EPUB Blob.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('neverShowInstallPrompt', 'true');
    localStorage.setItem('viewer_settings', JSON.stringify({
      theme: 'custom:spacing', autoOpenLastBook: false,
      customThemes: [{ id: 'custom:spacing', title: 'Spacing', bgColor: '#141517', textColor: '#eeeeee', texture: 'grid', accentColor: 'rose' }],
    }));
  });
  await page.reload();
  await expect(page.locator('[data-app-view="shelf"]')).not.toHaveCSS('background-image', 'none');
  await page.locator('[data-shelf-filter-control]:visible').first().click();
  await expect(page.locator('[data-menu-sheet="true"]')).toHaveCSS('background-image', 'none');
  await page.getByRole('button', { name: '책장 정렬·필터 닫기', exact: true }).click();
  await page.getByRole('button', { name: '샘플 도서를 추가', exact: true }).click();
  await page.locator('[data-shelf-book-id]').first().click();
  await expect(page.getByText('Loading...', { exact: true })).toBeHidden({ timeout: 30000 });
  const openSettings = async () => {
    const open = page.getByRole('button', { name: '설정', exact: true });
    if (!await open.isVisible()) await page.locator('[data-reader-content]').click({ position: { x: 180, y: 300 } });
    await open.click();
    await page.getByRole('button', { name: '글자 크기 상세 펼치기', exact: true }).click();
  };
  await openSettings();
  const dialog = page.getByRole('dialog', { name: '리더 설정', exact: true });
  await expect(dialog).toHaveCSS('background-image', 'none');
  await expect(page.locator('[data-reader-shell]')).not.toHaveCSS('background-image', 'none');
  await expect(page.locator('[data-reader-settings-navigation] button')).toHaveText(['스크롤', '상/하', '좌/우', '4방향']);
  for (const label of ['열람방식', '글꼴', '글자 크기', '단락 간격', '줄간격', '상/하 탭 영역', '좌/우 탭 영역']) {
    await expect(dialog.getByText(label, { exact: true })).toBeVisible();
  }
  const horizontalMinus = dialog.getByRole('button', { name: '좌/우 여백 줄이기', exact: true });
  const horizontalPlus = dialog.getByRole('button', { name: '좌/우 여백 늘리기', exact: true });
  const verticalMinus = dialog.getByRole('button', { name: '상/하 여백 줄이기', exact: true });
  const verticalPlus = dialog.getByRole('button', { name: '상/하 여백 늘리기', exact: true });
  await expect(horizontalMinus.locator('../..')).toContainText('4/7');
  await expect(verticalMinus.locator('../..')).toContainText('4/7');
  await expect(page.locator('[data-reader-content]')).toHaveCSS('padding-top', '24px');
  await horizontalPlus.click();
  await verticalMinus.click();
  const rendererMargin = () => page.evaluate(() => (
    document.querySelector('foliate-view') as HTMLElement & { renderer?: HTMLElement }
  )?.renderer?.getAttribute('outside-margin'));
  await expect.poll(rendererMargin).toBe('6%');
  await expect(page.locator('[data-reader-content]')).toHaveCSS('padding-top', '20px');
  for (let i = 0; i < 4; i++) await horizontalMinus.click();
  await expect(horizontalMinus).toBeDisabled();
  await expect(horizontalMinus.locator('../..')).toContainText('1/7');
  await expect.poll(rendererMargin).toBe('2%');
  for (let i = 0; i < 6; i++) await horizontalPlus.click();
  await expect(horizontalPlus).toBeDisabled();
  await expect(horizontalPlus.locator('../..')).toContainText('7/7');
  for (let i = 0; i < 2; i++) await verticalMinus.click();
  await expect(verticalMinus).toBeDisabled();
  await expect(page.locator('[data-reader-content]')).toHaveCSS('padding-bottom', '12px');
  for (let i = 0; i < 6; i++) await verticalPlus.click();
  await expect(verticalPlus).toBeDisabled();
  await expect(page.locator('[data-reader-content]')).toHaveCSS('padding-bottom', '36px');
  await dialog.getByRole('button', { name: '리더 설정 닫기', exact: true }).click();
  await page.reload();
  await page.locator('[data-shelf-book-id]').first().click();
  await expect(page.getByText('Loading...', { exact: true })).toBeHidden({ timeout: 30000 });
  await openSettings();
  await expect(horizontalPlus).toBeDisabled();
  await expect(verticalPlus).toBeDisabled();
  await expect.poll(rendererMargin).toBe('8%');
  await expect(page.locator('[data-reader-content]')).toHaveCSS('padding-top', '36px');
});
