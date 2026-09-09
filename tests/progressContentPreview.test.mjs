import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { ProgressContentPreview } from '../src/components/reader/ProgressContentPreview.tsx';

const delay = () => new Promise(resolve => setTimeout(resolve, 140));

test('preview serializes work, discards stale completion, and releases its image on close', async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, { window, document: window.document });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const requests = [];
  const viewRef = { current: {
    resolveNavigation: ({ fraction }) => ({ index: Math.round(fraction * 10) }),
    book: { getPagePreview: (index, signal) => new Promise(resolve => requests.push({ index, signal, resolve })) },
  } };
  const render = (percent, visible = true) => root.render(React.createElement(ProgressContentPreview, {
    viewRef, percent, visible, theme: { bg: 'bg-black', text: 'text-white', border: 'border-gray-700' },
  }));
  try {
    await act(async () => { render(10); });
    const panel = document.querySelector('aside');
    assert.equal(panel.classList.contains('bg-black'), true);
    assert.equal(panel.classList.contains('text-white'), true);
    assert.equal(panel.classList.contains('border-gray-700'), true);
    assert.ok(!panel.style.background);
    await act(delay);
    assert.equal(requests.length, 1);
    await act(async () => { render(20); });
    await act(delay);
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests.length, 1, 'second render must wait for the first job to settle');
    await act(async () => { requests[0].resolve(new Blob(['old'])); });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].index, 2);
    assert.equal(document.querySelector('img'), null, 'stale completion must never become an image');
    await act(async () => { requests[1].resolve(new Blob(['new'])); });
    const url = document.querySelector('img').getAttribute('src');
    assert.equal(await (await fetch(url)).text(), 'new');
    await act(async () => { render(20, false); });
    assert.equal(requests[1].signal.aborted, true);
    assert.equal(document.querySelector('aside'), null);
    await assert.rejects(fetch(url));
  } finally {
    await act(async () => root.unmount());
  }
});
