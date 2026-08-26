import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { ConfirmDialog } from '../src/components/ConfirmDialog.tsx';
import { ReaderModalFrame } from '../src/components/reader/ReaderModalFrame.tsx';

const theme = {
  bg: 'bg-black',
  text: 'text-white',
  border: 'border-white',
  secondary: 'bg-gray-900',
};

const installDom = () => {
  const { window } = parseHTML('<!doctype html><html><body><button id="before">before</button><div id="root"></div></body></html>');
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(Date.now()), 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  window.getComputedStyle = () => ({ paddingRight: '0px' });
  window.scrollTo = () => undefined;
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    Node: window.Node,
    Event: window.Event,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return window;
};

const dispatchPointer = (window, target, type, pointerId = 3) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  target.dispatchEvent(event);
};

const dispatchEscape = (window) => {
  const event = new window.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'key', { value: 'Escape' });
  window.dispatchEvent(event);
};

test('hideCancel confirm dialogs cannot be dismissed through backdrop or Escape', async () => {
  const window = installDom();
  const root = createRoot(window.document.querySelector('#root'));
  let cancelCount = 0;

  await act(async () => {
    root.render(React.createElement(ConfirmDialog, {
      message: '다시 불러와야 합니다.',
      hideCancel: true,
      theme,
      onConfirm: () => undefined,
      onCancel: () => { cancelCount += 1; },
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  const backdrop = window.document.querySelector('[data-confirm-dialog-backdrop="true"]');
  const dialog = window.document.querySelector('[role="dialog"]');
  assert.ok(backdrop);
  assert.ok(dialog);
  assert.equal(dialog.getAttribute('aria-modal'), 'true');

  await act(async () => {
    dispatchPointer(window, backdrop, 'pointerdown');
    dispatchPointer(window, backdrop, 'pointerup');
    dispatchEscape(window);
    await Promise.resolve();
  });
  assert.equal(cancelCount, 0);

  await act(async () => root.unmount());
});

test('dismissible dialog primitives require a matching backdrop pointer origin', async () => {
  const window = installDom();
  const root = createRoot(window.document.querySelector('#root'));
  let closeCount = 0;

  await act(async () => {
    root.render(React.createElement(
      ReaderModalFrame,
      {
        ariaLabel: '테스트 모달',
        theme,
        onClose: () => { closeCount += 1; },
      },
      React.createElement('button', { type: 'button' }, '작업'),
    ));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  const backdrop = window.document.querySelector('[data-reader-modal-backdrop="true"]');
  const dialog = window.document.querySelector('[role="dialog"]');
  assert.ok(backdrop);
  assert.equal(dialog?.getAttribute('aria-label'), '테스트 모달');

  await act(async () => {
    dispatchPointer(window, backdrop, 'pointerup');
    await Promise.resolve();
  });
  assert.equal(closeCount, 0);

  await act(async () => {
    dispatchPointer(window, backdrop, 'pointerdown');
    dispatchPointer(window, backdrop, 'pointerup');
    await Promise.resolve();
  });
  assert.equal(closeCount, 1);

  await act(async () => root.unmount());
});

test('pins library annotation and statistics modals to the active theme variables', async () => {
  const [pageSource, annotationSource, statisticsSource] = await Promise.all([
    readFile(new URL('../src/app/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/LibraryAnnotationModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/LibraryReadingStatisticsModal.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(pageSource, /<LibraryAnnotationModal[\s\S]*?themeVariables=\{themeCssVariables\}/);
  assert.match(pageSource, /<LibraryReadingStatisticsModal[\s\S]*?themeVariables=\{themeCssVariables\}/);
  assert.match(annotationSource, /data-library-annotation-modal="true"[\s\S]*?style=\{themeVariables\}/);
  assert.match(statisticsSource, /data-reading-statistics-modal="true"[\s\S]*?style=\{\{ \.\.\.themeVariables, \.\.\.accentStyle \}\}/);
});
