import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test('My Page brings its back button, menu and shortcuts together on scroll', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 700 });
  await page.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.addInitScript(() => {
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('neverShowInstallPrompt', 'true');
    localStorage.setItem('web_reader_guest_install_id', 'header-test');
    const owner = encodeURIComponent('guest:header-test|library:local');
    for (let index = 0; index < 20; index++) {
      const id = `saved-${index}`;
      const book = { id, title: `관심 도서 ${index}`, coverUrl: null, platforms: [], genre: null, tags: [], popularity: null, sourceCount: null };
      localStorage.setItem(`reader_wishlist_v1:${owner}:${id}`, JSON.stringify({ book, addedAt: index }));
    }
  });
  await page.route('**/catalog/discovery.v1.json', route => route.fulfill({ json: {
    schemaVersion: 1, generation: 'header-test', genres: [], tags: [],
    books: Array.from({ length: 75 }, (_, index) => [
      `menu-test-${index}`, `테스트 도서 ${index}`, null,
      [['series', `https://example.test/book/${index}`], ['kakao', `https://example.test/kakao/${index}`]], null, [], 100 - index, null,
    ]),
  } }));
  await page.route('**/api/book-reviews?*', route => route.fulfill({ json: {
    ratingCount: 20, average: 4,
    reviews: Array.from({ length: 20 }, (_, index) => ({
      rating: 4, comment: `테스트 평가 ${index}`, totalMs: null, progressPercent: null,
      author: { code: `000000${String(index).padStart(2, '0')}`, nickname: `독자 ${index}` },
    })),
  } }));

  await page.goto('/#mypage/discover');
  const back = page.getByRole('button', { name: '서재로 돌아가기' });
  const menu = page.getByRole('navigation', { name: '마이페이지 메뉴' });
  const shortcuts = page.getByRole('group', { name: '마이페이지 바로가기' });
  await expect(shortcuts.getByRole('button')).toHaveCount(2);
  await expect(shortcuts.getByRole('button', { name: '내 서재' })).toBeVisible();
  await expect(shortcuts.getByRole('button', { name: '공개 설정' })).toBeVisible();
  await expect(shortcuts).toHaveCSS('backdrop-filter', 'none');
  const dividers = page.locator('[data-mypage-header-divider]');
  const catalog = menu.getByRole('button', { name: '도서목록' });
  await expect(catalog).toHaveAttribute('aria-current', 'page');
  await expect(menu.getByRole('button')).toHaveText(['대시보드', '도서목록', '둘러보기', '읽은 책', /^위시리스트/, '통계', '주석']);
  const firstBook = page.getByRole('link', { name: '테스트 도서 0', exact: true });
  await expect(firstBook).toBeVisible();
  const geometry = () => page.locator('[data-mypage-menu]').evaluate((bar) => {
    const { top } = bar.getBoundingClientRect();
    const button = bar.querySelector('button')!.getBoundingClientRect();
    const menu = bar.querySelector('nav')!.getBoundingClientRect();
    const shortcuts = bar.querySelector('[role="group"]')!.getBoundingClientRect();
    return {
      pinned: Math.abs(top) < 1,
      twoRows: button.bottom <= menu.top && shortcuts.bottom <= menu.top,
      inline: button.right <= menu.left && menu.right <= shortcuts.left
        && Math.abs(button.top - menu.top) < 1 && Math.abs(shortcuts.top - menu.top) < 1,
    };
  });

  for (const width of [320, 393, 1280]) {
    await page.setViewportSize({ width, height: 700 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(geometry).toMatchObject({ pinned: false, twoRows: true });
    await expect(dividers).toHaveCount(0);
    const backColor = await back.evaluate(button => getComputedStyle(button).color);
    await expect(shortcuts.getByRole('button', { name: '내 서재' })).toHaveCSS('color', backColor);
    await expect(shortcuts.getByRole('button', { name: '공개 설정' })).toHaveCSS('color', backColor);
    await assertDivider(firstBook.locator('..'));
    await expect(menu.getByText('대시보드')).not.toHaveClass('sr-only');
    const collapseAt = await page.locator('[data-my-page] > header').evaluate((header) => header.getBoundingClientRect().height / 2);
    await page.evaluate((height) => window.scrollTo(0, height - 1), collapseAt);
    await expect(page.locator('[data-mypage-menu]')).toHaveAttribute('data-mypage-menu', 'expanded');
    await page.evaluate((height) => window.scrollTo(0, height), collapseAt);
    await expect.poll(geometry).toMatchObject({ pinned: true, inline: true });
    await expect(dividers).toHaveCount(1);
    const line = await dividers.boundingBox();
    const shortcutsBox = await shortcuts.boundingBox();
    const menuBox = await menu.boundingBox();
    expect(line!.x).toBeGreaterThanOrEqual(menuBox!.x + menuBox!.width);
    expect(line!.x + line!.width).toBeLessThanOrEqual(shortcutsBox!.x);
    await page.evaluate((height) => window.scrollTo(0, height - 1), collapseAt);
    await expect(page.locator('[data-mypage-menu]')).toHaveAttribute('data-mypage-menu', 'expanded');
    await page.evaluate(() => window.scrollTo(0, 500));
    await expect.poll(geometry).toMatchObject({ pinned: true, inline: true });
    await expect(catalog.getByText('도서목록')).not.toHaveClass('sr-only');
    await expect(menu.getByText('대시보드')).toHaveClass('sr-only');
  }

  await page.setViewportSize({ width: 393, height: 700 });
  await expect.poll(geometry).toMatchObject({ pinned: true, inline: true });
  await page.locator('[data-mypage-menu]').evaluate((bar) =>
    Promise.allSettled(bar.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  const before = await back.boundingBox();
  const shortcutsBefore = await shortcuts.boundingBox();
  await menu.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  expect(await menu.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  expect(await back.boundingBox()).toEqual(before);
  expect(await shortcuts.boundingBox()).toEqual(shortcutsBefore);

  await firstBook.click();
  await expect(page.getByRole('heading', { name: '도서 상세정보' })).toBeVisible();
  await expect(page.getByText('테스트 평가 19')).toBeAttached();
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(geometry).toMatchObject({ pinned: true, inline: true });
  await page.getByRole('button', { name: '도서 목록으로 돌아가기' }).click();
  await expect(page).toHaveURL(/#mypage\/discover$/);
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(geometry).toMatchObject({ pinned: true, inline: true });
  const read = menu.getByRole('button', { name: '읽은 책' });
  await read.click();
  await expect(read).toHaveAttribute('aria-current', 'page');
  await page.setViewportSize({ width: 320, height: 700 });
  await menu.getByRole('button', { name: /^위시리스트/ }).click();
  const savedBook = page.getByRole('link', { name: '관심 도서 0', exact: true });
  await expect(savedBook).toBeAttached();
  await assertDivider(savedBook.locator('..'));
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(geometry).toMatchObject({ pinned: false, twoRows: true });
  await menu.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(geometry).toMatchObject({ pinned: true, inline: true });
  await expect(menu.getByText('위시리스트', { exact: true })).not.toHaveClass('sr-only');
  await expect(menu.getByText('읽은 책', { exact: true })).toHaveClass('sr-only');
  await expect.poll(() => menu.evaluate((nav) => {
    const selected = nav.querySelector('[aria-current="page"]')!.getBoundingClientRect();
    const bounds = nav.getBoundingClientRect();
    return selected.left >= bounds.left - 1 && selected.right <= bounds.right + 1;
  })).toBe(true);
  await shortcuts.getByRole('button', { name: '공개 설정' }).click();
  await expect(page).toHaveURL(/#mypage\/sharing$/);
  await catalog.click();
  const search = page.getByRole('textbox', { name: '도서 제목 검색' });
  await expect(firstBook).toBeVisible();
  const match = page.getByRole('link', { name: '테스트 도서 72', exact: true });
  await expect(match).toHaveCount(0);
  await search.fill('테스트 도서 72');
  await expect(match).toBeVisible();
  await expect(firstBook).toHaveCount(0);
  await assertDashboardCovers(page, menu.getByRole('button', { name: '대시보드' }));
  await shortcuts.getByRole('button', { name: '내 서재' }).click();
  await expect(page.getByRole('heading', { name: 'Guest Library', exact: true })).toBeVisible();
  await page.goto('/#mypage/book/menu-test-0/review');
  const reviewHeading = page.getByRole('heading', { name: '내 평가', exact: true });
  await expect(reviewHeading).toBeFocused();
  await expect(reviewHeading).toBeInViewport();
  await assertDivider(page.getByRole('region', { name: '다른 독자의 평가' }).getByRole('listitem').first());
  const storefront = page.getByRole('link', { name: '네이버 시리즈', exact: true }).locator('..');
  await assertDivider(storefront);
  await page.setViewportSize({ width: 1280, height: 700 });
  await expect(storefront).toHaveCSS('position', 'relative');
  expect(await storefront.evaluate(item => getComputedStyle(item, '::after').display)).toBe('none');
  await page.setViewportSize({ width: 393, height: 700 });
  await assertOtherDividerLists(page, menu);
  const publicBooks = [0, 1].map(index => ({ workId: `public-${index}`, title: `공개 도서 ${index}`, coverUrl: null }));
  await page.route('**/api/mypage?view=profile&code=*', route => route.fulfill({ json: {
    identity: { code: '00000001', nickname: '독자' }, visibility: { wishlist: true, reviews: true },
    wishlist: publicBooks, reviews: publicBooks.map(item => ({ ...item, rating: 5, comment: '' })),
  } }));
  await page.goto('/people/00000001');
  for (const name of ['위시리스트', '별점 및 평가']) {
    await assertDivider(page.getByRole('region', { name }).getByRole('listitem').first());
  }
});

async function assertDivider(row: Locator) {
  const geometry = await row.evaluate(item => {
    const line = getComputedStyle(item, '::after');
    const box = item.getBoundingClientRect();
    const left = parseFloat(line.left);
    const width = parseFloat(line.width);
    const scroll = item.closest<HTMLElement>('[aria-label="독서 기록 목록"]');
    const scrollLeft = scroll?.getBoundingClientRect().left ?? 0;
    const scrollRight = scroll ? scrollLeft + scroll.clientWidth : innerWidth;
    const canvas = document.createElement('canvas').getContext('2d')!;
    canvas.fillStyle = line.backgroundColor;
    canvas.fillRect(0, 0, 1, 1);
    return {
      left, right: parseFloat(line.right), width, rowWidth: box.width, height: parseFloat(line.height),
      alpha: canvas.getImageData(0, 0, 1, 1).data[3], background: getComputedStyle(item).backgroundColor,
      clipped: box.left + left < scrollLeft || box.left + left + width > scrollRight,
      lastLine: getComputedStyle(item.parentElement!.lastElementChild!, '::after').content,
    };
  });
  expect(geometry.left).toBeLessThan(0);
  expect(geometry.right).toBeLessThan(0);
  expect(geometry.left).toBeCloseTo(geometry.right, 0);
  expect(geometry.width).toBeGreaterThan(geometry.rowWidth);
  expect(geometry.width - geometry.rowWidth).toBeLessThan(12);
  expect(geometry.height).toBeGreaterThan(0);
  expect(geometry.alpha).toBeGreaterThan(0);
  expect(geometry.alpha).toBeLessThan(64);
  expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
  expect(geometry.clipped).toBe(false);
  expect(geometry.lastLine).toBe('none');
}

async function assertOtherDividerLists(page: Page, menu: Locator) {
  await page.evaluate(async () => {
    const request = indexedDB.open('web-reader-db');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stats = 'reading-sessions-v11';
    const notes = 'annotations-v8';
    const tx = db.transaction([stats, notes], 'readwrite');
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    const localDate = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    for (let i = 0; i < 3; i++) {
      const startedAtClient = date.getTime() + i * 90_000;
      const bookId = `divider-${i}`;
      const ownerKey = 'guest:header-test|library:local';
      tx.objectStore(stats).put({
        ownerKey, sessionId: bookId, bookId, bookTitle: bookId, schemaVersion: 1, deviceId: 'fixture',
        mode: 'screen', startedAtClient, endedAtClient: startedAtClient + 60_000, durationMs: 60_000,
        startProgressPercent: 0, endProgressPercent: 5, timezoneOffsetMinutes: date.getTimezoneOffset(), localDate,
        completed: false, syncState: 'synced', retryCount: 0, nextAttemptAt: 0, lastErrorCode: null,
      });
      tx.objectStore(notes).put({
        ownerKey, id: bookId, bookId, type: 'highlight', sectionIndex: 0, rangeCfi: 'epubcfi(/6/2!/4/2,/1:1,/1:2)',
        quote: bookId, prefix: '', suffix: '', colorId: 'yellow', note: '', progressPercent: 50, chapter: '',
        createdAtClient: startedAtClient, updatedAtClient: startedAtClient, anchorState: 'active',
      });
    }
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  });
  for (const [tab, selector] of [
    ['대시보드', '[aria-label="독서 기록 목록"] li'],
    ['통계', '[data-reading-statistics-book]'],
    ['주석', '[data-library-annotation-item]'],
  ]) {
    await menu.getByRole('button', { name: tab, exact: true }).click();
    const rows = page.locator(selector);
    await expect(rows).toHaveCount(3);
    await assertDivider(rows.first());
  }
}

async function assertDashboardCovers(page: Page, dashboard: Locator) {
  await page.route('**/api/mypage?*', route => route.fulfill({ json: { groups: [{
    reader: { code: '00000001', nickname: '독자' },
    books: [{ workId: 'sample', title: '비교 도서', coverUrl: null, rating: 5 }],
  }], next: null } }));
  await page.getByRole('button', { name: '둘러보기', exact: true }).click();
  const coverSize = () => page.locator('[data-dashboard-book-row] a > div').first().evaluate(cover => {
    const { width, height } = cover.getBoundingClientRect();
    return { width, height };
  });
  await expect(page.getByRole('link', { name: '비교 도서' })).toBeVisible();
  const browse = await coverSize();
  await dashboard.click();
  await expect(page.locator('[data-dashboard-book-row] a').first()).toBeVisible();
  const compact = await coverSize();
  expect(compact.width / browse.width).toBeCloseTo(0.7, 2);
  expect(compact.height / browse.height).toBeCloseTo(0.7, 2);
  expect(compact.width / compact.height).toBeCloseTo(2 / 3, 2);
}
