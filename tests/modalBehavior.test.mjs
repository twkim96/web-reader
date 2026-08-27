import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { ConfirmDialog } from '../src/components/ConfirmDialog.tsx';
import { ReaderModalFrame } from '../src/components/reader/ReaderModalFrame.tsx';
import { MenuSheetHeader } from '../src/components/MenuSheetHeader.tsx';

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

const dispatchClick = (window, target) => {
  target.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
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
    dispatchClick(window, backdrop);
    dispatchEscape(window);
    await Promise.resolve();
  });
  assert.equal(cancelCount, 0);

  await act(async () => root.unmount());
});

test('menu modal backdrops dismiss on click without leaking into the page', async () => {
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
    dispatchClick(window, backdrop);
    await Promise.resolve();
  });
  assert.equal(closeCount, 1);

  await act(async () => root.unmount());
});

test('menu sheet frames and headers expose one shared Apple-like contract', async () => {
  const window = installDom();
  const root = createRoot(window.document.querySelector('#root'));

  await act(async () => {
    root.render(React.createElement(
      ReaderModalFrame,
      {
        ariaLabel: '메뉴 시트 테스트',
        menuSheet: true,
        theme,
        onClose: () => undefined,
      },
      React.createElement(MenuSheetHeader, {
        kind: 'test',
        title: '테스트 제목',
        borderClass: theme.border,
        secondaryClass: theme.secondary,
        onClose: () => undefined,
      }),
    ));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  const backdrop = window.document.querySelector('[data-menu-sheet-backdrop="true"]');
  const dialog = window.document.querySelector('[data-menu-sheet="true"]');
  const header = window.document.querySelector('[data-menu-sheet-header="true"]');
  assert.ok(backdrop?.classList.contains('app-menu-sheet-backdrop'));
  assert.ok(dialog?.classList.contains('app-menu-sheet'));
  assert.equal(header?.getAttribute('data-modal-header'), 'test');
  assert.equal(header?.querySelector('h2')?.textContent, '테스트 제목');
  const closeButton = header?.querySelector('[data-menu-sheet-close="true"]');
  assert.ok(closeButton?.classList.contains('size-10'));
  assert.equal(closeButton?.querySelector('svg')?.getAttribute('width'), '20');

  await act(async () => root.unmount());
});

test('mobile menu sheets use a floating height-bounded themed surface', async () => {
  const globals = await readFile(new URL('../src/app/globals.css', import.meta.url), 'utf8');
  assert.match(globals, /\.app-menu-sheet-backdrop\s*\{[\s\S]*?background-color:\s*rgba\(0, 0, 0, 0\.20\)\s*!important[\s\S]*?backdrop-filter:\s*none\s*!important/);
  assert.match(globals, /\.app-menu-sheet\s*\{[\s\S]*?background-color:\s*var\(--viewer-theme-bg\)\s*!important/);
  assert.match(globals, /@media \(max-width:\s*639px\)[\s\S]*?\.app-menu-sheet-backdrop\s*\{[\s\S]*?align-items:\s*flex-end\s*!important/);
  assert.match(globals, /\.app-menu-sheet-backdrop\s*\{[\s\S]*?padding:\s*0 1\.25rem max\(0\.75rem, env\(safe-area-inset-bottom\)\)\s*!important/);
  assert.match(globals, /\.app-menu-sheet\s*\{[\s\S]*?max-height:\s*60dvh\s*!important[\s\S]*?border-radius:\s*22px\s*!important/);
  assert.match(globals, /data-viewer-menu-style='standard'[\s\S]*?blur\(28px\)/);
  assert.match(globals, /data-viewer-menu-style='glass'[\s\S]*?blur\(4px\)/);
  assert.match(globals, /data-viewer-menu-style='modern'[\s\S]*?blur\(24px\)/);
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

test('keeps theme headers and action-footers outside the scrolling modal body', async () => {
  const [themeSource, bookInfoSource, statisticsSource, globals] = await Promise.all([
    readFile(new URL('../src/components/ThemeModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/shelf/BookInfoModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/LibraryReadingStatisticsModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/globals.css', import.meta.url), 'utf8'),
  ]);

  assert.match(themeSource, /modalFrameClass = 'flex max-h-\[82dvh\] flex-col overflow-hidden'/);
  assert.match(themeSource, /data-theme-modal-scroll-body="true"[^>]*min-h-0 flex-1 overflow-y-auto/);
  assert.match(themeSource, /data-theme-list-scroll="true"[\s\S]*?overflow-y-auto overscroll-y-auto/);
  assert.doesNotMatch(themeSource, /data-theme-list-scroll="true"[\s\S]*?overflow-y-auto overscroll-contain/);
  assert.match(bookInfoSource, /data-book-info-capture-root="true"[\s\S]*?app-menu-sheet-content/);
  assert.match(bookInfoSource, /data-book-info-actions="true"[\s\S]*?app-menu-sheet-footer/);
  assert.match(statisticsSource, /app-menu-sheet-footer shrink-0/);
  assert.equal((statisticsSource.match(/app-menu-sheet-action/g) ?? []).length, 4);
  assert.match(globals, /\.app-menu-sheet-content,[\s\S]*?\.app-menu-sheet-footer\s*\{[\s\S]*?background-color:\s*transparent\s*!important/);
});
