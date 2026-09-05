/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS matches the TS hooks module boundary and shares ownerRuntime singleton identity. */
// Search modal and engine lifetime regressions with deferred callbacks.
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { parseHTML } = require('linkedom');
const { createRoot } = require('react-dom/client');
const { EpubSearchModal } = require('../src/components/EpubSearchModal.tsx');

test('late search results, progress and completion cannot change a newer query', async () => {
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = Object.fromEntries(keys.map(k => [k, globalThis[k]]));
  const dom = parseHTML('<html><body><div id="app"></div></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  window.getComputedStyle = () => ({ paddingRight: '0px' });
  window.scrollTo = () => {};
  window.scrollX = 0; window.scrollY = 0; window.innerWidth = 800;
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const timers = new Map(); let id = 0;
  globalThis.setTimeout = (fn, delay, ...args) => delay === 500
    ? (timers.set(--id, () => fn(...args)), id) : originalSet(fn, delay, ...args);
  globalThis.clearTimeout = handle => typeof handle === 'number' && handle < 0 ? timers.delete(handle) : originalClear(handle);
  const calls = new Map();
  const onSearch = (query, onResult, onProgress, signal) => new Promise(resolve => calls.set(query, { onResult, onProgress, signal, resolve }));
  const root = createRoot(document.getElementById('app'));
  const updateQuery = async query => {
    await React.act(async () => {
      const input = document.querySelector('input');
      const propsKey = Object.keys(input).find(k => k.startsWith('__reactProps$'));
      input[propsKey].onChange({ target: { value: query } });
    });
    await React.act(async () => {
      for (const [key, fn] of [...timers]) { timers.delete(key); void fn(); }
    });
  };
  try {
    await React.act(async () => root.render(React.createElement(EpubSearchModal, {
      theme: { bg: '', text: '', border: '' }, onClose() {}, onSelect() {}, onClear() {}, onSearch,
    })));
    await updateQuery('alpha');
    await updateQuery('beta');
    await React.act(async () => {
      calls.get('beta').onResult({ label: 'new query', progress: 0.2, subitems: [{ cfi: 'beta-cfi', excerpt: 'beta-result' }] });
      calls.get('alpha').onResult({ label: 'old query', progress: 0.1, subitems: [{ cfi: 'alpha-cfi', excerpt: 'alpha-result' }] });
      calls.get('beta').onProgress(0.4);
      calls.get('alpha').onProgress(0.9);
      calls.get('alpha').resolve();
    });
    const text = document.getElementById('app').textContent;
    const observed = { input: document.querySelector('input').value, hasCurrent: text.includes('beta-result'), hasStale: text.includes('alpha-result') };
    assert.equal(calls.get('alpha').signal.aborted, true);
    assert.equal(document.querySelector('.animate-spin') !== null, true);
    assert.equal(document.querySelector('.h-full.bg-accent-500').getAttribute('style').includes('40%'), true);
    assert.equal(observed.input, 'beta'); assert.equal(observed.hasCurrent, true); assert.equal(observed.hasStale, false);
    await React.act(async () => calls.get('beta').resolve());
    assert.equal(document.querySelector('.animate-spin'), null);
    await updateQuery('gamma');
    await updateQuery('');
    assert.equal(calls.get('gamma').signal.aborted, true);
    await React.act(async () => {
      calls.get('gamma').onResult({ label: 'stale', progress: 0.1, subitems: [{ cfi: 'stale', excerpt: 'stale-result' }] });
      calls.get('gamma').resolve();
    });
    assert.equal(document.querySelector('.animate-spin'), null);
    assert.equal(document.getElementById('app').textContent.includes('stale-result'), false);
  } finally {
    await React.act(async () => root.unmount());
    globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
    Object.assign(globalThis, previous);
  }
});

test('Foliate cancels old iterator work and delayed highlight draws while preserving current highlights', async () => {
  const keys = ['window', 'document', 'HTMLElement', 'customElements', 'NodeFilter', 'CustomEvent'];
  const previous = Object.fromEntries(keys.map(k => [k, globalThis[k]]));
  const { window } = parseHTML('<html><body></body></html>');
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
    customElements: window.customElements, CustomEvent: window.CustomEvent,
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, SHOW_CDATA_SECTION: 8, FILTER_REJECT: 2, FILTER_SKIP: 3, FILTER_ACCEPT: 1 } });
  // Supply the standard Range/TreeWalker operations missing from linkedom.
  document.createTreeWalker = root => {
    let visited = false;
    return { nextNode: () => visited ? null : (visited = true, { nodeValue: root.textContent }) };
  };
  document.createRange = () => ({ setStart() {}, setEnd() {} });
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
  try {
    const { View } = await import('../public/foliate-js/view.js');
    const view = new View();
    const highlights = new Set();
    view.renderer = { getContents: () => [{ index: 0, doc: {}, overlayer: {
      add: value => highlights.add(value), remove: value => highlights.delete(value),
    } }] };
    view.resolveNavigation = async () => ({ index: 0, anchor: () => ({}) });
    view.getCFI = () => 'match';
    const documentGate = deferred();
    const documentStarted = deferred();
    let first = true;
    const doc = { body: { textContent: 'alpha beta ', lang: 'en' }, documentElement: { lang: 'en' } };
    view.book = { sections: [{ createDocument: () => {
      if (first) { first = false; documentStarted.resolve(); return documentGate.promise; }
      return Promise.resolve(doc);
    } }] };
    const alpha = view.search({ query: 'alpha', index: 0 });
    const oldNext = alpha.next();
    await documentStarted.promise;
    const beta = view.search({ query: 'beta', index: 0 });
    assert.equal((await beta.next()).value.excerpt.match, 'beta');
    assert.equal(highlights.has('foliate-search:match'), true);
    documentGate.resolve(doc);
    assert.equal((await oldNext).done, true);
    assert.equal((await beta.next()).value, 'done');
    assert.equal(highlights.has('foliate-search:match'), true);

    view.clearSearch();
    await Promise.resolve();
    const navigationGate = deferred(), navigationStarted = deferred();
    let deferNavigation = true;
    view.resolveNavigation = () => {
      if (deferNavigation) { deferNavigation = false; navigationStarted.resolve(); return navigationGate.promise; }
      return Promise.resolve({ index: 0, anchor: () => ({}) });
    };
    const controller = new AbortController();
    const stale = view.search({ query: 'alpha', index: 0, signal: controller.signal });
    const staleNext = stale.next();
    await navigationStarted.promise;
    controller.abort();
    const current = view.search({ query: 'beta', index: 0 });
    assert.equal((await current.next()).value.excerpt.match, 'beta');
    navigationGate.resolve({ index: 0, anchor: () => ({}) });
    assert.equal((await staleNext).done, true);
    assert.equal(highlights.has('foliate-search:match'), true);
    assert.equal((await current.next()).value, 'done');
  } finally { Object.assign(globalThis, previous); }
});

test('search hook forwards aborts and suppresses callbacks after clear or book replacement', async () => {
  const { useFoliateSearch } = require('../src/hooks/foliate/useFoliateSearch.ts');
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = Object.fromEntries(keys.map(k => [k, globalThis[k]]));
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const pending = [];
  const view = { book: { sections: [{}] }, clearSearch() {}, search: ({ signal }) => ({
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise(resolve => pending.push({ signal, resolve })),
    return: async () => ({ done: true }),
  }) };
  const viewRef = { current: view };
  let controls;
  const results = [], progress = [];
  function Harness() { controls = useFoliateSearch({ viewRef }); return null; }
  const root = createRoot(document.getElementById('app'));
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    const controller = new AbortController();
    const first = controls.searchBook('alpha', r => results.push(r), p => progress.push(p), controller.signal);
    const second = controls.searchBook('beta', r => results.push(r), p => progress.push(p));
    assert.equal(pending[0].signal.aborted, true);
    pending[0].resolve({ value: { progress: 0.9 }, done: false });
    await first;
    controls.clearSearch();
    assert.equal(pending[1].signal.aborted, true);
    pending[1].resolve({ value: { subitems: [{ cfi: 'stale' }] }, done: false });
    await second;
    const third = controls.searchBook('gamma', r => results.push(r), p => progress.push(p));
    viewRef.current = { ...view };
    pending[2].resolve({ value: { progress: 0.8 }, done: false });
    await third;
    assert.deepEqual(results, []); assert.deepEqual(progress, []);
    const fourth = controls.searchBook('delta', r => results.push(r), p => progress.push(p), controller.signal);
    controller.abort();
    assert.equal(pending[3].signal.aborted, true);
    pending[3].resolve({ done: true });
    await fourth;
  } finally {
    await React.act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});
