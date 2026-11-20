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
const review = { workId: 'book', title: 'Book', rating: 4, revision: 1 };
const result = reviews => Response.json({ reviews, deletions: [] });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function until(predicate) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await act(async () => { await tick(); });
  assert.ok(predicate(), 'Expected the asynchronous review update to settle');
}

function setup() {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window.document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
  return { window, root: createRoot(window.document.getElementById('root')) };
}
const click = async (window, element) => act(async () => element.dispatchEvent(new window.Event('click', { bubbles: true })));

test('delete invalidates a late list response and refreshes; focus and visibility reload remote changes', async t => {
  const { window, root } = setup();
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
    await act(async () => { window.document.visibilityState = 'visible'; window.document.dispatchEvent(new window.Event('visibilitychange')); window.dispatchEvent(new window.Event('focus')); await tick(); });
    await until(() => window.document.querySelector('[aria-label="Book 평가 삭제"]'));
    assert.equal(calls, 4);
  } finally { await act(async () => root.unmount()); }
});

test('detail reviews refresh on visible return and ignore an older response', async t => {
  const { window, root } = setup();
  let calls = 0;
  let resolveStale;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { resolveStale = resolve; });
    return result([]);
  });
  function Detail() {
    const { data } = useMyPageReviews(owner, true);
    return React.createElement('p', null, data?.reviews.length ?? 'loading');
  }
  try {
    await act(async () => { root.render(React.createElement(Detail)); await tick(); });
    await act(async () => { window.document.dispatchEvent(new window.Event('visibilitychange')); window.dispatchEvent(new window.Event('focus')); await tick(); });
    assert.equal(calls, 2);
    await act(async () => { resolveStale(result([review])); await tick(); });
    assert.equal(window.document.querySelector('p').textContent, '0');
  } finally { await act(async () => root.unmount()); }
});

test.after(() => { hook.deregister(); delete globalThis.myPageReviewTestAuth; });

test('switching accounts discards a private response that arrives for the previous account', async (t) => {
  const { window, root } = setup();
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
    await act(async () => { render('firebase:review-other|library:local'); await tick(); });
    await act(async () => { resolvePrevious(result([review])); await tick(); });
    await until(() => window.document.querySelector('[aria-label="Other account book 평가 삭제"]'));
    assert.equal(window.document.querySelector('[aria-label="Book 평가 삭제"]'), null);
  } finally {
    authUid = 'review-test';
    await act(async () => root.unmount());
  }
});
