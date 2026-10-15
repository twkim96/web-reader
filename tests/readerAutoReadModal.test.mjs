import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { ReaderAutoReadModal } from '../src/components/reader/ReaderAutoReadModal.tsx';
import { tokenizeAutoReadText } from '../src/lib/readerAutoRead.ts';

const mount = async ({ text = '처음 다음 끝.', loadNextChapter = async () => null } = {}) => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  window.requestAnimationFrame = callback => window.setTimeout(callback, 0);
  window.cancelAnimationFrame = window.clearTimeout;
  window.getComputedStyle = () => ({ paddingRight: '0px' });
  window.scrollTo = () => undefined;
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const content = { sectionIndex: 0, words: tokenizeAutoReadText(text), initialIndex: 0, getRange: () => null };
  const closes = [];
  const root = createRoot(window.document.querySelector('#root'));
  await act(async () => {
    root.render(React.createElement(ReaderAutoReadModal, {
      content, chapter: '처음', theme: { bg: '', text: '', border: '' }, fontFamily: 'serif',
      onClose: position => closes.push(position), registerClose: () => undefined, loadNextChapter,
    }));
  });
  const click = async label => {
    await act(async () => window.document.querySelector(`button[aria-label="${label}"]`).dispatchEvent(new window.Event('click', { bubbles: true })));
  };
  const unmount = async () => { await act(async () => root.unmount()); };
  return { window, closes, click, unmount };
};

test('clamped restart and previous-word shortcuts do not return a position to save', async () => {
  const ui = await mount();
  try {
    await ui.click('자동읽기 장 처음으로');
    await act(async () => {
      const event = new ui.window.Event('keydown');
      Object.defineProperty(event, 'key', { value: 'ArrowLeft' });
      ui.window.dispatchEvent(event);
    });
    await ui.click('자동읽기 닫기');
    assert.deepEqual(ui.closes, [undefined]);
  } finally { await ui.unmount(); }
});

test('actual word movement returns its current position', async () => {
  const ui = await mount();
  try {
    await ui.click('다음 단어');
    await ui.click('자동읽기 닫기');
    assert.equal(ui.closes[0].index, 1);
    assert.equal(ui.closes[0].content.words[1].text, '다음');
  } finally { await ui.unmount(); }
});

test('closing during a pending chapter load neither marks movement nor accepts its late result', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const ui = await mount({ text: '마지막.', loadNextChapter: () => pending });
  try {
    await ui.click('다음 단어');
    await ui.click('자동읽기 닫기');
    assert.deepEqual(ui.closes, [undefined]);
    await act(async () => {
      finish({ sectionIndex: 1, words: tokenizeAutoReadText('늦은 결과.'), initialIndex: 0, getRange: () => null });
      await pending;
    });
    assert.equal(ui.window.document.querySelector('[data-reader-auto-read]').getAttribute('data-auto-read-section'), '0');
  } finally { await ui.unmount(); }
});
