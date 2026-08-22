import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { ProgressJumpConfirmDialog } from '../src/components/reader/ProgressJumpConfirmDialog.tsx';
import { ReaderToolbar } from '../src/components/reader/ReaderToolbar.tsx';
import { useReaderProgressSlider } from '../src/hooks/reader/useReaderProgressSlider.ts';

const installDom = () => {
  const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(Date.now()), 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  window.getComputedStyle = () => ({ paddingRight: '0px' });
  window.scrollTo = () => undefined;
  Object.defineProperties(window, {
    scrollX: { configurable: true, value: 0 },
    scrollY: { configurable: true, value: 0 },
    innerWidth: { configurable: true, value: 1024 },
  });
  window.matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  Object.defineProperty(window.document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return window;
};

const dispatchPointer = (window, target, type, clientX, buttons) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: 7 },
    pointerType: { value: 'touch' },
    button: { value: type === 'pointerdown' ? 0 : -1 },
    buttons: { value: buttons },
    clientX: { value: clientX },
    clientY: { value: 20 },
  });
  target.dispatchEvent(event);
};

const Harness = ({ menuStyle = 'modern' } = {}) => {
  const slider = useReaderProgressSlider({
    currentCfi: 'epubcfi(/6/2!/4/2)',
    totalProgress: 20,
    stageAutoBookmark: () => [],
    commitBookmarks: (bookmarks) => bookmarks,
    markUserProgressChange: () => undefined,
    goToFraction: async () => true,
    saveCurrentProgress: () => true,
    markReadingActivity: () => undefined,
  });

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(ReaderToolbar, {
      theme: { bg: 'bg-black', text: 'text-white', border: 'border-white' },
      menuStyle,
      bookName: 'Pointer Test.epub',
      showControls: true,
      sliderProgress: slider.sliderProgress,
      isSliderPreviewing: slider.isSliderPreviewing,
      sliderPreviewChapter: undefined,
      bookmarkCount: 0,
      annotationCount: 0,
      onBack: () => undefined,
      onOpenSearch: () => undefined,
      onOpenSettings: () => undefined,
      onOpenTheme: () => undefined,
      onOpenBookmarks: () => undefined,
      onOpenToc: () => undefined,
      onOpenTts: () => undefined,
      onOpenStatistics: () => undefined,
      onOpenBookInfo: () => undefined,
      onProgressSliderStart: slider.beginSliderMove,
      onProgressSliderPreview: slider.previewSliderMove,
      onProgressSliderCommit: slider.commitSliderMove,
    }),
    slider.pendingSliderMove
      ? React.createElement(
        React.Fragment,
        null,
        React.createElement('div', {
          id: 'pending-progress',
          'data-target': String(slider.pendingSliderMove.targetPercent),
        }),
        React.createElement(ProgressJumpConfirmDialog, {
          theme: { bg: 'bg-black', text: 'text-white', border: 'border-white' },
          targetPercent: slider.pendingSliderMove.targetPercent,
          onCancel: slider.cancelSliderMove,
          onConfirm: () => undefined,
        }),
      )
      : null,
  );
};

test('reader progress track commits one tap and drags from any track position without native range hit testing', async () => {
  const window = installDom();
  const rootNode = window.document.querySelector('#root');
  const root = createRoot(rootNode);

  await act(async () => {
    root.render(React.createElement(Harness));
    await Promise.resolve();
  });

  const track = window.document.querySelector('[data-reader-progress-pointer-track="true"]');
  const input = window.document.querySelector('input[aria-label="진행률"]');
  assert.ok(track);
  assert.ok(input);
  assert.match(input.className, /pointer-events-none/);
  assert.match(track.className, /touch-none/);
  track.getBoundingClientRect = () => ({
    left: 100,
    right: 500,
    top: 0,
    bottom: 40,
    width: 400,
    height: 40,
    x: 100,
    y: 0,
    toJSON: () => ({}),
  });

  await act(async () => {
    dispatchPointer(window, track, 'pointerdown', 388, 1);
    dispatchPointer(window, track, 'pointerup', 388, 0);
    await Promise.resolve();
  });
  assert.equal(window.document.querySelector('#pending-progress')?.getAttribute('data-target'), '72');

  const backdrop = window.document.querySelector('[data-progress-jump-confirm-backdrop="true"]');
  assert.ok(backdrop);
  await act(async () => {
    backdrop.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  assert.equal(
    window.document.querySelector('#pending-progress')?.getAttribute('data-target'),
    '72',
    'a click without a backdrop pointer-down must not dismiss the Android progress modal',
  );

  await act(async () => {
    dispatchPointer(window, backdrop, 'pointerdown', 10, 1);
    dispatchPointer(window, backdrop, 'pointerup', 10, 0);
    await Promise.resolve();
  });
  assert.equal(window.document.querySelector('#pending-progress'), null);

  await act(async () => {
    root.unmount();
  });

  const secondRoot = createRoot(rootNode);
  await act(async () => {
    secondRoot.render(React.createElement(Harness));
    await Promise.resolve();
  });
  const secondTrack = window.document.querySelector('[data-reader-progress-pointer-track="true"]');
  secondTrack.getBoundingClientRect = track.getBoundingClientRect;

  await act(async () => {
    dispatchPointer(window, secondTrack, 'pointerdown', 172, 1);
    dispatchPointer(window, secondTrack, 'pointermove', 444, 1);
    dispatchPointer(window, secondTrack, 'pointerup', 444, 0);
    await Promise.resolve();
  });
  assert.equal(window.document.querySelector('#pending-progress')?.getAttribute('data-target'), '86');

  await act(async () => {
    secondRoot.unmount();
  });
});

test('reader menu styles reach the top chrome and bottom toolbar with distinct surfaces', async () => {
  const window = installDom();
  const rootNode = window.document.querySelector('#root');
  const root = createRoot(rootNode);

  await act(async () => {
    root.render(React.createElement(Harness, { menuStyle: 'glass' }));
    await Promise.resolve();
  });

  const topMenu = window.document.querySelector('nav[data-reader-menu-style="glass"]');
  const bottomMenu = window.document.querySelector('[data-reader-toolbar-menu="true"][data-reader-menu-style="glass"]');
  const closeButton = window.document.querySelector('button[aria-label="Close reader"]');
  const titleRightLimit = window.document.querySelector('[data-reader-title-right-limit="true"]');
  const titleSurface = [...window.document.querySelectorAll('h2')]
    .find((node) => node.textContent?.includes('Pointer Test'))?.parentElement;
  const tocSurface = window.document.querySelector('button[aria-label="목차"]')?.parentElement;
  assert.ok(topMenu);
  assert.ok(bottomMenu);
  assert.ok(closeButton);
  assert.ok(titleRightLimit);
  assert.ok(titleSurface);
  assert.ok(tocSurface);
  assert.equal(closeButton.getAttribute('data-reader-close-button'), 'true');
  assert.equal(titleSurface.getAttribute('data-reader-title-surface'), 'true');
  assert.match(closeButton.className, /sm:top-\[calc\(env\(safe-area-inset-top\)\+15px\)\]/);
  assert.equal(closeButton.style.right, bottomMenu.style.right);
  assert.match(titleRightLimit.className, /right-\[calc\(env\(safe-area-inset-right\)\+12px\)\]/);
  for (const surface of [closeButton, titleSurface, tocSurface]) {
    assert.match(surface.className, /viewer-cime-glass/);
    assert.doesNotMatch(surface.getAttribute('style') || '', /--viewer-reader-glass-surface/);
  }

  await act(async () => {
    root.render(React.createElement(Harness, { menuStyle: 'standard' }));
    await Promise.resolve();
  });

  const standardTopMenu = window.document.querySelector('nav[data-reader-menu-style="standard"]');
  const standardBottomMenu = window.document.querySelector('[data-reader-toolbar-menu="true"][data-reader-menu-style="standard"]');
  const standardCloseButton = window.document.querySelector('button[aria-label="Close reader"]');
  assert.ok(standardTopMenu);
  assert.ok(standardBottomMenu);
  assert.match(standardCloseButton?.getAttribute('style') || '', /--viewer-reader-glass-surface/);
  assert.match(standardCloseButton?.getAttribute('style') || '', /blur\(28px\)/);
  assert.doesNotMatch(standardCloseButton?.className || '', /viewer-cime-glass/);

  await act(async () => {
    root.render(React.createElement(Harness, { menuStyle: 'modern' }));
    await Promise.resolve();
  });

  const modernTopMenu = window.document.querySelector('nav[data-reader-menu-style="modern"]');
  const modernBottomMenu = window.document.querySelector('[data-reader-toolbar-menu="true"][data-reader-menu-style="modern"]');
  const modernCloseButton = window.document.querySelector('button[aria-label="Close reader"]');
  assert.ok(modernTopMenu);
  assert.ok(modernBottomMenu);
  assert.match(modernCloseButton?.getAttribute('style') || '', /--viewer-reader-surface/);
  assert.match(modernCloseButton?.getAttribute('style') || '', /blur\(18px\)/);
  assert.doesNotMatch(modernCloseButton?.getAttribute('style') || '', /--viewer-reader-glass-surface/);

  await act(async () => {
    root.unmount();
  });
});
