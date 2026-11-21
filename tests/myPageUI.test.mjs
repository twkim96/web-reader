import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { useMyPageNavigation } from '../src/hooks/useMyPageNavigation.ts';
import { setWishlistSaved } from '../src/lib/localWishlist.ts';
import { closeLocalDB } from '../src/lib/localDB.ts';
import { cacheReadBookMetadata } from '../src/lib/readBookMetadataCache.ts';
import { notifyReadingStatisticsChange } from '../src/lib/readingStatisticsWake.ts';
import { hydrateRemoteReadingSessionsPageV12, saveLocalReadingSessionV11 } from '../src/lib/localReadingStatistics.ts';

// The detail imports the loader statically. Install the fixture before loading
// MyPage so both its static and lazy consumers resolve the same loader.
const metadataFixtureHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../../lib/readBookMetadata' && /\/mypage\/(ReadBooks|BookDetail)\.tsx$/.test(context.parentURL ?? '')) {
      return {
        url: new URL('./fixtures/myPageMetadataLoader.cjs', import.meta.url).href,
        format: 'commonjs',
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { MyPage } = await import('../src/components/mypage/MyPage.tsx');
const { ReadBooks } = await import('../src/components/mypage/ReadBooks.tsx');
const { BookCover } = await import('../src/components/mypage/BookCover.tsx');
test.after(() => metadataFixtureHook.deregister());

const owner = 'guest:mypage-test|library:local';
const book = { id: 'test-book', title: '테스트 도서', coverUrl: null, platforms: [], genre: '판타지', tags: [], popularity: 10, sourceCount: null };
const series = { id: 'series', label: '네이버 시리즈', url: 'https://series.naver.com/novel/detail.series?productNo=1' };
const kakao = { id: 'kakao', url: 'https://page.kakao.com/content/12' };
const savedBook = { ...book, id: '테스트도서', platforms: [series] };
const savedCatalog = [
  [savedBook.id, savedBook.title, null, [[series.id, series.url]], 0, [], 10, null],
  [savedBook.id + '별칭', '다른 표시 제목', null, [[series.id, series.url], [kakao.id, kakao.url]], 0, [], 10, null],
];
const setup = (hash = '#mypage/wishlist') => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const values = new Map();
  const storage = {
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
  };
  window.localStorage = storage;
  window.location = { hash, pathname: '/', search: '' };
  const stack = [hash];
  const states = [null];
  let index = 0;
  window.history = {
    get state() { return states[index]; },
    pushState(state, _title, url) {
      stack.splice(index + 1);
      states.splice(index + 1);
      stack.push(url || stack[index]);
      states.push(state);
      index++;
      window.location.hash = stack[index].startsWith('#') ? stack[index] : '';
    },
    back() {
      if (index === 0) return;
      index--;
      window.location.hash = stack[index].startsWith('#') ? stack[index] : '';
      window.dispatchEvent(new window.Event('popstate'));
    },
  };
  window.requestAnimationFrame = callback => window.setTimeout(callback, 0);
  window.cancelAnimationFrame = window.clearTimeout;
  window.scrollTo = () => {};
  Object.assign(globalThis, { window, document: window.document, localStorage: storage, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event, CustomEvent: window.CustomEvent, BroadcastChannel: undefined });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { window, storage, root: createRoot(window.document.querySelector('#root')) };
};
const props = {
  ownerKey: owner, books: [], progress: {}, bookmarkProgress: {}, theme: { bg: '', text: '', border: '', secondary: '' }, themeVariables: {}, accentColor: 'rose',
  syncHealth: 'healthy', quarantinedDocumentCount: 0, canRefresh: false, refreshing: false, lastServerCheckedAt: null,
  onRefresh() {}, onBack() {},
};
const click = async (window, element) => act(async () => element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })));
const select = (window, element, value) => act(async () => {
  element.querySelector(`option[value="${value}"]`).selected = true;
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
});

test('dashboard book sections open the matching detail and full list', async () => {
  const { window, storage, root } = setup('#mypage/overview');
  for (const id of ['test-one', 'test-two', 'test-three']) {
    setWishlistSaved(owner, { ...book, id, title: id }, true, storage);
  }
  const main = () => window.document.querySelector('main');
  try {
    await act(async () => root.render(React.createElement(MyPage, props)));
    assert.deepEqual([...main().querySelectorAll('h2')].slice(0, 3).map(({ textContent }) => textContent), [
      '읽고 싶은 도서', '읽은 도서', '평점을 남긴 도서',
    ]);
    const row = main().querySelector('[aria-label="읽고 싶은 도서 가로 목록"]');
    assert.equal(row.querySelectorAll('li').length, 3);
    const card = row.querySelector('a[aria-label="test-two"]');
    await click(window, card);
    assert.equal(window.location.hash, '#mypage/book/test-two');
    assert.equal(main().getAttribute('aria-label'), '도서 상세정보');
    await act(async () => window.history.back());
    assert.equal(main().querySelector('[aria-label="읽고 싶은 도서 가로 목록"]'), row);
    await click(window, main().querySelector('[aria-label="읽고 싶은 도서 전체 보기"]'));
    assert.equal(window.location.hash, '#mypage/wishlist');
    assert.equal(main().querySelectorAll('article').length, 3);
  } finally {
    await act(async () => root.unmount());
    await closeLocalDB();
  }
});

test('browse replaces user search with public book rows grouped by reader', async (t) => {
  const { window, root } = setup('#mypage/people');
  globalThis.self = window;
  const works = { workId: book.id, title: book.title, coverUrl: null };
  const first = { code: 'A1234567', nickname: '활기찬사자' };
  const second = { code: 'B1234567', nickname: '조용한토끼' };
  t.mock.method(globalThis, 'fetch', async (request) => {
    const url = new URL(String(request), 'http://localhost');
    if (url.searchParams.get('view') !== 'browse') return Response.json([]);
    const groups = url.searchParams.get('section') === 'wishlist'
      ? [{ reader: second, books: [works] }]
      : [{ reader: first, books: [{ ...works, rating: 4, comment: '다시 읽고 싶어요' }] },
        { reader: second, books: [{ ...works, rating: 3 }] }];
    return Response.json({ groups, next: null });
  });
  const main = () => window.document.querySelector('main');
  const rows = () => [...main().querySelectorAll('section[aria-label]')];
  try {
    await act(async () => root.render(React.createElement(MyPage, props)));
    assert.equal(window.document.querySelector('nav').textContent.includes('사람 검색'), false);
    assert.deepEqual(rows().map((row) => row.getAttribute('aria-label')), [
      '활기찬사자님이 평점을 남긴 도서', '조용한토끼님이 평점을 남긴 도서',
    ]);
    assert.equal(rows()[0].querySelector('a').getAttribute('href'), '/people/A1234567');
    assert.ok(rows().every((row) => row.querySelector('[data-dashboard-book-row] a').getAttribute('href') === '#mypage/book/test-book'));
    assert.ok(rows()[0].textContent.includes('다시 읽고 싶어요'));
    assert.equal(main().querySelector('h2')?.textContent, '활기찬사자님이 평점을 남긴 도서');
    const feedTabs = window.document.querySelector('nav[aria-label="피드 메뉴"]');
    assert.equal(feedTabs.querySelector('[aria-current="true"]').textContent, '평점을 남긴 도서');
    await click(window, feedTabs.querySelector('button:nth-of-type(2)'));
    assert.equal(feedTabs.querySelector('[aria-current="true"]').textContent, '위시리스트');
    assert.deepEqual(rows().map((row) => row.getAttribute('aria-label')), ['조용한토끼님이 담은 도서']);
  } finally {
    await act(async () => root.unmount());
    delete globalThis.self;
    await closeLocalDB();
  }
});

test('stars navigate to the detail editor, preserving the draft across failed saves and conflicts', async (t) => {
  const { window, root } = setup('#mypage/read');
  const uid = 'rating-ui';
  const ownerKey = `firebase:${uid}|library:local`;
  const title = '별점 저장 테스트';
  const alias = '처음 평가할 책';
  const unresolved = '후속 미게시 판본';
  const incomplete = '조회가 실패한 파일';
  const renamed = '예전 파일 이름';
  const privatePdf = '개인 메모.pdf';
  let historyReads = 0;
  let failHistoryMetadata = true;
  let loseEditionMetadata = false;
  let failOldName = true;
  const firstURL = 'https://books.example/first';
  const secondURL = 'https://books.example/second';
  const pendingURL = 'https://books.example/not-in-client-index';
  globalThis.myPageTestMetadata = (titles, { onProgress }) => {
    if (!onProgress && titles.length > 1) historyReads++;
    const result = { metadata: new Map(), failed: new Set() };
    for (const name of titles) {
      if ((name === incomplete && failHistoryMetadata) || (name === renamed && failOldName)) {
        result.failed.add(name);
      } else if (name === renamed || name === privatePdf || (name === incomplete && loseEditionMetadata)) {
        result.metadata.set(name, null);
      } else {
        const url = name === title ? firstURL : name === alias || name === incomplete ? secondURL
          : name === unresolved ? 'https://books.example/unpublished' : null;
        const platforms = url ? [{ platform: 'series', url, label: '네이버 시리즈', viewCount: null, downloadCount: null, rating: null }] : [];
        if (name === alias) platforms.push({ ...platforms[0], platform: 'kakao', url: pendingURL });
        result.metadata.set(name, { titleKey: name === incomplete ? alias : name, displayTitle: name, platforms });
      }
      onProgress?.(result, name);
    }
    return result;
  };
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const { parentURL = '' } = context;
      if (specifier === './firebase' && parentURL.endsWith('/myPageSocialClient.ts')) {
        return { url: 'data:text/javascript,' + encodeURIComponent(
          `export const auth = { currentUser: { uid: ${JSON.stringify(uid)}, getIdToken: async () => 'fixture-token' } };`,
        ), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  const start = Date.UTC(2026, 10, 20, 5);
  const draftComment = '기기에 남길 한줄평';
  const reviewCover = 'https://comicthumb-phinf.pstatic.net/rated-book.png?type=w160';
  let committed = { workId: title, aliases: [alias], platformWorkKeys: [JSON.stringify(['series', firstURL])],
    rating: 2, comment: draftComment, revision: 1, totalMs: 60_000, progressPercent: 80, coverUrl: reviewCover };
  const unread = { ...book, id: 'unread-metadata', title: '읽기 전 작품' };
  const unreadRating = { workId: unread.id, rating: 3, revision: 1, comment: '', totalMs: null, progressPercent: null };
  const secondWorkId = 'published-second';
  const secondReview = { ...committed, workId: secondWorkId, aliases: [], rating: 3, totalMs: 120_000, progressPercent: 90,
    platformWorkKeys: [JSON.stringify(['series', secondURL])] };
  const secondWrites = [];
  let secondSaved = false;
  const writes = [];
  let rejectFirst;
  let finishUnread;
  let unreadSaved = false;
  let finishCatalogFailure;
  let firstCatalogFetch = true;
  const scrollTargets = [];
  window.HTMLElement.prototype.scrollIntoView = function () { scrollTargets.push(this.id); };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('/catalog/') && firstCatalogFetch) {
      firstCatalogFetch = false;
      return new Promise((resolve) => { finishCatalogFailure = () => resolve(new Response(null, { status: 503 })); });
    }
    if (String(url).startsWith('/catalog/')) return Response.json({ schemaVersion: 1, generation: 'rating-ui', genres: [savedBook.genre], tags: [], books: [
      ...savedCatalog,
      [title, title, null, [['series', firstURL]], null, [], null, null],
      [alias, alias, null, [['series', firstURL]], null, [], null, null],
      [unresolved, unresolved, null, [['series', firstURL]], null, [], null, null],
      [secondWorkId, alias, null, [['series', secondURL]], null, [], null, null],
      [unread.id, unread.title, null, [['series', 'https://books.example/unread']], null, [], null, null],
    ] });
    if (String(url).startsWith('/api/book-reviews?')) return Response.json({ reviews: [], ratingCount: 0, average: null });
    assert.match(String(url), /^\/api\/mypage\?/);
    if (options.method === 'GET') {
      if (String(url).includes('view=wishlist')) return Response.json({
        entries: [{ book: unread, item: { saved: true, addedAt: start, revision: 1, workId: unread.id }, aliases: [] }],
      });
      if (String(url).includes('view=account')) return Response.json({
        code: '00000001', nickname: '독자', revision: 1, visibility: { reviews: true, wishlist: false },
      });
      return Response.json({
        reviews: [committed, ...(secondSaved ? [secondReview] : []), ...(unreadSaved ? [unreadRating] : [])],
        deletions: [],
      });
    }
    const body = JSON.parse(options.body);
    if (body.workId === secondWorkId) {
      secondWrites.push(body);
      secondSaved = !body.remove;
      return Response.json({ review: secondSaved ? secondReview : null });
    }
    writes.push(body);
    if (writes.length === 1) return new Promise((_, reject) => { rejectFirst = reject; });
    if (writes.length === 4) {
      committed = { ...committed, rating: 3, comment: '다른 기기에서 저장한 한줄평', revision: 2 };
      return new Response(null, { status: 409 });
    }
    if (writes.length === 5) {
      committed = { ...committed, rating: body.rating, comment: body.comment, revision: 3 };
      return Response.json({ review: committed });
    }
    if (writes.length === 6) return new Promise((resolve) => {
      finishUnread = () => { unreadSaved = true; resolve(Response.json({ review: unreadRating })); };
    });
    return new Response(null, { status: 503 });
  });
  const visible = (selector) => window.document.querySelector(selector);
  try {
    const session = {
      schemaVersion: 1, sessionId: 'review-session', bookId: 'review-book', bookTitle: title, deviceId: 'review-device',
      startedAtClient: start, endedAtClient: start + 60_000, durationMs: 60_000, startProgressPercent: 79,
      endProgressPercent: 80, timezoneOffsetMinutes: 0, localDate: '2026-11-20', mode: 'screen', completed: false,
    };
    await hydrateRemoteReadingSessionsPageV12(ownerKey, [
      session, { ...session, sessionId: 'unrated-session', bookId: 'unrated-book', bookTitle: alias,
        startedAtClient: start + 60_000, endedAtClient: start + 120_000 },
      { ...session, sessionId: 'old-name-session', bookId: 'unpublished-book', bookTitle: renamed,
        startedAtClient: start + 240_000, endedAtClient: start + 300_000 },
      { ...session, sessionId: 'unpublished-session', bookId: 'unpublished-book', bookTitle: unresolved,
        startedAtClient: start + 180_000, endedAtClient: start + 240_000 },
      { ...session, sessionId: 'metadata-pending', bookId: 'metadata-pending-book', bookTitle: incomplete,
        startedAtClient: start + 120_000, endedAtClient: start + 180_000, endProgressPercent: 90 },
      { ...session, sessionId: 'private-pdf', bookId: 'private-pdf', bookTitle: privatePdf,
        startedAtClient: start + 300_000, endedAtClient: start + 360_000 },
    ], null, null, true, false);
    await act(async () => root.render(React.createElement(MyPage, { ...props, ownerKey })));
    assert.deepEqual([...visible('nav').querySelectorAll('button')].map((button) => button.querySelector('span').textContent), [
      '홈', '도서', '피드', '보관', '기록',
    ]);
    const readList = () => visible('section[aria-label="읽은 책"] .mypage-divided-list');
    for (let attempt = 0; attempt < 20 && !readList().children.length; attempt++) await act(async () => delay(20));
    assert.equal(readList().children.length, 2);
    assert.equal(readList().querySelector('a'), null);
    await act(async () => finishCatalogFailure());
    assert.equal(readList().querySelector('a'), null);
    const catalogRetry = [...visible('section[aria-label="읽은 책"]').querySelectorAll('p[role="status"] button')].find((button) => button.textContent === '다시 시도');
    await click(window, catalogRetry);
    const unratedLink = 'a[aria-label="처음 평가할 책 내 평가, 미평가"]';
    const ratedLink = `a[aria-label="${title} 내 평가, 별점 2점"]`;
    for (let attempt = 0; attempt < 20 && !visible(ratedLink); attempt++) await act(async () => delay(20));
    failOldName = false;
    const retryTitles = () => [...visible('section[aria-label="읽은 책"]').querySelectorAll('p[role="alert"] button')]
      .find((button) => button.textContent === '다시 시도');
    await click(window, retryTitles());
    for (let attempt = 0; attempt < 20 && readList().children.length !== 3; attempt++) await act(async () => delay(10));
    const readRows = [...readList().children];
    assert.equal(readRows.length, 3);
    const readTitles = (rows) => [...rows].map((row) => row.querySelector('h3').textContent);
    const readSort = visible('select[aria-label="읽은 책 정렬"]');
    await select(window, readSort, 'title');
    assert.deepEqual(readTitles(readList().children), readTitles(readRows).sort((a, b) => a.localeCompare(b, 'ko')));
    await select(window, readSort, 'recent');
    assert.deepEqual(readTitles(readList().children), readTitles(readRows));
    const unresolvedRow = readRows.find((row) => row.querySelector('h3').textContent === unresolved);
    assert.equal(unresolvedRow.querySelector('a'), null);
    assert.equal(unresolvedRow.querySelector('[data-generated-book-cover-title]').textContent, unresolved);
    assert.equal(visible(unratedLink).closest('article').querySelector('[data-generated-book-cover-title]').textContent, alias);
    assert.equal(visible(unratedLink).querySelectorAll('svg[fill="none"]').length, 5);
    assert.equal(visible(unratedLink).getAttribute('href'), '#mypage/book/published-second/review');
    await click(window, visible(unratedLink));
    assert.equal(window.location.hash, '#mypage/book/published-second/review');
    assert.ok(scrollTargets.includes('my-book-review-title'));
    const editor = () => visible('[aria-labelledby="my-book-review-title"]');
    assert.ok(editor().querySelector('[aria-label="별점 미평가"]'));
    assert.equal(editor().querySelector('form'), null);
    await click(window, editor().querySelector('button[aria-label="3점"]'));
    assert.equal([...editor().querySelectorAll('button')].some((button) => button.textContent === '평가 삭제'), false);
    await act(async () => editor().querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(secondWrites[0].workId, secondWorkId);
    assert.equal(secondWrites[0].revision, null);
    assert.equal(secondWrites[0].readingSnapshot, null);
    assert.deepEqual(secondWrites[0].fileIds, []);
    const retryHistory = () => [...visible('main').querySelectorAll('button')].find((button) => button.textContent === '기록 다시 연결');
    for (let attempt = 0; attempt < 20 && !retryHistory(); attempt++) await act(async () => delay(10));
    assert.ok(retryHistory());
    failHistoryMetadata = false;
    await click(window, retryHistory());
    for (let attempt = 0; attempt < 20 && retryHistory(); attempt++) await act(async () => delay(10));
    if (retryHistory()) throw new Error('metadata retry control still visible');
    await click(window, editor().querySelector('button[aria-label="3점"]'));
    await act(async () => editor().querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.deepEqual(secondWrites[1].readingSnapshot, { totalMs: 120_000, progressPercent: 90 });
    assert.equal(secondWrites[1].readingSnapshotVersion, 2);
    assert.equal(secondWrites[1].readingHistoryPartial, true);
    await click(window, editor().querySelector('button[aria-label="3점"]'));
    await click(window, [...editor().querySelectorAll('button')].find((button) => button.textContent === '평가 삭제'));
    const expectedKeys = [JSON.stringify(['series', secondURL]), JSON.stringify(['kakao', pendingURL])];
    assert.deepEqual(secondWrites[0].platformWorkKeys, expectedKeys);
    assert.deepEqual(secondWrites[2], { workId: secondWorkId, detailWorkId: secondWorkId, revision: 1, platformWorkKeys: expectedKeys, remove: true });
    assert.equal(committed.rating, 2);
    const hash = window.location.hash;
    await act(async () => root.render(null));
    window.location.hash = hash;
    await act(async () => root.render(React.createElement(MyPage, { ...props, ownerKey })));
    assert.ok(visible('[aria-label="도서 기본정보"]').textContent.includes(alias));
    assert.ok(editor().querySelector('[aria-label="별점 미평가"]'));
    assert.equal(writes.length, 0);
    await act(async () => {
      window.location.hash = '#mypage/read';
      window.dispatchEvent(new window.Event('hashchange'));
    });
    assert.equal(window.location.hash, '#mypage/read');
    for (let attempt = 0; attempt < 20 && !visible(ratedLink); attempt++) await act(async () => delay(10));
    assert.ok(visible(ratedLink));
    await click(window, visible(ratedLink));
    await act(async () => delay(10));
    const halfPoint = editor().querySelector('button[aria-label="4.5점"]');
    assert.equal(editor().querySelectorAll('[role="group"] button').length, 10);
    await click(window, halfPoint);
    assert.equal(halfPoint.getAttribute('aria-pressed'), 'true');
    await act(async () => visible('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.ok(visible('[aria-label="별점 4.5점"]'));
    assert.equal(visible('form'), null);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].comment, draftComment);
    assert.equal(writes[0].readingSnapshot.progressPercent, 80);
    await act(async () => { rejectFirst(new TypeError('connection lost')); });
    assert.ok(visible('[aria-label="별점 4.5점"]'));
    for (let attempt = 0; attempt < 30 && !visible('[role="alert"]'); attempt++) {
      await act(async () => delay(75));
    }
    assert.equal(writes.length, 3);
    assert.ok(writes[0].saveId);
    assert.deepEqual(writes, [writes[0], writes[0], writes[0]]);
    assert.ok(visible('[aria-label="별점 2점"]'));
    assert.equal(visible('[aria-label="별점 4.5점"]'), null);
    assert.match(visible('[role="alert"]').textContent, /서버와 연결하지 못했습니다/);
    assert.equal(editor().querySelector('input[aria-label="한줄평 (선택)"]').value, draftComment);
    const openMenu = (label) => click(window, [...visible('nav').querySelectorAll('button')].find((button) => button.textContent === label));
    await openMenu('도서');
    const beforeDirectHistory = historyReads;
    await click(window, visible(`a[aria-label="${title}"]`));
    for (let attempt = 0; attempt < 20
      && (historyReads === beforeDirectHistory || editor().querySelector('button[aria-label="4.5점"]').disabled); attempt++) {
      await act(async () => delay(10));
    }
    await click(window, editor().querySelector('button[aria-label="4.5점"]'));
    await act(async () => visible('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    const rebase = () => [...editor().querySelectorAll('button')].find(button => button.textContent === '최신 평가에 초안 적용');
    for (let attempt = 0; attempt < 20 && !rebase(); attempt++) await act(async () => delay(10));
    assert.ok(editor().querySelector('[aria-label="별점 3점"]'));
    assert.match(editor().textContent, /현재 저장된 평가 · 3점 · 다른 기기에서 저장한 한줄평/);
    assert.equal(editor().querySelector('input[aria-label="한줄평 (선택)"]').value, draftComment);
    assert.equal(editor().querySelector('button[type="submit"]').disabled, true);
    assert.equal(writes.length, 4);
    assert.deepEqual(writes[3].readingSnapshot, writes[0].readingSnapshot);
    await click(window, rebase());
    await act(async () => visible('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(writes[4].revision, 2);
    assert.equal(writes[4].comment, draftComment);
    assert.ok(editor().querySelector('[aria-label="별점 4.5점"]'));
    await openMenu('보관');
    for (let attempt = 0; attempt < 20 && !visible(`a[aria-label="${title} 내 평가, 별점 4.5점"]`); attempt++) {
      await act(async () => delay(10));
    }
    const updatedLink = visible(`a[aria-label="${title} 내 평가, 별점 4.5점"]`);
    assert.ok(updatedLink);
    assert.equal(updatedLink.querySelectorAll('svg[fill="currentColor"]').length, 5);
    assert.equal(updatedLink.querySelectorAll('svg[fill="none"]').length, 1);
    const openCollectionTab = (label) => click(window, [...visible('nav[aria-label="보관 메뉴"]').querySelectorAll('button')]
      .find((button) => button.textContent === label));
    await openCollectionTab('위시리스트');
    await click(window, visible(`a[aria-label="${unread.title}"]`));
    await act(async () => { await delay(0); });
    assert.equal(visible('[aria-label="내 독서 기록"]'), null);
    const unreadStar = editor().querySelector('button[aria-label="3점"]');
    assert.equal(unreadStar.disabled, false);
    await click(window, unreadStar);
    await act(async () => visible('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(writes[5].workId, unread.id);
    assert.equal(writes[5].rating, 3);
    assert.deepEqual(writes[5].fileIds, []);
    assert.equal(writes[5].readingSnapshot, null);
    assert.ok(editor().querySelector('[aria-label="별점 3점"]'));
    await openMenu('보관');
    await openCollectionTab('내 평가');
    const allReviews = () => visible('section[aria-label="내 평가"] .mypage-divided-list');
    assert.equal(allReviews().children.length, 1);
    await act(async () => finishUnread());
    assert.equal(allReviews().children.length, 2);
    const reviewSort = visible('select[aria-label="내 평가 정렬"]');
    await select(window, reviewSort, 'rating-asc');
    assert.deepEqual([...allReviews().querySelectorAll('h3')].map(({ textContent }) => textContent), [unread.id, title]);
    assert.equal(allReviews().querySelector('img')?.getAttribute('src'), reviewCover);
    await click(window, visible('button[aria-label="공개 설정"]'));
    assert.equal(visible('section[aria-label="프로필 및 공개 설정"] .mypage-divided-list').children.length, 2);
    await openMenu('보관');
    await openCollectionTab('내 평가');
    assert.equal(visible('select[aria-label="내 평가 정렬"]').querySelector('option:checked').value, 'rating-asc');
    await openCollectionTab('읽은 책');
    await select(window, visible('select[aria-label="읽은 책 정렬"]'), 'progress');
    await openCollectionTab('내 평가');

    // Restore the earlier server rating before either entry path sees the
    // missing edition. A lower partial snapshot must preserve its evidence.
    secondSaved = true;
    await openCollectionTab('읽은 책');
    assert.equal(visible('select[aria-label="읽은 책 정렬"]').querySelector('option:checked').value, 'progress');
    const editionLink = () => visible('a[href="#mypage/book/published-second/review"]');
    const editionRow = () => editionLink()?.closest('article');
    for (let n = 0; n < 20 && !editionRow()?.textContent.includes('2분 읽음'); n++) {
      await act(async () => delay(10));
    }
    assert.match(editionRow()?.textContent ?? '', /2분 읽음/);
    loseEditionMetadata = true;
    const beforeListHistory = historyReads;
    await click(window, editionLink());
    const saveRatingWithPersonalTime = async (time, beforeHistory) => {
      const record = () => visible('[aria-label="내 독서 기록"]');
      const star = () => editor()?.querySelector('button[aria-label="3점"]');
      for (let n = 0; n < 20
        && (historyReads === beforeHistory || !record()?.textContent.includes(time) || !star() || star().disabled); n++) {
        await act(async () => delay(10));
      }
      assert.match(record()?.textContent ?? '', new RegExp(time));
      await click(window, star());
      await act(async () => editor().querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    };
    await saveRatingWithPersonalTime('2분', beforeListHistory);
    const directHash = window.location.hash;
    await act(async () => root.render(null));
    window.location.hash = directHash;
    const beforeRemountHistory = historyReads;
    await act(async () => root.render(React.createElement(MyPage, { ...props, ownerKey })));
    await saveRatingWithPersonalTime('1분', beforeRemountHistory);
    assert.equal(secondWrites.length, 5);
    for (const request of secondWrites.slice(3)) {
      assert.equal(request.rating, 3);
      assert.equal(request.readingSnapshot, null);
      assert.deepEqual(request.fileIds, []);
      assert.equal(request.readingSnapshotVersion, undefined);
    }
    await openMenu('홈');
    const previewCover = () => visible('[aria-label="평점을 남긴 도서 가로 목록"] img');
    for (let attempt = 0; attempt < 20 && !previewCover(); attempt++) await act(async () => delay(10));
    assert.equal(previewCover()?.getAttribute('src'), reviewCover);
  } finally {
    await act(async () => root.unmount());
    await closeLocalDB();
    delete globalThis.myPageTestMetadata;
    hook.deregister();
  }
});

test('a reopened read list shows confirmed matches while the new title is still loading', async () => {
  const { window, root } = setup('#mypage/read');
  const ownerKey = 'firebase:warm-read-list|library:local';
  const start = Date.UTC(2026, 10, 21, 1);
  const matched = '원래 저장된 제목.txt';
  const missing = '새 파일 제목.txt';
  const result = (titleKey, displayTitle) => ({
    schemaVersion: 1, titleKey, displayTitle, normalizerVersion: '1.3.3', publishedAt: new Date(start).toISOString(), platforms: [],
  });
  const cached = result('cached-title', '다시 표시된 도서');
  const fresh = result('new-title', '새로 연결한 도서');
  const record = (bookId, bookTitle, offset) => ({
    schemaVersion: 1, sessionId: bookId, bookId, bookTitle, deviceId: 'fixture-device',
    startedAtClient: start + offset, endedAtClient: start + offset + 60_000, durationMs: 60_000, startProgressPercent: 1,
    endProgressPercent: 10, timezoneOffsetMinutes: 0, localDate: '2026-11-21', mode: 'screen', completed: false,
  });
  await hydrateRemoteReadingSessionsPageV12(ownerKey, [record('matched', matched, 0), record('new', missing, 60_000)], null, null, true, false);
  await cacheReadBookMetadata(ownerKey, new Map([[matched, { metadata: cached, observedAt: Date.now() }]]));
  const requested = [];
  let finish;
  globalThis.myPageTestMetadata = (titles, options) => new Promise((resolve) => {
    requested.push(...titles);
    finish = () => {
      const result = { metadata: new Map([[missing, fresh]]), failed: new Set() };
      options.onProgress?.(result, missing);
      resolve(result);
    };
  });
  const list = () => window.document.querySelector('[aria-label="읽은 책"]');
  try {
    await act(async () => root.render(React.createElement(MyPage, { ...props, ownerKey })));
    for (let attempt = 0; attempt < 40 && !finish; attempt++) await act(async () => delay(10));
    assert.deepEqual(requested, [missing]);
    assert.match(list().textContent, /다시 표시된 도서/);
    assert.doesNotMatch(list().textContent, /읽은 책을 불러오는 중|새로 연결한 도서/);
    await act(async () => finish());
    assert.match(list().textContent, /새로 연결한 도서/);
  } finally {
    await act(async () => root.unmount());
    await closeLocalDB();
    delete globalThis.myPageTestMetadata;
  }
});

test('read book rows load eligible covers directly and fall back to the proxy once', async (t) => {
  const { window, root } = setup('#mypage/read');
  const ownerKey = 'firebase:read-cover-test|library:local';
  const start = Date.UTC(2026, 10, 21, 1);
  const covers = {
    direct: ['series', 'https://comicthumb-phinf.pstatic.net/cover.png?type=w160'],
    hotlink: ['kakao', 'https://dn-img-page.kakao.com/blocked.png'],
    offline: ['series', 'https://comicthumb-phinf.pstatic.net/unavailable.png'],
    novelpia: ['novelpia', 'https://novelpia.com/imagebox/cover/redirect.file'],
  };
  const records = [];
  const metadata = new Map();
  for (const [title, [platform, coverUrl]] of Object.entries(covers)) {
    const startedAtClient = start + records.length * 60_000;
    records.push({
      schemaVersion: 1, sessionId: title, bookId: title, bookTitle: title, deviceId: 'fixture-device',
      startedAtClient, endedAtClient: startedAtClient + 60_000, durationMs: 60_000,
      startProgressPercent: 1, endProgressPercent: 10, timezoneOffsetMinutes: 0, localDate: '2026-11-21',
      mode: 'screen', completed: false,
    });
    metadata.set(title, { observedAt: Date.now(), metadata: {
      schemaVersion: 1, titleKey: title, displayTitle: title, normalizerVersion: '1.3.3',
      publishedAt: new Date(start).toISOString(),
      platforms: [{
        platform, label: platform, title, url: `https://example.test/${title}`, coverUrl, lastSuccessAt: new Date(start).toISOString(),
        downloadCount: null, interestCount: null, viewCount: null, recommendCount: null, rating: null, ratingCount: null,
      }],
    } });
  }
  await hydrateRemoteReadingSessionsPageV12(ownerKey, records, null, null, true, false);
  await cacheReadBookMetadata(ownerKey, metadata);
  const proxyCalls = [];
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(path, '/api/book-cover/source');
    assert.equal(options.method, 'POST');
    const { url } = JSON.parse(options.body);
    proxyCalls.push(url);
    if (url === covers.offline[1]) return new Response(null, { status: 502 });
    return new Response(new Blob(['cover'], { type: 'image/png' }));
  });
  const originalObserver = globalThis.IntersectionObserver;
  const observed = new Set();
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() { observed.add(this); }
    disconnect() { observed.delete(this); }
  };
  const readProps = { ownerKey, getDetailId: () => null, onOpenBook() {} };
  const row = title => [...window.document.querySelectorAll('article')].find(item => item.querySelector('h3')?.textContent === title);
  const image = title => row(title).querySelector('img');
  const revealCovers = () => act(async () => {
    for (const observer of [...observed]) observer.callback([{ isIntersecting: true }]);
  });
  try {
    await act(async () => root.render(React.createElement(ReadBooks, readProps)));
    for (let attempt = 0; attempt < 40 && !row('direct'); attempt++) await act(async () => delay(10));
    assert.ok(row('direct'));
    assert.equal(image('direct'), null);
    assert.deepEqual(proxyCalls, []);
    await revealCovers();
    assert.equal(image('direct').getAttribute('src'), covers.direct[1]);
    assert.equal(image('direct').getAttribute('referrerPolicy'), 'no-referrer');
    assert.equal(image('hotlink').getAttribute('src'), covers.hotlink[1]);
    assert.match(image('novelpia').getAttribute('src'), /^blob:/);
    assert.deepEqual(proxyCalls, [covers.novelpia[1]]);
    const fail = title => act(async () => image(title).dispatchEvent(new window.Event('error')));
    await fail('hotlink');
    assert.match(image('hotlink').getAttribute('src'), /^blob:/);
    await fail('offline');
    assert.equal(row('offline').querySelector('[data-generated-book-cover-title]').textContent, 'offline');
    await fail('hotlink');
    assert.equal(row('hotlink').querySelector('[data-generated-book-cover-title]').textContent, 'hotlink');
    assert.deepEqual(proxyCalls, [covers.novelpia[1], covers.hotlink[1], covers.offline[1]]);

    await act(async () => root.render(React.createElement(ReadBooks, { ...readProps, onShowAll() {} })));
    await revealCovers();
    const strip = window.document.querySelector('[aria-label="읽은 도서 가로 목록"]');
    assert.ok([...strip.querySelectorAll('img')].some(img => img.getAttribute('src') === covers.direct[1]));
    assert.ok(!proxyCalls.includes(covers.direct[1]));
  } finally {
    await act(async () => root.unmount());
    await closeLocalDB();
    if (originalObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalObserver;
  }
});

test('a previous cover request cannot replace a newer URL for the same book', async (t) => {
  const { window, root } = setup();
  const originalUrl = 'https://comicthumb-phinf.pstatic.net/cover.png?type=w160';
  const updatedUrl = 'https://comicthumb-phinf.pstatic.net/cover.png?type=w200';
  let finish;
  let signal;
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  const render = url => act(async () => root.render(React.createElement(BookCover, {
    url, identity: 'same-book', title: '표지', coverLoading: 'direct-with-proxy-fallback',
  })));
  try {
    await render(originalUrl);
    await act(async () => delay(5));
    const image = () => window.document.querySelector('img');
    await act(async () => image().dispatchEvent(new window.Event('error')));
    assert.equal(signal.aborted, false);
    await render(updatedUrl);
    assert.equal(signal.aborted, true);
    await act(async () => finish(new Response(new Blob(['old cover'], { type: 'image/png' }))));
    await act(async () => delay(5));
    assert.equal(image().getAttribute('src'), updatedUrl);
  } finally {
    await act(async () => root.unmount());
  }
});

test('a mounted read list retries an expired miss on a reading history refresh', async (t) => {
  const { window, root } = setup('#mypage/read');
  const ownerKey = 'firebase:expired-read-miss|library:local';
  const start = Date.UTC(2026, 10, 21, 1);
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const title = '미게시 도서.txt';
  const metadata = {
    schemaVersion: 1, titleKey: 'newly-published', displayTitle: '다시 찾은 도서',
    normalizerVersion: '1.3.3', publishedAt: new Date(start).toISOString(), platforms: [],
  };
  await cacheReadBookMetadata(ownerKey, new Map([[title, { metadata: null, observedAt: start }]]));
  await hydrateRemoteReadingSessionsPageV12(ownerKey, [{
    schemaVersion: 1, sessionId: 'previous-miss', bookId: 'previous-miss', bookTitle: title, deviceId: 'fixture-device',
    startedAtClient: start - 60_000, endedAtClient: start, durationMs: 60_000, startProgressPercent: 1,
    endProgressPercent: 10, timezoneOffsetMinutes: 0, localDate: '2026-11-21', mode: 'screen', completed: false,
  }], null, null, true, false);
  const requests = [];
  globalThis.myPageTestMetadata = (titles, options) => {
    requests.push(...titles);
    const result = { metadata: new Map([[title, metadata]]), failed: new Set() };
    options.onProgress?.(result, title, Date.now() + 60 * 60 * 1000);
    return result;
  };
  const list = () => window.document.querySelector('[aria-label="읽은 책"]');
  try {
    await act(async () => root.render(React.createElement(MyPage, { ...props, ownerKey })));
    for (let attempt = 0; attempt < 40 && list()?.querySelector('[role="status"]'); attempt++) await act(async () => delay(10));
    assert.deepEqual(requests, []);
    assert.doesNotMatch(list().textContent, /다시 찾은 도서|읽은 책을 불러오는 중/);

    t.mock.timers.tick(5 * 60 * 1000);
    await act(async () => notifyReadingStatisticsChange(ownerKey));
    for (let attempt = 0; attempt < 50 && !list()?.textContent.includes('다시 찾은 도서'); attempt++) await act(async () => delay(20));
    assert.deepEqual(requests, [title]);
    assert.match(list().textContent, /다시 찾은 도서/);
  } finally {
    await act(async () => root.unmount());
    await closeLocalDB();
    delete globalThis.myPageTestMetadata;
  }
});

test('dashboard shows confirmed books while a slower title in the same batch is pending', async () => {
  const { window, root } = setup('#mypage/overview');
  const ownerKey = 'firebase:dashboard-first-book|library:local';
  const start = Date.UTC(2026, 10, 21, 1);
  const titles = ['빠르게 매칭된 책', '나중에 매칭된 책'];
  await hydrateRemoteReadingSessionsPageV12(ownerKey, titles.map((title, index) => ({
    schemaVersion: 1, sessionId: title, bookId: title, bookTitle: title, deviceId: 'fixture-device',
    startedAtClient: start + index * 60_000, endedAtClient: start + (index + 1) * 60_000, durationMs: 60_000,
    startProgressPercent: 1, endProgressPercent: 10, timezoneOffsetMinutes: 0,
    localDate: '2026-11-21', mode: 'screen', completed: false,
  })), null, null, true, false);
  let finish;
  globalThis.myPageTestMetadata = (_titles, options) => new Promise((resolve) => {
    const result = { metadata: new Map(), failed: new Set() };
    const publish = (title) => {
      result.metadata.set(title, { titleKey: title, displayTitle: title, platforms: [] });
      options.onProgress(result, title);
    };
    publish(titles[0]);
    finish = () => { publish(titles[1]); resolve(result); };
  });
  const listedTitles = () => [...window.document.querySelectorAll('[aria-label="읽은 도서 가로 목록"] li .line-clamp-2')]
    .map((item) => item.textContent);
  try {
    await act(async () => root.render(React.createElement(MyPage, { ...props, ownerKey })));
    for (let attempt = 0; attempt < 40 && listedTitles().length === 0; attempt++) await act(async () => delay(10));
    assert.deepEqual(listedTitles(), [titles[0]]);
    await act(async () => finish());
    assert.deepEqual(listedTitles(), [...titles].reverse());
  } finally {
    await act(async () => root.unmount());
    await closeLocalDB();
    delete globalThis.myPageTestMetadata;
  }
});

test('dashboard reuses recent cards while reconciling only the current login session', async (t) => {
  const require = createRequire(import.meta.url);
  const { dashboardReviewCache, dashboardWishlistCache } = require('../src/lib/myPageDashboardCache.ts');
  const { ownerRuntime } = require('../src/lib/ownerRuntime.ts');
  const { window, root } = setup('#mypage/overview');
  const uid = 'dashboard-card-reentry';
  const ownerKey = `firebase:${uid}|library:local`;
  const originalBook = { ...book, id: 'wishlist-preview', title: '기억한 위시리스트' };
  const review = { id: 'review-preview', title: '기억한 평가', coverTitle: null, coverUrl: null, rating: 4 };
  const authFixture = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './firebase' && context.parentURL?.endsWith('/myPageSocialClient.ts')) {
        return { url: 'data:text/javascript,' + encodeURIComponent(
          `export const auth = { currentUser: { uid: ${JSON.stringify(uid)}, getIdToken: async () => 'fixture-token' } };`,
        ), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  const refreshes = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).startsWith('/catalog/')) {
      return Response.json({ schemaVersion: 1, generation: uid, genres: [], tags: [], books: [] });
    }
    const view = new URL(url, 'https://test.example').searchParams.get('view');
    assert.ok(view === 'wishlist' || view === 'reviews');
    return new Promise((resolve) => { refreshes.push({ view, resolve }); });
  });
  ownerRuntime.activate(ownerKey);
  const render = () => act(async () => root.render(React.createElement(MyPage, { ...props, ownerKey })));
  const list = (title) => window.document.querySelector(`[aria-label="${title} 가로 목록"]`);
  try {
    await render();
    for (let attempt = 0; attempt < 20 && refreshes.length < 2; attempt++) await act(async () => delay(10));
    assert.equal(refreshes.length, 2);
    await act(async () => {
      for (const { view, resolve } of refreshes.splice(0)) {
        resolve(Response.json(view === 'wishlist'
          ? { entries: [{ book: originalBook, item: { workId: originalBook.id, saved: true, revision: 1, addedAt: 0 }, aliases: [] }] }
          : { reviews: [{ workId: review.id, title: review.title, rating: review.rating }], deletions: [] }));
      }
    });
    await act(async () => root.render(null));
    await render();
    assert.match(list('읽고 싶은 도서').textContent, /기억한 위시리스트/);
    assert.match(list('평점을 남긴 도서').textContent, /기억한 평가/);
    const readBeforeWrite = dashboardWishlistCache.beginRead(ownerKey);
    let finishWrite;
    await act(async () => { finishWrite = dashboardWishlistCache.beginWrite(ownerKey); });
    assert.equal(dashboardWishlistCache.beginRead(ownerKey)([originalBook]), false);
    finishWrite();
    await act(async () => readBeforeWrite([originalBook]));
    assert.equal(list('읽고 싶은 도서'), null);
    const previousLoginReviewRead = dashboardReviewCache.beginRead(ownerKey);
    await act(async () => root.render(null));
    ownerRuntime.clear();
    ownerRuntime.activate(ownerKey);
    previousLoginReviewRead([review]);
    await render();
    assert.equal(list('읽고 싶은 도서'), null);
    assert.equal(list('평점을 남긴 도서'), null);
  } finally {
    await act(async () => root.unmount());
    for (const { resolve } of refreshes) resolve(new Response(null, { status: 503 }));
    ownerRuntime.clear();
    await closeLocalDB();
    authFixture.deregister();
  }
});

test('a warm dashboard resolves titles tied with the last visible book', async () => {
  const { window, root } = setup('#mypage/overview');
  const ownerKey = 'firebase:dashboard-read-tie|library:local';
  const start = Date.UTC(2026, 10, 21, 1);
  const titles = [...Array.from({ length: 12 }, (_, index) => `Z${String(index).padStart(2, '0')}`), 'A'];
  const makeMetadata = (title) => ({
    schemaVersion: 1, titleKey: title, displayTitle: title,
    normalizerVersion: '1.3.3', publishedAt: new Date(start).toISOString(), platforms: [],
  });
  await cacheReadBookMetadata(ownerKey, new Map(titles.slice(0, 12).map((title) => (
    [title, { metadata: makeMetadata(title), observedAt: Date.now() }]
  ))));
  await hydrateRemoteReadingSessionsPageV12(ownerKey, titles.map((title, index) => {
    const endedAtClient = start - Math.min(index, 11) * 1000;
    return {
      schemaVersion: 1, sessionId: title, bookId: title, bookTitle: title, deviceId: 'fixture-device',
      startedAtClient: endedAtClient - 60_000, endedAtClient, durationMs: 60_000, startProgressPercent: 1,
      endProgressPercent: 10, timezoneOffsetMinutes: 0, localDate: '2026-11-21', mode: 'screen', completed: false,
    };
  }), null, null, true, false);
  const requests = [];
  globalThis.myPageTestMetadata = (pending, options) => {
    requests.push(...pending);
    const result = { metadata: new Map([['A', makeMetadata('A')]]), failed: new Set() };
    options.onProgress?.(result, 'A', Date.now() + 60 * 60 * 1000);
    return result;
  };
  const shelfTitles = () => [...window.document.querySelectorAll('section[aria-label="읽은 도서"] li .line-clamp-2')]
    .map((item) => item.textContent.trim());
  try {
    await act(async () => root.render(React.createElement(MyPage, { ...props, ownerKey })));
    for (let attempt = 0; attempt < 40 && !shelfTitles().includes('A'); attempt++) await act(async () => delay(10));
    assert.deepEqual(requests, ['A']);
    assert.deepEqual(shelfTitles(), [...titles.slice(0, 11), 'A']);
  } finally {
    await act(async () => root.unmount());
    await closeLocalDB();
    delete globalThis.myPageTestMetadata;
  }
});

test('MyPage renders as a page, removes saved books, and isolates account changes', async () => {
  const { window, storage, root } = setup();
  setWishlistSaved(owner, book, true, storage);
  try {
    await act(async () => root.render(React.createElement(MyPage, props)));
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    assert.match(window.document.querySelector('main').textContent, /테스트 도서/);
    const wishlistSort = () => window.document.querySelector('select[aria-label="위시리스트 정렬"]');
    const selectedSort = () => wishlistSort().querySelector('option:checked').value;
    await select(window, wishlistSort(), 'title');
    await act(async () => root.render(null));
    await act(async () => root.render(React.createElement(MyPage, props)));
    assert.equal(selectedSort(), 'title');
    await act(async () => root.render(React.createElement(MyPage, { ...props, ownerKey: 'guest:other|library:local' })));
    assert.doesNotMatch(window.document.querySelector('main').textContent, /테스트 도서/);
    assert.equal(selectedSort(), 'saved');
    await select(window, wishlistSort(), 'views');
    await act(async () => root.render(React.createElement(MyPage, props)));
    assert.equal(selectedSort(), 'title');
    await click(window, window.document.querySelector('button[aria-label="테스트 도서 위시리스트 제거"]'));
    assert.equal(window.location.hash, '#mypage/wishlist');
    assert.match(window.document.querySelector('main').textContent, /담아둔 책 0권/);
    const dashboard = [...window.document.querySelectorAll('nav button')].find(button => button.textContent === '홈');
    await click(window, dashboard);
    assert.equal(window.location.hash, '#mypage/overview');
    await act(async () => window.history.back());
    assert.equal(window.document.querySelector('main').getAttribute('aria-label'), '위시리스트');
  } finally { await act(async () => root.unmount()); await closeLocalDB(); }
});

test('a MyPage deep link waits for startup and does not intercept reader panel Back', async () => {
  const { window, root } = setup('#mypage/annotations');
  let view, setView;
  const autoOpenHandledRef = { current: false };
  function Harness() {
    const [currentView, updateView] = React.useState('loading');
    React.useEffect(() => { view = currentView; setView = updateView; }, [currentView]);
    useMyPageNavigation({ view: currentView, setView: updateView, isLibraryBootstrapReady: true, autoOpenHandledRef });
    return null;
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(view, 'loading');
    await act(async () => setView('shelf'));
    assert.equal(view, 'mypage');
    assert.equal(autoOpenHandledRef.current, true);
    await act(async () => setView('reader'));
    await act(async () => window.dispatchEvent(new window.Event('popstate')));
    assert.equal(view, 'reader');
  } finally { await act(async () => root.unmount()); }
});

test('a saved title opens a themed detail page with optional private records and anonymous ratings', async () => {
  const { window, storage, root } = setup();
  const platform = series;
  const saved = savedBook;
  setWishlistSaved(owner, saved, true, storage);
  const originalFetch = globalThis.fetch;
  let reviewRequest;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('/catalog/discovery.v1.json')) {
      return Response.json({
        schemaVersion: 1, generation: 'detail-test', genres: [saved.genre], tags: [],
        books: savedCatalog,
      });
    }
    if (String(url).startsWith('/api/book-reviews?')) {
      reviewRequest = new URL(url, 'https://preview.example').searchParams.get('workId');
      return Response.json({ reviews: [
        { author: { code: '7K4M2Q8R', nickname: '행복한사자' }, rating: 4, comment: '', totalMs: 120_000, progressPercent: 40 },
        { author: { code: '2KC541BR', nickname: '책읽는토끼' }, rating: 5, comment: '몰입해서 읽었어요.', totalMs: 180_000, progressPercent: 61.4 },
      ], average: 4.5, ratingCount: 2 });
    }
    throw new Error('Unexpected network request');
  };
  const main = () => window.document.querySelector('main');
  const localBook = { id: 'private-file-id', name: '테스트 도서.epub', mimeType: 'application/epub+zip' };
  const start = Date.UTC(2026, 10, 20, 5);
  const historyRequests = [];
  globalThis.myPageTestMetadata = (titles) => {
    historyRequests.push(...titles);
    return { metadata: new Map(titles.map((title) => [title, null])), failed: new Set() };
  };
  const cachedMetadata = {
    schemaVersion: 1, titleKey: saved.id, displayTitle: saved.title,
    normalizerVersion: '1.3.3', publishedAt: new Date(start).toISOString(), platforms: [],
  };
  await cacheReadBookMetadata(owner, new Map([[localBook.name, { metadata: cachedMetadata, observedAt: Date.now() }]]));
  const bookmark = { id: 'bookmark', name: '로컬 책갈피', type: 'manual', progressPercent: 14, cfi: 'cfi', color: '', createdAt: start };
  try {
    await saveLocalReadingSessionV11(owner, {
      schemaVersion: 1, sessionId: 'detail-session', bookId: localBook.id, bookTitle: localBook.name, deviceId: 'detail-test',
      startedAtClient: start, endedAtClient: start + 60_000, durationMs: 60_000, startProgressPercent: 12,
      endProgressPercent: 18, timezoneOffsetMinutes: 0, localDate: '2026-11-20', mode: 'screen', completed: false,
    });
    const progress = { [localBook.id]: { bookId: localBook.id, cfi: 'remote', lastRead: start + 60_000, progressPercent: 20, syncRevision: 2 } };
    const bookmarkProgress = { [localBook.id]: { bookId: localBook.id, cfi: 'cfi', lastRead: start, progressPercent: 18, syncRevision: 1, bookmarks: [bookmark, { ...bookmark, id: 'second', name: '두 번째 책갈피' }] } };
    await act(async () => root.render(React.createElement(MyPage, { ...props, books: [localBook], progress, bookmarkProgress })));
    const link = main().querySelector('article > a');
    assert.equal(link.getAttribute('href'), '#mypage/book/' + encodeURIComponent(saved.id));
    assert.match(main().textContent, /네이버 시리즈/);
    assert.equal(main().querySelector('a[href^="https://series.naver.com"]'), null);
    const platformLabel = [...link.querySelectorAll('span')].find((item) => item.textContent === platform.label);
    await click(window, platformLabel);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.equal(window.location.hash, link.getAttribute('href'));
    assert.equal(main().getAttribute('aria-label'), '도서 상세정보');
    assert.equal(reviewRequest, saved.id);
    assert.ok(historyRequests.includes(saved.id));
    assert.ok(!historyRequests.includes(localBook.name));
    const basic = main().querySelector('[aria-label="도서 기본정보"]');
    assert.equal(basic.querySelector('a[href^="https://series.naver.com"]').textContent, platform.label);
    assert.equal(basic.querySelector('a[href^="https://page.kakao.com"]').textContent, '카카오페이지');
    assert.deepEqual([...basic.querySelectorAll('[role="img"]')].map((icon) => icon.getAttribute('aria-label')),
      ['읽은 기록 있음', '위시리스트에 담김']);
    const personal = main().querySelector('[aria-label="내 독서 기록"]');
    assert.match(personal.textContent, /읽은 시간1분/);
    assert.match(personal.textContent, /진행도18%/);
    assert.match(personal.textContent, /로컬 책갈피/);
    assert.equal(personal.querySelector('.mypage-divided-list').children.length, 2);
    const reviews = main().querySelector('[aria-label="다른 독자의 평가"]');
    assert.equal(reviews.querySelectorAll('li').length, 2);
    assert.match(reviews.querySelector('li').textContent, /행복한사자#7K4M2Q8R.*4\/5.*2분 읽음.*40%/);
    assert.equal(reviews.querySelector('li a').getAttribute('href'), '/people/7K4M2Q8R');
    assert.match(reviews.textContent, /4\.50 \/ 5 공개 평가 2개/);
    assert.match(reviews.textContent, /몰입해서 읽었어요./);
    await click(window, window.document.querySelector('button[aria-label="도서 목록으로 돌아가기"]'));
    assert.equal(window.location.hash, '#mypage/wishlist');
    assert.match(main().textContent, /테스트 도서/);
    const freshOwner = 'guest:detail-other|library:local';
    await act(async () => root.render(React.createElement(MyPage, { ...props, key: freshOwner, ownerKey: freshOwner })));
    await click(window, [...window.document.querySelectorAll('nav button')].find((button) => button.textContent === '도서'));
    const selected = main().querySelectorAll(`article a[href="#mypage/book/${encodeURIComponent(saved.id)}"]`);
    assert.equal(selected.length, 1);
    await click(window, selected[0]);
    assert.equal(main().querySelector('[aria-label="내 독서 기록"]'), null);
    assert.equal(main().querySelector('[aria-label="읽은 기록 있음"]'), null);
    assert.ok(main().querySelector('[aria-label="위시리스트에 담기지 않음"]'));
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    delete globalThis.myPageTestMetadata;
    await closeLocalDB();
  }
});

test('dashboard review writes trigger one fresh read and discard the pre-write response', async (t) => {
  const require = createRequire(import.meta.url);
  const { dashboardReviewCache } = require('../src/lib/myPageDashboardCache.ts');
  const { ownerRuntime } = require('../src/lib/ownerRuntime.ts');
  const { MyReviews } = require('../src/components/mypage/MyReviews.tsx');
  const { window, root } = setup('#mypage/overview');
  const uid = 'dashboard-write-race';
  const ownerKey = `firebase:${uid}|library:local`;
  const authFixture = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './firebase' && context.parentURL?.endsWith('/myPageSocialClient.ts')) {
        return { url: 'data:text/javascript,' + encodeURIComponent(
          `export const auth = { currentUser: { uid: ${JSON.stringify(uid)}, getIdToken: async () => 'fixture-token' } };`,
        ), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  const reads = [];
  t.mock.method(globalThis, 'fetch', async (resource) => {
    assert.match(String(resource), /view=reviews&preview=1/);
    return new Promise((resolve) => reads.push(resolve));
  });
  const response = (rating) => Response.json({
    reviews: [{ workId: 'review-identity', title: '평가한 책', rating }], deletions: [],
  });
  const title = () => window.document.querySelector('[aria-label="평점을 남긴 도서 가로 목록"]')?.textContent ?? '';
  ownerRuntime.activate(ownerKey);
  try {
    const finishFirst = dashboardReviewCache.beginWrite(ownerKey);
    await act(async () => root.render(React.createElement(MyReviews, { owner: ownerKey, onOpenBook() {}, onShowAll() {} })));
    assert.equal(reads.length, 0);
    await act(async () => finishFirst());
    for (let attempt = 0; attempt < 20 && reads.length < 1; attempt++) await act(async () => delay(10));
    assert.equal(reads.length, 1);

    let finishSecond;
    await act(async () => { finishSecond = dashboardReviewCache.beginWrite(ownerKey); });
    await act(async () => finishSecond());
    for (let attempt = 0; attempt < 20 && reads.length < 2; attempt++) await act(async () => delay(10));
    assert.equal(reads.length, 2);
    await act(async () => reads[0](response(2)));
    assert.doesNotMatch(title(), /2\/5/);
    await act(async () => reads[1](response(5)));
    assert.match(title(), /5\/5/);
    assert.equal(reads.length, 2);
  } finally {
    await act(async () => root.unmount());
    for (const finish of reads) finish(response(1));
    ownerRuntime.clear();
    authFixture.deregister();
  }
});

test('account wishlist reloads after a revision conflict and on visible return', async (t) => {
  const { useAccountWishlist } = await import('../src/hooks/useAccountWishlist.ts');
  const { window, root } = setup('#mypage/wishlist');
  const uid = 'wishlist-revision-conflict';
  const ownerKey = `firebase:${uid}|library:local`;
  const authFixture = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './firebase' && context.parentURL?.endsWith('/myPageSocialClient.ts')) {
        return { url: 'data:text/javascript,' + encodeURIComponent(
          `export const auth = { currentUser: { uid: ${JSON.stringify(uid)}, getIdToken: async () => 'fixture-token' } };`,
        ), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  let revision = 1;
  let saved = true;
  let reads = 0;
  const posts = [];
  const entry = () => ({
    item: { workId: book.id, saved, revision, addedAt: 10 },
    book, aliases: [], siblingRevisions: [{ workId: book.id, revision }],
  });
  t.mock.method(globalThis, 'fetch', async (resource, options) => {
    const params = new URL(resource, 'https://test.example').searchParams;
    if (params.get('view') === 'wishlist') {
      reads++;
      return Response.json({ entries: [entry()] });
    }
    assert.equal(params.get('action'), 'wishlist');
    const body = JSON.parse(options.body);
    posts.push(body);
    if (posts.length === 1) {
      revision++;
      return new Response(null, { status: 409 });
    }
    assert.deepEqual(body.siblingRevisions, entry().siblingRevisions);
    revision++;
    saved = body.saved;
    return Response.json(entry());
  });
  const Fixture = () => {
    const state = useAccountWishlist(ownerKey, true);
    const active = state.savedIds.has(book.id);
    return React.createElement('button', {
      disabled: state.loading || state.saving,
      onClick: () => void state.setSaved(book, !active),
    }, active ? '담김' : '비어 있음');
  };
  const button = () => window.document.querySelector('button');
  const waitFor = async (condition) => {
    for (let count = 0; count < 20 && !condition(); count++) await act(async () => delay(10));
    assert.ok(condition());
  };
  try {
    await act(async () => root.render(React.createElement(Fixture)));
    await waitFor(() => button().textContent === '담김');
    await click(window, button());
    await waitFor(() => reads === 2 && !button().disabled);
    await click(window, button());
    await waitFor(() => button().textContent === '비어 있음');
    assert.deepEqual(posts.map(({ revision }) => revision), [1, 2]);

    revision++;
    saved = true;
    await act(async () => window.document.dispatchEvent(new window.Event('visibilitychange')));
    await waitFor(() => button().textContent === '담김');
    assert.equal(reads, 3);
  } finally {
    await act(async () => root.unmount());
    authFixture.deregister();
  }
});
