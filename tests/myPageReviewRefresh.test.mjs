import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

const owner = 'firebase:review-test|library:local';
let authUid = 'review-test';
globalThis.myPageReviewTestAuth = () => authUid;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './firebase' && context.parentURL?.endsWith('/myPageSocialClient.ts')) {
      return { url: 'data:text/javascript,' + encodeURIComponent("export const auth = { get currentUser() { const uid = globalThis.myPageReviewTestAuth(); return { uid, getIdToken: async () => 'token-' + uid }; } };"), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { MyReviews } = await import('../src/components/mypage/MyReviews.tsx');
const { useMyPageReviews } = await import('../src/hooks/useMyPageReviews.ts');
const { useMyPageWorkReview } = await import('../src/hooks/useMyPageList.ts');
const { ownerRuntime } = await import('../src/lib/ownerRuntime.ts');
const review = { workId: 'book', title: 'Book', rating: 4, revision: 1 };
const result = reviews => Response.json({ reviews, deletions: [] });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function until(predicate) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await act(async () => { await tick(); });
  assert.ok(predicate(), 'Expected the asynchronous review update to settle');
}

function setup(t) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  ownerRuntime.activate(owner);
  t.after(() => ownerRuntime.clear());
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  window.location = new URL('https://reader.example/');
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window.document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
  return { window, root: createRoot(window.document.getElementById('root')), advance: () => { now += 65_000; } };
}
const click = async (window, element) => act(async () => element.dispatchEvent(new window.Event('click', { bubbles: true })));

test('book detail requests only its own review and ignores a late response for the previous work', async (t) => {
  const { window, root } = setup(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', (url, { signal }) => new Promise(resolve => {
    const params = new URL(url, window.location.href).searchParams;
    requests.push({ params, signal, resolve });
  }));
  function Detail({ workId }) {
    const { data, ready } = useMyPageWorkReview(owner, true, workId);
    return React.createElement('p', null, ready ? data.reviews[0]?.workId ?? 'empty' : 'loading');
  }
  try {
    await act(async () => root.render(React.createElement(Detail, { workId: 'first' })));
    await until(() => requests.length === 1);
    await act(async () => root.render(React.createElement(Detail, { workId: 'second' })));
    await until(() => requests.length === 2);
    assert.deepEqual(requests.map(({ params }) => [...params]), [
      [['view', 'own-review'], ['workId', 'first']], [['view', 'own-review'], ['workId', 'second']],
    ]);
    assert.equal(requests[0].signal.aborted, true);
    await act(async () => requests[1].resolve(result([{ ...review, workId: 'second' }])));
    await act(async () => requests[0].resolve(result([{ ...review, workId: 'first' }])));
    assert.equal(window.document.querySelector('p').textContent, 'second');
  } finally { await act(async () => root.unmount()); }
});

test('delete invalidates a late list response and refreshes; focus and visibility reload remote changes', async t => {
  const { window, root, advance } = setup(t);
  let calls = 0;
  let resolveStale;
  let remote = [review];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'POST') { remote = []; return result([]); }
    calls++;
    if (calls === 2) return new Promise(resolve => { resolveStale = resolve; });
    return result(remote);
  });
  try {
    await act(async () => { root.render(React.createElement(MyReviews, { owner, onOpenBook() {} })); await tick(); });
    await until(() => window.document.querySelector('[aria-label="Book 평가 삭제"]'));
    advance();
    await act(async () => { window.dispatchEvent(new window.Event('focus')); await tick(); });
    await until(() => typeof resolveStale === 'function');
    assert.equal(calls, 2);
    await click(window, window.document.querySelector('[aria-label="Book 평가 삭제"]'));
    await click(window, [...window.document.querySelectorAll('button')].find(button => button.textContent === '삭제 확인'));
    await act(async () => { await tick(); resolveStale(result([review])); await tick(); });
    await until(() => calls === 3);
    assert.equal(window.document.querySelector('[aria-label="Book 평가 삭제"]'), null);
    remote = [review];
    await act(async () => { window.document.visibilityState = 'hidden'; window.document.dispatchEvent(new window.Event('visibilitychange')); window.dispatchEvent(new window.Event('focus')); await tick(); });
    assert.equal(calls, 3);
    advance();
    await act(async () => { window.document.visibilityState = 'visible'; window.document.dispatchEvent(new window.Event('visibilitychange')); window.dispatchEvent(new window.Event('focus')); await tick(); });
    await until(() => window.document.querySelector('[aria-label="Book 평가 삭제"]'));
    assert.equal(calls, 4);
  } finally { await act(async () => root.unmount()); }
});

test('detail reviews share a pending read and retain usable results through remount and revalidation', async (t) => {
  const { window, root, advance } = setup(t);
  const pending = [];
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => pending.push(resolve)));
  function Detail() {
    const { data, ready } = useMyPageReviews(owner, true);
    return React.createElement('p', null, ready ? data.reviews.length : 'loading');
  }
  const detail = () => React.createElement(Detail);
  const displayed = () => [...window.document.querySelectorAll('p')].map(p => p.textContent);
  try {
    await act(async () => { root.render(React.createElement(React.Fragment, null, detail(), detail())); await tick(); });
    await until(() => pending.length === 1);
    await act(async () => { window.document.dispatchEvent(new window.Event('visibilitychange')); window.dispatchEvent(new window.Event('focus')); await tick(); });
    assert.equal(pending.length, 1);
    await act(async () => pending[0](result([review])));
    assert.deepEqual(displayed(), ['1', '1']);
    await act(async () => root.render(null));
    await act(async () => { root.render(detail()); await tick(); });
    assert.deepEqual(displayed(), ['1']);
    assert.equal(pending.length, 1);
    advance();
    await act(async () => { window.document.dispatchEvent(new window.Event('visibilitychange')); window.dispatchEvent(new window.Event('focus')); await tick(); });
    await until(() => pending.length === 2);
    assert.deepEqual(displayed(), ['1']);
    await act(async () => pending[1](result([])));
    assert.deepEqual(displayed(), ['0']);
  } finally { await act(async () => root.unmount()); }
});

test('a 401 discards both private review responses, including a pending preview', async (t) => {
  const { root, window, advance } = setup(t);
  let fullReads = 0;
  let previewReads = 0;
  let resolvePreview;
  t.mock.method(globalThis, 'fetch', (url) => {
    if (String(url).includes('preview=1')) {
      if (++previewReads === 1) return Promise.resolve(result([review]));
      return new Promise(resolve => { resolvePreview = resolve; });
    }
    return Promise.resolve(++fullReads === 1 ? result([review]) : new Response(null, { status: 401 }));
  });
  function Detail() {
    const { data } = useMyPageReviews(owner, true);
    return React.createElement('p', { id: 'detail' }, data?.reviews.length ?? 'empty');
  }
  try {
    await act(async () => { root.render(React.createElement(React.Fragment, null,
      React.createElement(Detail), React.createElement(MyReviews, { owner, onOpenBook() {}, onShowAll() {} }))); await tick(); });
    const detail = () => window.document.querySelector('#detail').textContent;
    const card = () => window.document.querySelector('[aria-label="평점을 남긴 도서 가로 목록"]');
    await until(() => detail() === '1' && card());
    advance();
    await act(async () => { window.dispatchEvent(new window.Event('focus')); await tick(); });
    await until(() => detail() === 'empty' && !card() && typeof resolvePreview === 'function');
    await act(async () => resolvePreview(result([review])));
    assert.equal(card(), null);
  } finally { await act(async () => root.unmount()); }
});

test.after(() => { hook.deregister(); delete globalThis.myPageReviewTestAuth; });

test('switching accounts discards a private response that arrives for the previous account', async (t) => {
  const { window, root } = setup(t);
  let resolvePrevious;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    switch (options.headers.get('Authorization')) {
      case 'Bearer token-review-test':
        return new Promise((resolve) => { resolvePrevious = resolve; });
      case 'Bearer token-review-other':
        return result([{ ...review, workId: 'other', title: 'Other account book' }]);
      default:
        throw new Error('Unexpected account');
    }
  });
  const render = (currentOwner) => root.render(React.createElement(MyReviews, {
    key: currentOwner, owner: currentOwner, onOpenBook() {},
  }));
  try {
    await act(async () => { render(owner); await tick(); });
    await until(() => typeof resolvePrevious === 'function');
    authUid = 'review-other';
    ownerRuntime.activate('firebase:review-other|library:local');
    await act(async () => { render('firebase:review-other|library:local'); await tick(); });
    await act(async () => { resolvePrevious(result([review])); await tick(); });
    await until(() => window.document.querySelector('[aria-label="Other account book 평가 삭제"]'));
    assert.equal(window.document.querySelector('[aria-label="Book 평가 삭제"]'), null);
  } finally {
    authUid = 'review-test';
    await act(async () => root.unmount());
  }
});
