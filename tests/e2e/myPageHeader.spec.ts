import { expect, test } from '@playwright/test';

test('My Page brings its back button, menu and shortcuts together on scroll', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 700 });
  await page.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.addInitScript(() => {
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('neverShowInstallPrompt', 'true');
  });
  await page.route('**/catalog/discovery.v1.json', route => route.fulfill({ json: {
    schemaVersion: 1, generation: 'header-test', genres: [], tags: [],
    books: Array.from({ length: 50 }, (_, index) => [
      `menu-test-${index}`, `테스트 도서 ${index}`, null, [['series', `https://example.test/book/${index}`]], null, [], 100 - index, null,
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
  await expect(shortcuts.getByRole('button')).toHaveCount(3);
  await expect(menu.getByRole('button', { name: '도서 탐색' })).toHaveCount(0);
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
    await expect(menu.getByText('대시보드')).not.toHaveClass('sr-only');
    await page.evaluate(() => window.scrollTo(0, 500));
    await expect.poll(geometry).toMatchObject({ pinned: true, inline: true });
    await expect(menu.getByText('대시보드')).toHaveClass('sr-only');
  }

  await page.setViewportSize({ width: 393, height: 700 });
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
  await shortcuts.getByRole('button', { name: '공개 설정' }).click();
  await expect(page).toHaveURL(/#mypage\/sharing$/);
  await shortcuts.getByRole('button', { name: '도서 탐색' }).click();
  await expect(firstBook).toBeVisible();
  await shortcuts.getByRole('button', { name: '내 서재' }).click();
  await expect(page.getByRole('heading', { name: 'Guest Library', exact: true })).toBeVisible();
});
