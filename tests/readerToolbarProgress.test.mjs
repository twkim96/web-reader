import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { ProgressJumpConfirmDialog } from '../src/components/reader/ProgressJumpConfirmDialog.tsx';
import { ReaderToolbar } from '../src/components/reader/ReaderToolbar.tsx';
import { useReaderProgressSlider } from '../src/hooks/reader/useReaderProgressSlider.ts';

test('keeps the reader footer chapter and percentage visually light', async () => {
  const source = await readFile(
    new URL('../src/components/reader/ReaderStatusBar.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /data-reader-status-main="true"[\s\S]*?font-normal/);
  assert.doesNotMatch(source, /data-reader-status-main="true"[\s\S]*?font-black/);
  assert.match(
    source,
    /data-reader-status-title="true"[\s\S]*?font-sans[\s\S]*?font-normal[\s\S]*?not-italic/,
  );
});

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

const dispatchPointer = (window, target, type, clientX, buttons, clientY = 20) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: 7 },
    pointerType: { value: 'touch' },
    button: { value: type === 'pointerdown' ? 0 : -1 },
    buttons: { value: buttons },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  target.dispatchEvent(event);
};

const Harness = ({ menuStyle = 'modern' } = {}) => {
  const slider = useReaderProgressSlider({
    currentCfi: 'epubcfi(/6/2!/4/2)',
    totalProgress: 20,
    getCurrentPercent: () => 20,
    getBookmarks: () => [],
    stageAutoBookmark: () => [],
    commitBookmarks: (bookmarks) => bookmarks,
    beginProvisionalNavigation: () => undefined,
    cancelProvisionalNavigation: () => undefined,
    confirmProvisionalNavigation: async () => true,
    goTo: async () => true,
    goToFraction: async () => true,
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
      onProgressSliderCancel: slider.cancelSliderPreview,
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
  assert.match(track.parentElement?.className || '', /focus-within:ring-2/);
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
  assert.ok(window.document.querySelector('#pending-progress'), 'outside pointer clicks must not cancel provisional navigation');
  await act(async () => {
    [...window.document.querySelectorAll('button')].find(button => button.textContent === '취소').click();
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
    dispatchPointer(window, secondTrack, 'pointermove', 300, 1);
    dispatchPointer(window, secondTrack, 'pointercancel', 300, 0);
    await Promise.resolve();
  });
  assert.equal(
    window.document.querySelector('#pending-progress'),
    null,
    'a cancelled system gesture must discard the preview without opening confirmation',
  );

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
  const globals = await readFile(new URL('../src/app/globals.css', import.meta.url), 'utf8');
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
  assert.equal(titleRightLimit, closeButton);
  assert.equal(titleSurface.getAttribute('data-reader-title-surface'), 'true');
  assert.match(closeButton.className, /sm:top-\[calc\(env\(safe-area-inset-top\)\+15px\)\]/);
  assert.equal(closeButton.style.right, bottomMenu.style.right);
  assert.equal(titleRightLimit.style.right, bottomMenu.style.right);
  for (const surface of [closeButton, titleSurface, tocSurface]) {
    assert.match(surface.className, /app-reader-menu-surface/);
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
  assert.match(standardCloseButton?.className || '', /app-reader-menu-surface/);
  assert.doesNotMatch(standardCloseButton?.getAttribute('style') || '', /--viewer-reader-glass-surface|blur\(28px\)/);
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
  assert.match(modernCloseButton?.className || '', /app-reader-menu-surface/);
  assert.doesNotMatch(modernCloseButton?.getAttribute('style') || '', /--viewer-reader-surface|blur\(18px\)|--viewer-reader-glass-surface/);
  assert.match(globals, /data-viewer-menu-style='standard'\]\s*\{[^}]*--app-menu-reader-filter:\s*var\(--app-menu-filter\)/);
  assert.match(globals, /data-viewer-menu-style='glass'\]\s*\{[^}]*--app-menu-reader-surface:\s*var\(--app-menu-dock-surface\)/);
  assert.match(globals, /data-viewer-menu-style='modern'\]\s*\{[^}]*--app-menu-reader-filter:\s*blur\(18px\) saturate\(1\.18\)/);
  assert.match(globals, /\.app-reader-menu-surface\s*\{[\s\S]*?background-color:\s*var\(--app-menu-reader-surface[\s\S]*?backdrop-filter:\s*var\(--app-menu-reader-filter/);

  await act(async () => {
    root.unmount();
  });
});

test('provisional slider moves navigate immediately, preserve first origin across moves, and only confirm saves', async () => {
  installDom();
  const root = createRoot(document.querySelector('#root'));
  const navigations = [], saves = [], rollbacks = [], bookmarks = [];
  let slider, position = 30, active = false;
  function TransactionHarness() {
    const [, rerender] = React.useState(0);
    const state = useReaderProgressSlider({
      currentCfi: `cfi-${position}`, totalProgress: position,
      getCurrentPercent: () => position, getBookmarks: () => [],
      stageAutoBookmark: (cfi, percent) => [{ id: "origin", type: "auto", cfi, progressPercent: percent }],
      commitBookmarks: value => { bookmarks.push(value); return value; },
      beginProvisionalNavigation: () => { active = true; },
      cancelProvisionalNavigation: () => { active = false; },
      confirmProvisionalNavigation: async () => { saves.push(position); active = false; return true; },
      goTo: async cfi => { rollbacks.push(cfi); position = Number(cfi.slice(4)); rerender(n => n + 1); return true; },
      goToFraction: async fraction => { position = fraction * 100; navigations.push(position); rerender(n => n + 1); return true; },
      markReadingActivity: () => {},
    });
    React.useLayoutEffect(() => { slider = state; });
    return null;
  }
  try {
    await act(async () => root.render(React.createElement(TransactionHarness)));
    for (const target of [40, 50, 60]) {
      await act(async () => { slider.previewSliderMove(target); slider.commitSliderMove(); });
      assert.equal(position, target);
      assert.equal(slider.pendingSliderMove.startPercent, 30);
      assert.equal(active, true);
      assert.deepEqual(saves, []);
    }
    assert.deepEqual(navigations, [40, 50, 60]);
    await act(async () => slider.cancelSliderMove());
    assert.deepEqual(rollbacks, ['cfi-30']);
    assert.equal(position, 30);
    assert.deepEqual(saves, []);
    assert.deepEqual(bookmarks, []);
    await act(async () => { slider.previewSliderMove(75); slider.commitSliderMove(); });
    await act(async () => slider.confirmSliderMove());
    assert.deepEqual(saves, [75]);
    assert.equal(bookmarks[0][0].cfi, 'cfi-30');
    assert.equal(slider.pendingSliderMove, null);
    assert.equal(active, false);
  } finally { await act(async () => root.unmount()); }
});

test('cancel waits for an outstanding provisional jump before restoring its original CFI', async () => {
  installDom();
  const root = createRoot(document.querySelector('#root'));
  let slider, finishNavigation;
  const events = [];
  function Harness() {
    const state = useReaderProgressSlider({
      currentCfi: 'original', totalProgress: 30, getCurrentPercent: () => 60, getBookmarks: () => [], stageAutoBookmark: () => [], commitBookmarks: x => x,
      beginProvisionalNavigation: () => events.push('gate'),
      cancelProvisionalNavigation: () => events.push('release'),
      confirmProvisionalNavigation: async () => { events.push('save'); return true; },
      goTo: async cfi => { events.push(cfi); return true; },
      goToFraction: () => new Promise(resolve => { finishNavigation = () => { events.push('jump'); resolve(true); }; }),
      markReadingActivity: () => {},
    });
    React.useLayoutEffect(() => { slider = state; });
    return null;
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => { slider.previewSliderMove(60); slider.commitSliderMove(); });
    let cancellation;
    await act(async () => { cancellation = slider.cancelSliderMove(); });
    assert.deepEqual(events, ['gate']);
    await act(async () => { finishNavigation(); await cancellation; });
    assert.deepEqual(events, ['gate', 'jump', 'original', 'release']);
  } finally { await act(async () => root.unmount()); }
});

test('menu jumps share provisional rollback and confirmation preserves live manual bookmarks', async () => {
  installDom();
  const root = createRoot(document.querySelector('#root'));
  let slider, position = 30, liveBookmarks = [{ id: 'deleted', type: 'manual' }];
  const commits = [], events = [];
  let finishSave;
  function Harness() {
    const state = useReaderProgressSlider({
      currentCfi: `cfi-${position}`, totalProgress: position,
      getCurrentPercent: () => position, getBookmarks: () => liveBookmarks,
      stageAutoBookmark: () => [...liveBookmarks, { id: 'origin', type: 'auto', cfi: `cfi-${position}` }],
      commitBookmarks: value => { commits.push(value); return value; },
      beginProvisionalNavigation: () => events.push('gate'), cancelProvisionalNavigation: () => events.push('release'),
      confirmProvisionalNavigation: () => new Promise(resolve => { finishSave = () => resolve(true); }),
      goTo: async () => { position = 30; return true; },
      goToFraction: async fraction => { position = fraction * 100; return true; }, markReadingActivity: () => {},
    });
    React.useLayoutEffect(() => { slider = state; });
    return null;
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => { slider.beginSliderMove(); slider.commitSliderMove(); });
    assert.deepEqual(events, ['gate', 'release'], 'focus/key events without a target release the gate');
    await act(async () => { slider.previewSliderMove(40); slider.commitSliderMove(); });
    await act(async () => slider.navigateWithinPreview(async () => { position = 55; return true; }));
    assert.equal(slider.pendingSliderMove.startPercent, 30);
    assert.equal(slider.pendingSliderMove.targetPercent, 55);
    liveBookmarks = [{ id: 'added', type: 'manual' }];
    await act(async () => { slider.previewSliderMove(60); slider.commitSliderMove(); });
    let confirmation;
    await act(async () => { confirmation = slider.confirmSliderMove(); });
    liveBookmarks = [{ id: 'added-during-save', type: 'manual' }];
    await act(async () => { finishSave(); await confirmation; });
    assert.deepEqual(commits[0].map(item => item.id), ['added-during-save', 'origin']);
    assert.equal(commits[0][1].cfi, 'cfi-30');
  } finally { await act(async () => root.unmount()); }
});


test('lifting the progress gesture enables fifth-speed scrubbing without jumps or mode chatter', async () => {
  const window = installDom();
  const root = createRoot(document.querySelector('#root'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const track = document.querySelector('[data-reader-progress-pointer-track]');
    track.getBoundingClientRect = () => ({ left: 0, top: 200, width: 400, height: 40 });
    const move = async (type, x, y, buttons = 1) => {
      await act(async () => dispatchPointer(window, track, type, x, buttons, y));
      return Number(document.querySelector('input[aria-label="진행률"]').value);
    };
    assert.equal(await move('pointerdown', 120, 220), 30);
    assert.equal(await move('pointermove', 160, 220), 40, 'ordinary scrubbing keeps absolute positioning');
    assert.equal(await move('pointermove', 160, 140), 40, 'lifting alone does not move the target');
    assert.equal(await move('pointermove', 240, 140), 44, '80px gives 4%, not 20%');
    assert.equal(document.querySelector('[data-reader-progress-precision]').getAttribute('data-reader-progress-precision'), 'fine');
    assert.equal(await move('pointermove', 240, 165), 44, 'vertical jitter preserves selection and fine mode');
    assert.equal(document.querySelector('[data-reader-progress-precision]').getAttribute('data-reader-progress-precision'), 'fine');
    assert.equal(await move('pointermove', 240, 220), 44, 'returning to the bar must not snap to the finger');
    assert.equal(await move('pointermove', 280, 220), 54, 'normal speed resumes from current selection');
    await move('pointerup', 280, 220, 0);
    assert.equal(document.querySelector('#pending-progress').getAttribute('data-target'), '54');
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '취소').click());
    assert.equal(await move('pointerdown', 80, 220), 20, 'a new gesture resets to absolute positioning');
    await move('pointercancel', 80, 220, 0);
    assert.equal(document.querySelector('[data-reader-progress-precision]'), null);
  } finally { await act(async () => root.unmount()); }
});
