import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
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
  await page.route('https://covers.example.test/mypage-cover.png', route => route.fulfill({
    path: 'public/icon-192.png', contentType: 'image/png',
  }));
  await page.route('https://covers.example.test/missing-cover.png', route => route.fulfill({ status: 404 }));
  await page.route('**/catalog/discovery.v1.json', route => route.fulfill({ json: {
    schemaVersion: 1, generation: 'header-test', genres: [], tags: [],
    books: Array.from({ length: 75 }, (_, index) => [
      `menu-test-${index}`, `테스트 도서 ${index}`,
      index === 1 ? 'https://covers.example.test/mypage-cover.png'
        : index === 2 ? 'https://covers.example.test/missing-cover.png' : null,
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
});

test('book detail loads the catalog thumbnail directly and retries a denied original once', async ({ page }) => {
  const direct = 'https://comicthumb-phinf.pstatic.net/detail-cover.png?type=w160';
  const denied = 'https://dn-img-page.kakao.com/detail-denied.png';
  const image = { path: 'public/icon-192.png', contentType: 'image/png' };
  await page.route(direct, async route => {
    expect((await route.request().allHeaders()).referer).toBeUndefined();
    await route.fulfill(image);
  });
  await page.route(denied, route => route.fulfill({ status: 403 }));
  await page.route('**/catalog/discovery.v1.json', route => route.fulfill({ json: {
    schemaVersion: 1, generation: 'detail-cover', genres: [], tags: [],
    books: [
      ['detail-direct', '원본 표지 도서', direct, [['series', 'https://example.test/direct']], null, [], 10, null],
      ['detail-denied', '차단된 표지 도서', denied, [['kakao', 'https://example.test/denied']], null, [], 1, null],
    ],
  } }));
  const proxyCalls: string[] = [];
  await page.route('**/api/book-cover/source', route => {
    proxyCalls.push(route.request().postDataJSON().url);
    return route.fulfill(image);
  });

  await page.goto('/#mypage/discover');
  const catalogCover = page.getByRole('link', { name: '원본 표지 도서', exact: true });
  await expect(catalogCover.locator('img')).toHaveAttribute('src', direct);
  await catalogCover.click();
  const detailCover = page.getByRole('region', { name: '도서 기본정보' }).locator('img');
  await expect(detailCover).toHaveAttribute('src', direct);
  await expect.poll(() => detailCover.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  expect(proxyCalls).toEqual([]);

  await page.getByRole('button', { name: '도서 목록으로 돌아가기' }).click();
  await page.getByRole('link', { name: '차단된 표지 도서', exact: true }).click();
  await expect(detailCover).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => detailCover.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  expect(proxyCalls).toEqual([denied]);
});

test('home keeps a saved recommendation in place until leaving My Page', async ({ page }) => {
  await page.addInitScript(() => {
    const owner = encodeURIComponent('guest:header-test|library:local');
    const book = { id: 'saved-regression', title: '담은 회귀 도서', coverUrl: null, platforms: [], genre: null,
      tags: ['회귀'], popularity: 8_000, sourceCount: null };
    localStorage.setItem(`reader_wishlist_v1:${owner}:${book.id}`, JSON.stringify({ book, addedAt: Date.now() }));
  });
  let catalogRequests = 0;
  await page.route('**/catalog/discovery.v1.json', route => {
    catalogRequests += 1;
    return route.fulfill({ json: {
      schemaVersion: 1, generation: 'home-recommendations', genres: [], tags: ['회귀', '회귀물'],
      books: [
        ['saved-regression', '담은 회귀 도서', null, [['series', 'https://example.test/recommend/saved']], null, [0], 8_000, null],
        ['recommended-regression', '추천 회귀 도서', null, [['kakao', 'https://example.test/recommend/next']], null, [1], 5_000, null],
        ['another-regression', '다른 회귀 도서', null, [['series', 'https://example.test/recommend/other']], null, [0], 4_800, null],
        ['low-regression', '낮은 인기 회귀 도서', null, [['series', 'https://example.test/recommend/low']], null, [0], 4_000, null],
      ],
    } });
  });
  await page.goto('/#mypage/overview');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 2 }).filter({ hasText: /^(위시리스트|평점을 남긴 도서|추천 도서|읽은 도서)$/ }))
    .toHaveText(['위시리스트', '추천 도서', '평점을 남긴 도서', '읽은 도서']);
  const row = page.getByRole('list', { name: '추천 도서 가로 목록' });
  const cards = row.getByRole('link');
  await expect(cards).toHaveCount(2);
  const cardLinks = () => cards.evaluateAll(links => links.map(link => link.getAttribute('href')));
  const originalOrder = await cardLinks();
  const showAll = page.getByRole('button', { name: '추천 도서 전체 보기' });
  await showAll.click();
  await expect(page).toHaveURL(/#mypage\/recommendations$/);
  const full = page.getByRole('region', { name: '추천 도서 목록' });
  await expect(full.getByRole('link')).toHaveCount(2);
  expect(await full.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual(originalOrder);
  const sort = page.getByRole('combobox', { name: '추천 도서 정렬' });
  await sort.selectOption('popular');
  await expect(full.getByRole('link').first()).toHaveAccessibleName('추천 회귀 도서');
  await sort.selectOption('recommended');
  await page.getByRole('button', { name: '홈으로 돌아가기' }).click();
  await expect(page).toHaveURL(/#mypage\/overview$/);
  await row.getByRole('link', { name: '추천 회귀 도서', exact: true }).click();
  await expect(page).toHaveURL(/#mypage\/book\/recommended-regression$/);
  const menu = page.getByRole('navigation', { name: '마이페이지 메뉴', exact: true });
  await menu.getByRole('button', { name: '홈', exact: true }).click();
  await showAll.click();
  await full.getByRole('button', { name: '추천 회귀 도서 위시리스트 추가', exact: true }).click();
  await expect(full.getByRole('button', { name: '추천 회귀 도서 위시리스트 제거', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '홈으로 돌아가기' }).click();
  await expect(page.getByRole('list', { name: '위시리스트 가로 목록' }).getByRole('link', { name: '추천 회귀 도서', exact: true })).toBeVisible();
  await expect(cards).toHaveCount(2);
  expect(await cardLinks()).toEqual(originalOrder);
  await page.getByRole('button', { name: '내 서재', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Guest Library', exact: true })).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#mypage/overview'; });
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAccessibleName('다른 회귀 도서');
  expect(catalogRequests).toBe(1);
  await page.reload();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAccessibleName('다른 회귀 도서');

  const settings = page.getByRole('button', { name: '마이페이지 설정', exact: true });
  const toggle = page.getByRole('checkbox', { name: '추천 도서 보기', exact: true });
  await settings.click();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await menu.getByRole('button', { name: '홈', exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await settings.click();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await menu.getByRole('button', { name: '홈', exact: true }).click();
  await expect(cards.first()).toHaveAccessibleName('다른 회귀 도서');
});

test('mobile book detail scrolls related covers and opens the selected work from the same catalog', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  let catalogRequests = 0;
  const openedReviews = new Set<string>();
  await page.route('**/catalog/discovery.v1.json', route => {
    catalogRequests += 1;
    return route.fulfill({ json: {
      schemaVersion: 1, generation: 'related-books', genres: [], tags: ['모험'],
      books: Array.from({ length: 15 }, (_, i) => [
        `related-${i}`, `모험 도서 ${i}`, null, [['series', `https://example.test/related/${i}`]], null, [0], 100 - i, null,
      ]),
    } });
  });
  await page.route('**/api/book-reviews?*', route => {
    const workId = new URL(route.request().url()).searchParams.get('workId');
    if (workId) openedReviews.add(workId);
    return route.fulfill({ json: { reviews: [], ratingCount: 0, average: null } });
  });

  await page.goto('/#mypage/book/related-0');
  const row = page.getByRole('list', { name: '연관 도서 가로 목록' });
  await expect(row.getByRole('link')).toHaveCount(12);
  await expect(row.getByRole('link', { name: '모험 도서 0' })).toHaveCount(0);
  expect(await row.evaluate(list => list.scrollWidth > list.clientWidth)).toBe(true);
  await row.scrollIntoViewIfNeeded();
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + box.width - 20, box.y + 25);
  await page.mouse.down();
  await page.mouse.move(box.x + 25, box.y + 25, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => row.evaluate(list => list.scrollLeft)).toBeGreaterThan(0);
  await expect(page).toHaveURL(/#mypage\/book\/related-0$/);
  await expect.poll(() => [...openedReviews]).toEqual(['related-0']);

  await row.getByRole('link', { name: '모험 도서 12', exact: true }).click();
  await expect(page.getByRole('region', { name: '도서 기본정보' }).getByRole('heading', { name: '모험 도서 12' })).toBeVisible();
  await expect.poll(() => [...openedReviews]).toEqual(['related-0', 'related-12']);
  await page.getByRole('button', { name: '도서 목록으로 돌아가기' }).click();
  await expect(page).toHaveURL(/#mypage\/book\/related-0$/);
  expect(catalogRequests).toBe(1);
});

test('a deep-linked book prepares catalog search only when the list opens', async ({ page }) => {
  await page.route('**/catalog/discovery.v1.json', route => route.fulfill({ json: {
    schemaVersion: 1, generation: 'catalog-preparation-test', genres: ['판타지'], tags: ['모험'],
    books: [
      ['canonical', '대표 도서', null, [['series', 'https://example.test/1']], 0, [0], 100, 12_000],
      ['other-title', '탐색용 별칭 제목', null, [['series', 'https://example.test/1']], 0, [0], 90, null],
    ],
  } }));
  await page.addInitScript(() => {
    const lower = String.prototype.toLocaleLowerCase;
    String.prototype.toLocaleLowerCase = function (...args) {
      if (String(this) === '탐색용 별칭 제목') {
        performance.mark('alias-search-prepared');
      }
      return lower.apply(this, args);
    };
  });
  const preparations = () => page.evaluate(() => performance.getEntriesByName('alias-search-prepared').length);
  await page.goto('/?mypagePerf=1#mypage/book/other-title');
  await expect(page.getByRole('region', { name: '도서 기본정보' }).getByRole('heading', { name: '대표 도서' })).toBeVisible();
  expect(await preparations()).toBe(0);
  const openList = async () => {
    const search = page.getByRole('textbox', { name: '도서 제목 검색' });
    await expect(search).toBeVisible();
    await search.fill('별칭 제목');
    const book = page.getByRole('link', { name: '대표 도서', exact: true });
    await expect(book).toBeVisible();
    await expect(book).toContainText('1.2만 조회·다운로드');
  };
  await page.getByRole('button', { name: '도서 목록으로 돌아가기' }).click();
  await openList();
  expect(await preparations()).toBe(1);
  const phases = await page.evaluate(() => performance.getEntriesByType('measure').map(({ name }) => name));
  expect(phases).toEqual(expect.arrayContaining(
    ['json', 'validation', 'grouping', 'search', 'sort', 'filter', 'first-rows'].map((phase) => `mypage:catalog:${phase}`),
  ));
  await page.getByRole('button', { name: '내 서재', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Guest Library', exact: true })).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#mypage/discover'; });
  await openList();
  expect(await preparations()).toBe(1);
});

test('My Page brings its desktop back button, menu and shortcuts together on scroll', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 700 });
  await page.goto('/#mypage/discover');
  const back = page.getByRole('button', { name: '서재로 돌아가기' });
  const menu = page.getByRole('navigation', { name: '마이페이지 메뉴' });
  const shortcuts = page.getByRole('group', { name: '마이페이지 바로가기' });
  await expect(shortcuts.getByRole('button')).toHaveCount(2);
  await expect(shortcuts.getByRole('button', { name: '내 서재' })).toBeVisible();
  await expect(shortcuts.getByRole('button', { name: '마이페이지 설정' })).toBeVisible();
  await expect(shortcuts).toHaveCSS('backdrop-filter', 'none');
  const dividers = page.locator('[data-mypage-header-divider]');
  const catalog = menu.getByRole('button', { name: '도서', exact: true });
  await expect(catalog).toHaveAttribute('aria-current', 'page');
  await expect(menu.getByRole('button')).toHaveText(['홈', '도서', '피드', '보관', '기록']);
  const firstBook = page.getByRole('link', { name: '테스트 도서 0', exact: true });
  await expect(firstBook).toBeVisible();
  await expect(firstBook.locator('[data-generated-book-cover-title]')).toHaveText('테스트 도서 0');
  const actualCover = page.getByRole('link', { name: '테스트 도서 1', exact: true });
  await expect.poll(() => actualCover.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(actualCover.locator('[data-generated-book-cover]')).toHaveCount(0);
  const missingCover = page.getByRole('link', { name: '테스트 도서 2', exact: true });
  await expect(missingCover.locator('[data-generated-book-cover-title]')).toHaveText('테스트 도서 2');
  const geometry = () => page.locator('[data-mypage-menu]').evaluate((bar) => {
    const { top } = bar.getBoundingClientRect();
    const button = bar.querySelector('button')!.getBoundingClientRect();
    const menu = bar.querySelector('nav')!.getBoundingClientRect();
    const shortcuts = bar.querySelector('[role="group"]')!.getBoundingClientRect();
    const lastMenuButton = bar.querySelector('nav button:last-child')!.getBoundingClientRect();
    return {
      pinned: Math.abs(top) < 1,
      twoRows: button.bottom <= menu.top && shortcuts.bottom <= menu.top,
      inline: button.right <= menu.left && lastMenuButton.right <= menu.right + 1
        && menu.right <= shortcuts.left && Math.abs(button.top - menu.top) < 1
        && Math.abs(shortcuts.top - menu.top) < 1,
    };
  });

  for (const width of [640, 768, 1280]) {
    await page.setViewportSize({ width, height: 700 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(geometry).toMatchObject({ pinned: false, twoRows: true });
    await expect(dividers).toHaveCount(0);
    const backColor = await back.evaluate(button => getComputedStyle(button).color);
    await expect(shortcuts.getByRole('button', { name: '내 서재' })).toHaveCSS('color', backColor);
    await expect(shortcuts.getByRole('button', { name: '마이페이지 설정' })).toHaveCSS('color', backColor);
    await assertDivider(firstBook.locator('..'));
    await expect(menu.getByText('홈')).toHaveCSS('position', 'static');
    await expect(catalog.getByText('도서')).toHaveCSS('position', 'static');
    const title = page.getByRole('heading', { name: '마이페이지', exact: true });
    await expect(title).toBeInViewport();
    const collapseAt = await page.getByRole('banner').evaluate((header) => Math.ceil(header.getBoundingClientRect().height / 2));
    await page.evaluate((height) => window.scrollTo(0, height - 1), collapseAt);
    await expect(page.locator('[data-mypage-menu]')).toHaveAttribute('data-mypage-menu', 'expanded');
    await page.evaluate((height) => window.scrollTo(0, height), collapseAt);
    await expect.poll(geometry).toMatchObject({ pinned: true, inline: true });
    await expect(page.locator('[data-mypage-menu]').getByRole('heading')).toHaveCount(0);
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
    await expect(catalog.getByText('도서')).toHaveCSS('position', 'static');
    const visibleLabels = await menu.evaluate((nav) => {
      const bounds = nav.getBoundingClientRect();
      return [...nav.querySelectorAll('button span')].filter((span) => {
        const label = span.getBoundingClientRect();
        return label.width > 1 && label.left >= bounds.left && label.right <= bounds.right;
      }).map((span) => span.textContent);
    });
    expect(visibleLabels).toEqual(['홈', '도서', '피드', '보관', '기록']);
  }

  await firstBook.click();
  await expect(page.getByRole('heading', { name: '도서 상세정보' })).toBeVisible();
  await expect(page.getByRole('region', { name: '도서 기본정보' }).locator('[data-generated-book-cover-title]')).toHaveText('테스트 도서 0');
  await expect(page.getByText('테스트 평가 19')).toBeAttached();
  await page.setViewportSize({ width: 640, height: 700 });
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(geometry).toMatchObject({ pinned: true, inline: true });
  await expect(page.locator('[data-mypage-menu]').getByRole('heading')).toHaveCount(0);
  await page.getByRole('button', { name: '도서 목록으로 돌아가기' }).click();
  await expect(page).toHaveURL(/#mypage\/discover$/);
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(geometry).toMatchObject({ pinned: true, inline: true });
  const collection = menu.getByRole('button', { name: '보관' });
  const collectionTabs = page.getByRole('navigation', { name: '보관 메뉴', exact: true });
  await collection.click();
  await expect(page).toHaveURL(/#mypage\/read$/);
  await expect(collection).toHaveAttribute('aria-current', 'page');
  await expect(collectionTabs.getByRole('button')).toHaveText(['읽은 책', '위시리스트', '내 평가']);
  await collectionTabs.getByRole('button', { name: '위시리스트' }).click();
  const savedBook = page.getByRole('link', { name: '관심 도서 19', exact: true });
  await expect(savedBook).toBeAttached();
  await assertDivider(savedBook.locator('..'));
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(geometry).toMatchObject({ pinned: true, inline: true });
  await expect(collection).toHaveAttribute('aria-current', 'page');
  await expect(collectionTabs.getByRole('button', { name: '위시리스트' })).toHaveAttribute('aria-current', 'page');
  await shortcuts.getByRole('button', { name: '마이페이지 설정' }).click();
  await expect(page).toHaveURL(/#mypage\/sharing$/);
  await catalog.click();
  const search = page.getByRole('textbox', { name: '도서 제목 검색' });
  await expect(firstBook).toBeVisible();
  const match = page.getByRole('link', { name: '테스트 도서 72', exact: true });
  await expect(match).toHaveCount(0);
  await search.fill('테스트 도서 72');
  await expect(match).toBeVisible();
  await expect(firstBook).toHaveCount(0);
  await assertDashboardCovers(page, menu.getByRole('button', { name: '홈', exact: true }));
  await shortcuts.getByRole('button', { name: '내 서재' }).click();
  await expect(page.getByRole('heading', { name: 'Guest Library', exact: true })).toBeVisible();
  await page.goto('/#mypage/book/menu-test-0/review');
  const reviewHeading = page.getByRole('heading', { name: '내 평가', exact: true });
  await expect(reviewHeading).toBeFocused();
  await expect(reviewHeading).toBeInViewport();
  await assertDivider(page.getByRole('region', { name: '다른 독자의 평가' }).getByRole('listitem').first());
  const storefront = page.getByRole('link', { name: '네이버 시리즈', exact: true }).locator('..');
  await page.setViewportSize({ width: 393, height: 700 });
  await assertDivider(storefront);
  await page.setViewportSize({ width: 1280, height: 700 });
  await expect(storefront).toHaveCSS('position', 'relative');
  expect(await storefront.evaluate(item => getComputedStyle(item, '::after').display)).toBe('none');
  await assertOtherDividerLists(page, menu);
  await page.goto('/#mypage/book/menu-test-0');
  const metrics = page.getByRole('region', { name: '내 독서 기록' }).locator('dl');
  for (const width of [393, 1280]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(metrics.getByText('읽은 시간')).toBeVisible();
    const layout = await metrics.evaluate(list => {
      const [duration, progress] = [...list.children].map(item => item.getBoundingClientRect());
      return { sameRow: duration.top === progress.top, gap: progress.left - duration.right };
    });
    expect(layout.sameRow).toBe(true);
    expect(layout.gap).toBeLessThan(64);
  }
  const publicBooks = [0, 1].map(index => ({ workId: `public-${index}`, title: `공개 도서 ${index}`, coverUrl: null }));
  await page.route('**/api/mypage?view=profile&code=*', route => {
    const params = new URL(route.request().url()).searchParams;
    const highest = params.get('reviewSort') === 'rating-desc';
    const more = params.get('cursor') === 'next-review-page';
    const reviews = publicBooks.map((item, index) => ({ ...item, rating: index + 3, comment: '' }));
    return route.fulfill({ json: {
      identity: { code: '00000001', nickname: '독자' }, visibility: { wishlist: true, reviews: true },
      wishlist: params.has('section') ? undefined : publicBooks,
      reviews: more ? [reviews[0], { ...reviews[0], workId: 'public-more', title: '추가 공개 도서', rating: highest ? 1 : 5 }]
        : highest ? [...reviews].reverse() : reviews,
      next: { reviews: more ? null : 'next-review-page' },
    } });
  });
  await page.goto('/people/00000001');
  for (const name of ['위시리스트', '별점 및 평가']) {
    await assertDivider(page.getByRole('region', { name }).getByRole('listitem').first());
  }
  const publicReviews = page.getByRole('region', { name: '별점 및 평가' });
  await publicReviews.getByRole('combobox', { name: '공개 평가 정렬' }).selectOption('rating-desc');
  await expect(publicReviews.getByRole('heading', { level: 3 })).toHaveText(['공개 도서 1', '공개 도서 0']);
  const nextReviews = page.waitForRequest(request => {
    const params = new URL(request.url()).searchParams;
    return params.get('view') === 'profile' && params.get('pagination') === 'cursor'
      && params.get('cursor') === 'next-review-page' && params.get('reviewSort') === 'rating-desc';
  });
  await publicReviews.getByRole('button', { name: '더 보기' }).click();
  await nextReviews;
  await expect(publicReviews.getByRole('heading', { level: 3 })).toHaveText(['공개 도서 1', '공개 도서 0', '추가 공개 도서']);
  await expect(page.getByRole('region', { name: '위시리스트' }).getByRole('listitem')).toHaveCount(2);
  const initialAfterReload = page.waitForRequest(request => {
    const params = new URL(request.url()).searchParams;
    return params.get('view') === 'profile' && !params.has('section');
  });
  await page.reload();
  expect(new URL((await initialAfterReload).url()).searchParams.get('reviewSort')).toBe('rating-desc');
  await expect(publicReviews.getByRole('combobox', { name: '공개 평가 정렬' })).toHaveValue('rating-desc');
  await expect(publicReviews.getByRole('heading', { level: 3 })).toHaveText(['공개 도서 1', '공개 도서 0']);
});

for (const responseOrder of ['refresh-first', 'sort-first'] as const) {
  test(`public profile focus refresh survives sort and pagination (${responseOrder})`, async ({ page }) => {
    let releaseRefresh!: () => void;
    let releaseSort!: () => void;
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const sortGate = new Promise<void>(resolve => { releaseSort = resolve; });
    let refreshing = false;
    let fullRequests = 0;
    let sectionRequests = 0;
    const book = (workId: string, title: string) => ({ workId, title, coverUrl: null });
    await page.route('**/api/mypage?view=profile&code=*', async route => {
      const params = new URL(route.request().url()).searchParams;
      if (refreshing && params.has('section')) sectionRequests++;
      if (refreshing && !params.has('section')) fullRequests++;
      const initial = !refreshing;
      const sorted = params.get('reviewSort') === 'rating-desc';
      if (!initial) await (sorted ? sortGate : refreshGate);
      await route.fulfill({ json: {
        identity: { code: '00000001', nickname: '독자' }, visibility: { wishlist: true, reviews: true },
        wishlist: [book(initial ? 'removed' : 'kept', initial ? '삭제된 위시' : '새 위시')],
        reviews: [{ ...book(sorted ? 'sorted' : 'recent', sorted ? '정렬된 평가' : '최근 평가'), rating: 4, comment: '' }],
        next: { wishlist: 30, reviews: null },
      } });
    });
    await page.goto('/people/00000001');
    const wishlist = page.getByRole('region', { name: '위시리스트' });
    const reviews = page.getByRole('region', { name: '별점 및 평가' });
    await expect(wishlist.getByRole('heading', { name: '삭제된 위시', exact: true })).toBeVisible();
    refreshing = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => fullRequests).toBe(1);
    await expect(wishlist.getByRole('button', { name: '더 보기' })).toBeDisabled();
    await reviews.getByRole('combobox', { name: '공개 평가 정렬' }).selectOption('rating-desc');
    await expect.poll(() => fullRequests).toBe(2);
    expect(sectionRequests).toBe(0);

    const firstSorted = responseOrder === 'sort-first';
    const firstResponse = page.waitForResponse(response => {
      const params = new URL(response.url()).searchParams;
      return params.get('view') === 'profile' && (params.get('reviewSort') === 'rating-desc') === firstSorted;
    });
    if (firstSorted) releaseSort(); else releaseRefresh();
    await firstResponse;
    if (firstSorted) {
      await expect(reviews.getByRole('heading', { name: '정렬된 평가', exact: true })).toBeVisible();
      await expect(wishlist.getByRole('heading', { name: '새 위시', exact: true })).toBeVisible();
    }
    const secondResponse = page.waitForResponse(response => {
      const params = new URL(response.url()).searchParams;
      return params.get('view') === 'profile' && (params.get('reviewSort') === 'rating-desc') !== firstSorted;
    });
    if (firstSorted) releaseRefresh(); else releaseSort();
    await secondResponse;
    await expect(reviews.getByRole('heading', { name: '정렬된 평가', exact: true })).toBeVisible();
    await expect(wishlist.getByRole('heading', { name: '새 위시', exact: true })).toBeVisible();
    await expect(wishlist.getByRole('heading', { name: '삭제된 위시', exact: true })).toHaveCount(0);
  });
}

test('My Page keeps all five mobile labels visible and opens its grouped tabs', async ({ page }) => {
  for (const width of [320, 393]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/#mypage/discover');
    // The Next.js development indicator occupies the footer's leftmost tap target.
    await page.addStyleTag({ content: 'nextjs-portal { display: none; }' });
    const header = page.locator('[data-mypage-mobile-header]');
    const title = header.getByRole('heading', { name: '마이페이지' });
    const desktopMenu = page.getByRole('navigation', { name: '마이페이지 메뉴', includeHidden: true });
    const footer = page.getByRole('navigation', { name: '마이페이지 하단 메뉴' });
    const buttons = footer.getByRole('button');
    await expect(title).toBeInViewport();
    await expect(header.getByRole('button')).toHaveCount(3);
    await expect(desktopMenu).toBeHidden();
    await expect(page.getByRole('link', { name: '테스트 도서 0', exact: true })).toBeVisible();
    await expect(buttons).toHaveText(['홈', '도서', '피드', '보관', '기록']);
    const layout = await footer.evaluate(nav => ({
      width: nav.clientWidth,
      scrollWidth: nav.scrollWidth,
      columns: Array.from(nav.children, child => child.getBoundingClientRect().width),
    }));
    expect(layout.width).toBe(width);
    expect(layout.scrollWidth).toBe(layout.width);
    expect(layout.columns).toHaveLength(5);
    for (const column of layout.columns) expect(Math.abs(column - width / 5)).toBeLessThan(1);
    const footerBox = (await footer.boundingBox())!;
    expect(footerBox.y + footerBox.height).toBe(700);

    await page.evaluate(() => window.scrollTo(0, 400));
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await expect(title).toBeInViewport();
    await expect(header.getByRole('button')).toHaveCount(3);
    expect((await header.boundingBox())!.y).toBe(0);
    expect(await footer.boundingBox()).toEqual(footerBox);
    await expect(page.locator('[data-mypage-menu]')).toHaveAttribute('data-mypage-menu', 'expanded');

    const collection = footer.getByRole('button', { name: '보관' });
    await collection.click();
    await expect(page).toHaveURL(/#mypage\/read$/);
    const collectionTabs = page.getByRole('navigation', { name: '보관 메뉴', exact: true });
    await expect(collectionTabs.getByRole('button')).toHaveText(['읽은 책', '위시리스트', '내 평가']);
    const saved = collectionTabs.getByRole('button', { name: '위시리스트' });
    await saved.click();
    await expect(page).toHaveURL(/#mypage\/wishlist$/);
    await expect(collection).toHaveAttribute('aria-current', 'page');
    await expect(saved).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('region', { name: '도서 검색 및 필터' })).toHaveCount(0);
    const wishlistSort = page.getByRole('combobox', { name: '위시리스트 정렬' });
    const firstWishlistRow = page.getByRole('region', { name: '도서 목록', exact: true }).getByRole('link').first();
    await expect(wishlistSort).toHaveValue('saved');
    await expect(firstWishlistRow).toHaveAccessibleName('관심 도서 19');
    await wishlistSort.selectOption('title');
    await expect(firstWishlistRow).toHaveAccessibleName('관심 도서 0');
    await wishlistSort.selectOption('saved');
    await expect(title).toBeInViewport();
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await expect(title).toBeInViewport();
    const subMenuBox = (await collectionTabs.boundingBox())!;
    expect(subMenuBox.y).toBeCloseTo((await header.boundingBox())!.height, 0);
    await page.goBack();
    await expect(collectionTabs.getByRole('button', { name: '읽은 책' })).toHaveAttribute('aria-current', 'page');
    await page.goBack();
    await expect(footer.getByRole('button', { name: '도서' })).toHaveAttribute('aria-current', 'page');

    const records = footer.getByRole('button', { name: '기록' });
    await records.click();
    await expect(page).toHaveURL(/#mypage\/calendar$/);
    const recordTabs = page.getByRole('navigation', { name: '기록 메뉴', exact: true });
    await expect(recordTabs.getByRole('button')).toHaveText(['캘린더', '통계', '주석']);
    await expect(page.getByRole('region', { name: '독서 달력' })).toBeVisible();
    await recordTabs.getByRole('button', { name: '통계' }).click();
    await expect(page).toHaveURL(/#mypage\/statistics$/);
    await recordTabs.getByRole('button', { name: '주석' }).click();
    await expect(page).toHaveURL(/#mypage\/annotations$/);
    await expect(records).toHaveAttribute('aria-current', 'page');

    await footer.getByRole('button', { name: '피드' }).click();
    await expect(page).toHaveURL(/#mypage\/browse$/);
    const feedTabs = page.getByRole('navigation', { name: '피드 메뉴', exact: true });
    await expect(feedTabs.getByRole('button')).toHaveText(['평점을 남긴 도서', '위시리스트']);
    await expect(page.getByRole('heading', { name: '둘러보기', exact: true })).toHaveCount(0);
    const feedWishlist = feedTabs.getByRole('button', { name: '위시리스트' });
    await feedWishlist.click();
    await expect(feedWishlist).toHaveAttribute('aria-current', 'true');

    await page.goto('/#mypage/reviews');
    await expect(collection).toHaveAttribute('aria-current', 'page');
    await expect(collectionTabs.getByRole('button', { name: '내 평가' })).toHaveAttribute('aria-current', 'page');
    await expect(buttons).toHaveText(['홈', '도서', '피드', '보관', '기록']);
    await expect(page.getByText('내 평가는 로그인 후 이용할 수 있습니다.')).toBeVisible();
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
    const durationMs = 120_000;
    for (let i = 0; i < 3; i++) {
      const startedAtClient = date.getTime() + i * durationMs;
      const bookId = `divider-${i}`;
      const ownerKey = 'guest:header-test|library:local';
      tx.objectStore(stats).put({
        ownerKey, sessionId: bookId, bookId, bookTitle: i === 0 ? 'menu-test-0' : bookId, schemaVersion: 1, deviceId: 'fixture',
        mode: 'screen', startedAtClient, endedAtClient: startedAtClient + durationMs, durationMs,
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
  const records = page.getByRole('navigation', { name: '기록 메뉴', exact: true });
  for (const [navigation, tab, selector] of [
    [menu, '홈', '[aria-label="독서 기록 목록"] li'],
    [menu, '기록', '[aria-label="독서 기록 목록"] li'],
    [records, '통계', '[data-reading-statistics-book]'],
    [records, '주석', '[data-library-annotation-item]'],
  ] as const) {
    await navigation.getByRole('button', { name: tab, exact: true }).click();
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
  await page.getByRole('button', { name: '피드', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '피드 메뉴' })).toBeVisible();
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
