import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { MyPage } from '../src/components/mypage/MyPage.tsx';
import { ReadBooks } from '../src/components/mypage/ReadBooks.tsx';
import { useMyPageNavigation } from '../src/hooks/useMyPageNavigation.ts';
import { setWishlistSaved } from '../src/lib/localWishlist.ts';
import { closeLocalDB } from '../src/lib/localDB.ts';
import { hydrateRemoteReadingSessionsPageV12, saveLocalReadingSessionV11 } from '../src/lib/localReadingStatistics.ts';

const owner = 'guest:mypage-test|library:local';
const book = { id: 'test-book', title: '테스트 도서', coverUrl: null, platforms: [], genre: '판타지', tags: [], popularity: 10, sourceCount: null };
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

test('a rating appears during a pending save and rolls back after the retries fail', async (t) => {
  const { window, root } = setup('#mypage/read');
  const uid = 'rating-ui';
  const ownerKey = `firebase:${uid}|library:local`;
  const title = '별점 저장 테스트';
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const { parentURL = '' } = context;
      if (specifier === './firebase' && parentURL.endsWith('/myPageSocialClient.ts')) {
        return { url: 'data:text/javascript,' + encodeURIComponent(
          `export const auth = { currentUser: { uid: ${JSON.stringify(uid)}, getIdToken: async () => 'fixture-token' } };`,
        ), shortCircuit: true };
      }
      if (specifier === '../../lib/readBookMetadata' && parentURL.includes('/mypage/ReadBooks.tsx')) {
        return { url: 'data:text/javascript,' + encodeURIComponent(
          `export const loadReadBookMetadata = async (titles, { onProgress }) => {
            const result = { metadata: new Map(), failed: new Set() };
            for (const title of titles) {
              result.metadata.set(title, { titleKey: title, displayTitle: title, platforms: [] });
              onProgress(result, title);
            }
            return result;
          };`,
        ), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  const start = Date.UTC(2026, 10, 20, 5);
  const committed = { workId: title, rating: 2, comment: '', revision: 1, totalMs: 60_000, progressPercent: 20 };
  const writes = [];
  let rejectFirst;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(String(url), /^\/api\/mypage\?/);
    if (options.method === 'GET') return Response.json({ reviews: [committed], deletions: [] });
    writes.push(JSON.parse(options.body));
    if (writes.length === 1) return new Promise((_, reject) => { rejectFirst = reject; });
    return new Response(null, { status: 503 });
  });
  const visible = (selector) => window.document.querySelector(selector);
  try {
    await hydrateRemoteReadingSessionsPageV12(ownerKey, [{
      schemaVersion: 1, sessionId: 'review-session', bookId: 'review-book', bookTitle: title, deviceId: 'review-device',
      startedAtClient: start, endedAtClient: start + 60_000, durationMs: 60_000, startProgressPercent: 0,
      endProgressPercent: 20, timezoneOffsetMinutes: 0, localDate: '2026-11-20', mode: 'screen', completed: false,
    }], null, null, true, false);
    await act(async () => root.render(React.createElement(ReadBooks, { ownerKey, onOpenBook() {}, accountStorage: true })));
    for (let attempt = 0; attempt < 20 && !visible('[aria-label="별점 2점"]'); attempt++) {
      await act(async () => delay(20));
    }
    assert.ok(visible('[aria-label="별점 2점"]'), window.document.body.textContent);
    await click(window, visible(`[aria-label="${title} 평가 수정"]`));
    await click(window, visible('[aria-label="4점"]'));
    await act(async () => visible('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.ok(visible('[aria-label="별점 4점"]'));
    assert.equal(visible('form'), null);
    assert.equal(writes.length, 1);
    await act(async () => { rejectFirst(new TypeError('connection lost')); });
    assert.ok(visible('[aria-label="별점 4점"]'));
    for (let attempt = 0; attempt < 30 && !visible('[role="alert"]'); attempt++) {
      await act(async () => delay(75));
    }
    assert.equal(writes.length, 3);
    assert.ok(writes[0].saveId);
    assert.deepEqual(writes, [writes[0], writes[0], writes[0]]);
    assert.ok(visible('[aria-label="별점 2점"]'));
    assert.equal(visible('[aria-label="별점 4점"]'), null);
    assert.match(visible('[role="alert"]').textContent, /서버와 연결하지 못했습니다/);
  } finally {
    await act(async () => root.unmount());
    await closeLocalDB();
    hook.deregister();
  }
});

test('MyPage renders as a page, removes saved books, and isolates account changes', async () => {
  const { window, storage, root } = setup();
  setWishlistSaved(owner, book, true, storage);
  try {
    await act(async () => root.render(React.createElement(MyPage, props)));
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    assert.match(window.document.querySelector('main').textContent, /테스트 도서/);
    await act(async () => root.render(React.createElement(MyPage, { ...props, ownerKey: 'guest:other|library:local' })));
    assert.doesNotMatch(window.document.querySelector('main').textContent, /테스트 도서/);
    await act(async () => root.render(React.createElement(MyPage, props)));
    await click(window, window.document.querySelector('button[aria-label="테스트 도서 위시리스트 제거"]'));
    assert.equal(window.location.hash, '#mypage/wishlist');
    assert.match(window.document.querySelector('main').textContent, /담아둔 책 0권/);
    const dashboard = [...window.document.querySelectorAll('nav button')].find(button => button.textContent === '대시보드');
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
  const platform = { id: 'series', label: '네이버 시리즈', url: 'https://series.naver.com/novel/detail.series?productNo=1' };
  const otherPlatform = { id: 'kakao', url: 'https://page.kakao.com/content/12' };
  const saved = { ...book, id: '테스트도서', platforms: [platform] };
  setWishlistSaved(owner, saved, true, storage);
  const originalFetch = globalThis.fetch;
  let reviewRequest;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('/catalog/discovery.v1.json')) {
      return Response.json({
        schemaVersion: 1, generation: 'detail-test', genres: [saved.genre], tags: [],
        books: [
          [saved.id, saved.title, null, [[platform.id, platform.url]], 0, [], 10, null],
          [saved.id + '별칭', '다른 표시 제목', null, [[platform.id, platform.url], [otherPlatform.id, otherPlatform.url]], 0, [], 10, null],
        ],
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
  const bookmark = { id: 'bookmark', name: '로컬 책갈피', type: 'manual', progressPercent: 14, cfi: 'cfi', color: '', createdAt: start };
  try {
    await saveLocalReadingSessionV11(owner, {
      schemaVersion: 1, sessionId: 'detail-session', bookId: localBook.id, bookTitle: localBook.name, deviceId: 'detail-test',
      startedAtClient: start, endedAtClient: start + 60_000, durationMs: 60_000, startProgressPercent: 12,
      endProgressPercent: 18, timezoneOffsetMinutes: 0, localDate: '2026-11-20', mode: 'screen', completed: false,
    });
    const progress = { [localBook.id]: { bookId: localBook.id, cfi: 'remote', lastRead: start + 60_000, progressPercent: 20, syncRevision: 2 } };
    const bookmarkProgress = { [localBook.id]: { bookId: localBook.id, cfi: 'cfi', lastRead: start, progressPercent: 18, syncRevision: 1, bookmarks: [bookmark] } };
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
    const basic = main().querySelector('[aria-label="도서 기본정보"]');
    assert.equal(basic.querySelector('a[href^="https://series.naver.com"]').textContent, platform.label);
    assert.equal(basic.querySelector('a[href^="https://page.kakao.com"]').textContent, '카카오페이지');
    assert.deepEqual([...basic.querySelectorAll('[role="img"]')].map((icon) => icon.getAttribute('aria-label')),
      ['읽은 기록 있음', '위시리스트에 담김']);
    const personal = main().querySelector('[aria-label="내 독서 기록"]');
    assert.match(personal.textContent, /읽은 시간1분/);
    assert.match(personal.textContent, /12%–18%/);
    assert.match(personal.textContent, /로컬 책갈피/);
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
    await click(window, [...window.document.querySelectorAll('nav button')].find((button) => button.textContent === '도서 탐색'));
    assert.equal(main().querySelectorAll('article').length, 1);
    await click(window, main().querySelector('article h3'));
    assert.equal(main().querySelector('[aria-label="내 독서 기록"]'), null);
    assert.equal(main().querySelector('[aria-label="읽은 기록 있음"]'), null);
    assert.ok(main().querySelector('[aria-label="위시리스트에 담기지 않음"]'));
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    await closeLocalDB();
  }
});
