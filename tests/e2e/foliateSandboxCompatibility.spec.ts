import { expect, test } from '@playwright/test';

type RendererProbe = {
  contentIndexes: number[];
  events: Record<string, number>;
  inlineHandlerRan: boolean;
  firstLoadMatched: boolean;
  loadedIndexes: number[];
  relocateReasons?: Array<string | null>;
  sandbox: string | null;
  scriptRan: boolean;
  selectionTouchMovePrevented?: boolean;
  tapModeTouchMoved?: boolean;
};

const preparePage = async (page: import('@playwright/test').Page) => {
  await page.goto('/?foliate-sandbox-gate=1');
  await page.evaluate(() => {
    document.body.replaceChildren();
    Object.assign(window, {
      __publicationInlineHandlerRan: false,
      __publicationScriptRan: false,
    });
  });
};

test('paginator blocks publication scripts and keeps parent-controlled events', async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate<RendererProbe>(async () => {
    const paginatorModule = '/foliate-js/paginator.js';
    const { Paginator } = await import(paginatorModule);
    const urls = [0, 1].map((index) => URL.createObjectURL(new Blob([
      `<!doctype html>
       <html><head><title>Page ${index}</title></head>
       <body onload="parent.__publicationInlineHandlerRan = true">
         <button id="probe">Page ${index}</button>
         <p id="selection">Selectable text ${index}</p>
         <p id="late-selection">${'Late selectable text '.repeat(500)}</p>
         <script>parent.__publicationScriptRan = true</script>
       </body></html>`,
    ], { type: 'text/html' })));
    const renderer = new Paginator();
    renderer.style.cssText = 'display:block;width:720px;height:760px';
    renderer.setAttribute('swipe-navigation', 'false');
    document.body.append(renderer);
    renderer.open({
      dir: 'ltr',
      sections: urls.map((url) => ({
        linear: 'yes',
        load: async () => url,
        unload: () => undefined,
      })),
    });

    const events = { click: 0, keydown: 0, selectionchange: 0, touchstart: 0 };
    const loadedIndexes: number[] = [];
    const loadedDocuments: Document[] = [];
    const relocateReasons: Array<string | null> = [];
    renderer.addEventListener('relocate', ((event: CustomEvent) => {
      relocateReasons.push(event.detail?.reason ?? null);
    }) as EventListener);
    renderer.addEventListener('load', ((event: CustomEvent) => {
      const { doc, index } = event.detail;
      loadedIndexes.push(index);
      loadedDocuments.push(doc);
      for (const name of Object.keys(events)) {
        doc.addEventListener(name, () => {
          events[name as keyof typeof events] += 1;
        });
      }
    }) as EventListener);

    await renderer.goTo({ index: 0 });
    const first = renderer.getContents()[0];
    const firstDoc = first.doc as Document;
    const firstLoadMatched = loadedDocuments.at(-1) === firstDoc;
    const frameWindow = firstDoc.defaultView!;
    firstDoc.querySelector<HTMLButtonElement>('#probe')?.dispatchEvent(
      new frameWindow.MouseEvent('click', { bubbles: true }),
    );
    firstDoc.dispatchEvent(new frameWindow.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
    firstDoc.dispatchEvent(new frameWindow.Event('touchstart', { bubbles: true }));
    const selectionNode = firstDoc.querySelector('#selection')?.firstChild;
    if (selectionNode) {
      const range = firstDoc.createRange();
      range.selectNodeContents(selectionNode);
      firstDoc.getSelection()?.removeAllRanges();
      firstDoc.getSelection()?.addRange(range);
      firstDoc.dispatchEvent(new frameWindow.Event('selectionchange'));

      firstDoc.dispatchEvent(new frameWindow.KeyboardEvent('keydown', { bubbles: true, key: 'Shift' }));
      firstDoc.dispatchEvent(new frameWindow.Event('selectionchange'));
      firstDoc.dispatchEvent(new frameWindow.KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const lateSelectionNode = firstDoc.querySelector('#late-selection')?.firstChild;
    if (lateSelectionNode) {
      lateSelectionNode.parentElement?.dispatchEvent(new frameWindow.PointerEvent('pointerdown', { bubbles: true }));
      const range = firstDoc.createRange();
      range.selectNodeContents(lateSelectionNode);
      firstDoc.getSelection()?.removeAllRanges();
      firstDoc.getSelection()?.addRange(range);
      firstDoc.dispatchEvent(new frameWindow.Event('selectionchange'));
      await new Promise((resolve) => setTimeout(resolve, 1300));
      lateSelectionNode.parentElement?.dispatchEvent(new frameWindow.PointerEvent('pointerup', { bubbles: true }));
    }
    const selectionElement = firstDoc.querySelector('#selection');
    let selectionTouchMovePrevented = false;
    let tapModeTouchMoved = false;
    if (selectionElement) {
      firstDoc.getSelection()?.removeAllRanges();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const startBeforeTouch = renderer.start;
      const touch = { screenX: 100, screenY: 120 };
      const movedTouch = { screenX: 40, screenY: 120 };
      const touchStart = new frameWindow.Event('touchstart', { bubbles: true, cancelable: true });
      Object.defineProperty(touchStart, 'changedTouches', { value: [touch] });
      Object.defineProperty(touchStart, 'touches', { value: [touch] });
      selectionElement.dispatchEvent(touchStart);
      const touchMove = new frameWindow.Event('touchmove', { bubbles: true, cancelable: true });
      Object.defineProperty(touchMove, 'changedTouches', { value: [movedTouch] });
      Object.defineProperty(touchMove, 'touches', { value: [movedTouch] });
      selectionElement.dispatchEvent(touchMove);
      selectionTouchMovePrevented = touchMove.defaultPrevented;
      const touchEnd = new frameWindow.Event('touchend', { bubbles: true, cancelable: true });
      Object.defineProperty(touchEnd, 'changedTouches', { value: [movedTouch] });
      Object.defineProperty(touchEnd, 'touches', { value: [] });
      selectionElement.dispatchEvent(touchEnd);
      tapModeTouchMoved = renderer.start !== startBeforeTouch;
    }
    await renderer.nextSection();
    const contents = renderer.getContents();
    const sandbox = contents[0]?.doc.defaultView?.frameElement?.getAttribute('sandbox') ?? null;
    const probe = {
      contentIndexes: contents.map(({ index }: { index: number }) => index),
      events,
      firstLoadMatched,
      inlineHandlerRan: Boolean((window as typeof window & { __publicationInlineHandlerRan?: boolean }).__publicationInlineHandlerRan),
      loadedIndexes,
      relocateReasons,
      sandbox,
      selectionTouchMovePrevented,
      tapModeTouchMoved,
      scriptRan: Boolean((window as typeof window & { __publicationScriptRan?: boolean }).__publicationScriptRan),
    };
    renderer.destroy();
    renderer.remove();
    urls.forEach((url) => URL.revokeObjectURL(url));
    return probe;
  });

  expect(result.sandbox).toBe('allow-same-origin allow-scripts');
  expect(result.scriptRan).toBe(false);
  expect(result.inlineHandlerRan).toBe(false);
  expect(result.loadedIndexes).toEqual([0, 1]);
  expect(result.contentIndexes).toEqual([1]);
  expect(result.firstLoadMatched).toBe(true);
  expect(result.events.click).toBe(1);
  expect(result.events.keydown).toBe(2);
  expect(result.events.touchstart).toBe(2);
  expect(result.events.selectionchange).toBeGreaterThanOrEqual(1);
  expect(result.selectionTouchMovePrevented).toBe(false);
  expect(result.tapModeTouchMoved).toBe(false);
  expect(result.relocateReasons).toContain('selection-anchor');
  expect(result.relocateReasons).toContain('selection-page');
});

test('paginator rejects programmatic navigation while a page turn is locked and becomes ready after it settles', async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate(async () => {
    const paginatorModule = '/foliate-js/paginator.js';
    const { Paginator } = await import(paginatorModule);
    const url = URL.createObjectURL(new Blob([`<!doctype html><html><body>
      ${Array.from({ length: 180 }, (_, index) => `<p>Locked navigation paragraph ${index} ${'content '.repeat(8)}</p>`).join('')}
    </body></html>`], { type: 'text/html' }));
    const renderer = new Paginator();
    renderer.style.cssText = 'display:block;width:720px;height:760px';
    renderer.setAttribute('flow', 'paginated');
    renderer.setAttribute('margin', '0px');
    renderer.setAttribute('gap', '5%');
    renderer.setAttribute('max-inline-size', '1000px');
    renderer.setAttribute('max-column-count', '1');
    document.body.append(renderer);
    renderer.open({
      dir: 'ltr',
      sections: [{
        linear: 'yes',
        load: async () => url,
        unload: () => undefined,
      }],
    });
    await renderer.goTo({ index: 0, anchor: 0 });
    const turn = renderer.next();
    const blocked = await renderer.goTo({ index: 0, anchor: 0.8 });
    const stableDuringLock = renderer.goTo({ index: 0, anchor: 0.8, stable: true });
    await turn;
    const accepted = await stableDuringLock;
    const ready = await renderer.waitForNavigationReady();
    const probe = {
      blocked,
      ready,
      accepted: Boolean(accepted),
      page: renderer.page,
      pages: renderer.pages,
    };
    renderer.destroy();
    renderer.remove();
    URL.revokeObjectURL(url);
    return probe;
  });

  expect(result.blocked).toBe(false);
  expect(result.ready).toBe(true);
  expect(result.accepted).toBe(true);
  expect(result.page).toBeGreaterThan(1);
  expect(result.page).toBeLessThan(result.pages - 1);
});

test('paginator tolerates pre-view size and snap probes during initial EPUB open', async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate(async () => {
    const paginatorModule = '/foliate-js/paginator.js';
    const { Paginator } = await import(paginatorModule);
    const url = URL.createObjectURL(new Blob([
      '<!doctype html><html><body><p>Deferred first section.</p></body></html>',
    ], { type: 'text/html' }));
    const renderer = new Paginator();
    renderer.style.cssText = 'display:block;width:720px;height:760px';
    renderer.setAttribute('flow', 'paginated');
    document.body.append(renderer);
    renderer.open({
      dir: 'ltr',
      sections: [{
        linear: 'yes',
        load: async () => url,
        unload: () => undefined,
      }],
    });
    const probe = {
      viewSize: renderer.viewSize,
      pages: renderer.pages,
      snap: renderer.snap(0, 0),
    };
    renderer.destroy();
    renderer.remove();
    URL.revokeObjectURL(url);
    return probe;
  });

  expect(result.viewSize).toBe(0);
  expect(result.pages).toBe(0);
  expect(result.snap).toBe(false);
});

test('paginator releases the page-turn lock after a section load failure', async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate(async () => {
    const paginatorModule = '/foliate-js/paginator.js';
    const { Paginator } = await import(paginatorModule);
    const urls = [
      '<!doctype html><html><body><p>Short first section.</p></body></html>',
      '<!doctype html><html><body><p>Recovered second section.</p></body></html>',
    ].map((html) => URL.createObjectURL(new Blob([html], { type: 'text/html' })));
    let failNextSection = true;
    const renderer = new Paginator();
    renderer.style.cssText = 'display:block;width:720px;height:760px';
    renderer.setAttribute('flow', 'paginated');
    renderer.setAttribute('margin', '0px');
    renderer.setAttribute('max-column-count', '1');
    document.body.append(renderer);
    renderer.open({
      dir: 'ltr',
      sections: [
        { linear: 'yes', load: async () => urls[0], unload: () => undefined },
        {
          linear: 'yes',
          load: async () => {
            if (failNextSection) {
              failNextSection = false;
              throw new Error('injected section failure');
            }
            return urls[1];
          },
          unload: () => undefined,
        },
      ],
    });
    await renderer.goTo({ index: 0, anchor: 1 });
    let firstRejected = false;
    try {
      await renderer.next();
    } catch {
      firstRejected = true;
    }
    // If #locked leaked from the rejected page turn, a direct goTo would
    // return false before the section loader gets its recovery attempt.
    const recovered = await renderer.goTo({ index: 1, anchor: 0 });
    const readyAfterRecovery = await renderer.waitForNavigationReady(3000);
    const index = renderer.getContents()[0]?.index ?? -1;
    renderer.destroy();
    renderer.remove();
    urls.forEach((url) => URL.revokeObjectURL(url));
    return { firstRejected, readyAfterRecovery, recovered: Boolean(recovered), index };
  });

  expect(result.firstRejected).toBe(true);
  expect(result.recovered).toBe(true);
  expect(result.readyAfterRecovery).toBe(true);
  expect(result.index).toBe(1);
});

test('stable cross-section navigation settles target pagination before resolving', async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate(async () => {
    const paginatorModule = '/foliate-js/paginator.js';
    const { Paginator } = await import(paginatorModule);
    const firstUrl = URL.createObjectURL(new Blob([
      '<!doctype html><html><body><p>First section.</p></body></html>',
    ], { type: 'text/html' }));
    const secondUrl = URL.createObjectURL(new Blob([`<!doctype html><html><body>
      ${Array.from({ length: 80 }, (_, index) => `<p>Target paragraph ${index} ${'content '.repeat(8)}</p>`).join('')}
      <img id="target-image" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='900'%3E%3Crect width='1200' height='900' fill='black'/%3E%3C/svg%3E" alt="target" />
      ${Array.from({ length: 80 }, (_, index) => `<p>After image ${index} ${'content '.repeat(8)}</p>`).join('')}
    </body></html>`], { type: 'text/html' }));
    const renderer = new Paginator();
    renderer.style.cssText = 'display:block;width:720px;height:760px';
    renderer.setAttribute('flow', 'paginated');
    renderer.setAttribute('margin', '0px');
    renderer.setAttribute('gap', '5%');
    renderer.setAttribute('max-inline-size', '1000px');
    renderer.setAttribute('max-column-count', '1');
    document.body.append(renderer);
    renderer.open({
      dir: 'ltr',
      sections: [firstUrl, secondUrl].map((url) => ({
        linear: 'yes',
        load: async () => url,
        unload: () => undefined,
      })),
    });
    await renderer.goTo({ index: 0 });
    const navigation = renderer.goTo({ index: 1, anchor: 0.65, stable: true });
    const settledEarly = await Promise.race([
      navigation.then(() => true),
      // Stable navigation runs the target document through full pagination
      // settling (fonts/images plus three layout frames) before it can resolve.
      new Promise((resolve) => setTimeout(() => resolve(false), 10)),
    ]);
    const committed = await navigation;
    const atCommit = {
      index: renderer.getContents()[0]?.index ?? -1,
      page: renderer.page,
      pages: renderer.pages,
    };
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterDelay = {
      index: renderer.getContents()[0]?.index ?? -1,
      page: renderer.page,
      pages: renderer.pages,
    };
    renderer.destroy();
    renderer.remove();
    URL.revokeObjectURL(firstUrl);
    URL.revokeObjectURL(secondUrl);
    return { settledEarly, committed: Boolean(committed), atCommit, afterDelay };
  });

  expect(result.settledEarly).toBe(false);
  expect(result.committed).toBe(true);
  expect(result.atCommit.index).toBe(1);
  expect(result.afterDelay).toEqual(result.atCommit);
});

test('paginator keeps TTS relocation metadata and lets the latest user navigation win', async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate(async () => {
    const paginatorModule = '/foliate-js/paginator.js';
    const { Paginator } = await import(paginatorModule);
    const urls = [0, 1, 2].map((index) => URL.createObjectURL(new Blob([
      `<!doctype html><html><body>${Array.from({ length: 80 }, (_, line) => (
        `<p>Section ${index} line ${line}.</p>`
      )).join('')}</body></html>`,
    ], { type: 'text/html' })));
    let releaseSlowSection: () => void = () => undefined;
    const slowSectionReady = new Promise<void>((resolve) => {
      releaseSlowSection = resolve;
    });
    const renderer = new Paginator();
    renderer.style.cssText = 'display:block;width:720px;height:760px';
    document.body.append(renderer);
    renderer.open({
      dir: 'ltr',
      sections: urls.map((url, index) => ({
        linear: 'yes',
        load: async () => {
          if (index === 1) await slowSectionReady;
          return url;
        },
        unload: () => undefined,
      })),
    });
    const events: Array<{
      index: number;
      reason: string | null;
      navigationSource: string | null;
      navigationId: string | null;
    }> = [];
    renderer.addEventListener('relocate', ((event: CustomEvent) => {
      events.push({
        index: event.detail?.index ?? -1,
        reason: event.detail?.reason ?? null,
        navigationSource: event.detail?.navigationSource ?? null,
        navigationId: event.detail?.navigationId ?? null,
      });
    }) as EventListener);
    await renderer.goTo({ index: 0 });
    const staleTts = renderer.goTo({
      index: 1,
      reason: 'tts-navigation',
      navigationSource: 'tts',
      navigationId: 'tts:stale',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await renderer.goTo({ index: 2, reason: 'page' });
    releaseSlowSection();
    await staleTts;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const latestIndex = renderer.getContents()[0]?.index ?? -1;
    const staleCommitted = events.some(({ index, navigationId }) => (
      index === 1 || navigationId === 'tts:stale'
    ));

    const ttsStart = events.length;
    await renderer.goTo({
      index: 0,
      reason: 'tts-navigation',
      navigationSource: 'tts',
      navigationId: 'tts:derived',
    });
    renderer.render();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const derivedEvents = events.slice(ttsStart);
    renderer.cancelNavigation('tts');
    renderer.destroy();
    renderer.remove();
    urls.forEach((url) => URL.revokeObjectURL(url));
    return { derivedEvents, latestIndex, staleCommitted };
  });

  expect(result.latestIndex).toBe(2);
  expect(result.staleCommitted).toBe(false);
  expect(result.derivedEvents.length).toBeGreaterThan(0);
  expect(result.derivedEvents.every(({ navigationSource, navigationId }) => (
    navigationSource === 'tts' && navigationId === 'tts:derived'
  ))).toBe(true);
  expect(result.derivedEvents.some(({ reason }) => reason === 'anchor')).toBe(true);
});

test('paginator applies reader style before the first visible pagination settles', async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate(async () => {
    const paginatorModule = '/foliate-js/paginator.js';
    const { Paginator } = await import(paginatorModule);
    const url = URL.createObjectURL(new Blob([`<!doctype html>
      <html><body>
        ${Array.from({ length: 160 }, (_, index) => `<p>Styled paragraph ${index} ${'content '.repeat(10)}</p>`).join('')}
      </body></html>`], { type: 'text/html' }));
    const renderer = new Paginator();
    renderer.style.cssText = 'display:block;width:720px;height:760px';
    renderer.setAttribute('flow', 'paginated');
    renderer.setAttribute('margin', '0px');
    renderer.setAttribute('gap', '5%');
    renderer.setAttribute('max-inline-size', '1000px');
    renderer.setAttribute('max-column-count', '1');
    renderer.setStyles([
      '',
      'body, p { font-size: 36px !important; line-height: 2 !important; margin: 0 0 1em 0 !important; }',
    ]);
    document.body.append(renderer);
    renderer.open({
      dir: 'ltr',
      sections: [{
        linear: 'yes',
        load: async () => url,
        unload: () => undefined,
      }],
    });
    const relocations: Array<{ page: number; pages: number }> = [];
    renderer.addEventListener('relocate', (() => {
      relocations.push({ page: renderer.page, pages: renderer.pages });
    }) as EventListener);

    await renderer.goTo({ index: 0, anchor: 0.5, reason: 'anchor' });
    const content = renderer.getContents()[0];
    const atResolve = {
      page: renderer.page,
      pages: renderer.pages,
      relocations: relocations.length,
      fontSize: content?.doc?.defaultView?.getComputedStyle(content.doc.body).fontSize ?? '',
    };
    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterSettled = {
      page: renderer.page,
      pages: renderer.pages,
      relocations: relocations.length,
      relocationStates: relocations.slice(atResolve.relocations),
    };
    renderer.destroy();
    renderer.remove();
    URL.revokeObjectURL(url);
    return { atResolve, afterSettled };
  });

  expect(result.atResolve.fontSize).toBe('36px');
  expect(result.afterSettled.page).toBe(result.atResolve.page);
  expect(result.afterSettled.pages).toBe(result.atResolve.pages);
  expect(result.afterSettled.relocationStates.every(({ page, pages }) => (
    page === result.atResolve.page && pages === result.atResolve.pages
  ))).toBe(true);
});

test('paginator clears paginated overlay width when switching to scroll mode', async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate(async () => {
    const paginatorModule = '/foliate-js/paginator.js';
    const { Paginator } = await import(paginatorModule);
    const url = URL.createObjectURL(new Blob([`<!doctype html><html><body>
      ${Array.from({ length: 180 }, (_, index) => `<p>Scrollable paragraph ${index} ${'content '.repeat(10)}</p>`).join('')}
    </body></html>`], { type: 'text/html' }));
    const renderer = new Paginator();
    renderer.style.cssText = 'display:block;width:720px;height:760px';
    renderer.setAttribute('flow', 'paginated');
    renderer.setAttribute('margin', '0px');
    renderer.setAttribute('gap', '5%');
    renderer.setAttribute('max-inline-size', '1000px');
    renderer.setAttribute('max-column-count', '1');
    document.body.append(renderer);

    const overlayRef: { current: SVGSVGElement | null } = { current: null };
    renderer.addEventListener('create-overlayer', ((event: CustomEvent) => {
      const overlayElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      overlayRef.current = overlayElement;
      Object.assign(overlayElement.style, {
        position: 'absolute',
        pointerEvents: 'none',
      });
      event.detail.attach({
        element: overlayElement,
        redraw: () => undefined,
      });
    }) as EventListener);
    renderer.open({
      dir: 'ltr',
      sections: [{
        linear: 'yes',
        load: async () => url,
        unload: () => undefined,
      }],
    });
    await renderer.goTo({ index: 0 });
    renderer.render();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const paginatedWidth = overlayRef.current?.style.width ?? '';
    const paginatedPixels = Number.parseFloat(paginatedWidth) || 0;

    renderer.setAttribute('flow', 'scrolled');
    await new Promise((resolve) => setTimeout(resolve, 120));
    const contents = renderer.getContents()[0];
    const scrollResult = {
      overlayWidth: overlayRef.current?.style.width ?? '',
      contentClientWidth: contents?.doc?.documentElement.clientWidth ?? 0,
      contentScrollWidth: contents?.doc?.documentElement.scrollWidth ?? 0,
    };
    renderer.destroy();
    renderer.remove();
    URL.revokeObjectURL(url);
    return { paginatedPixels, scrollResult };
  });

  expect(result.paginatedPixels).toBeGreaterThan(720);
  expect(result.scrollResult.overlayWidth).toBe('100%');
  expect(result.scrollResult.contentScrollWidth).toBeLessThanOrEqual(
    result.scrollResult.contentClientWidth + 1,
  );
});

test('paginator uses the visible host frame while staging reader-font pagination', async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate(async () => {
    const paginatorModule = '/foliate-js/paginator.js';
    const { Paginator } = await import(paginatorModule);
    const url = URL.createObjectURL(new Blob([`<!doctype html><html><body>
      <p id="hidden-frame-rAF-probe">${'staging font probe '.repeat(120)}</p>
    </body></html>`], { type: 'text/html' }));
    const renderer = new Paginator();
    renderer.style.cssText = 'display:block;width:720px;height:760px';
    renderer.setAttribute('flow', 'paginated');
    renderer.setAttribute('margin', '0px');
    renderer.setAttribute('gap', '5%');
    renderer.setAttribute('max-inline-size', '1000px');
    renderer.setAttribute('max-column-count', '1');
    renderer.setStyles(['', 'body { font-family: "RIDIBatang"; }']);
    document.body.append(renderer);
    renderer.open({
      dir: 'ltr',
      sections: [{ linear: 'yes', load: async () => url, unload: () => undefined }],
    });

    (window as Window & { __foliateReaderOpenTimingCount?: number }).__foliateReaderOpenTimingCount = 1;
    const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    let sectionLoaded = false;
    let hostFrameCalls = 0;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      if (sectionLoaded) hostFrameCalls += 1;
      return originalRequestAnimationFrame(callback);
    };
    const onTiming = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.phase === 'foliate-section-load' && detail?.sectionIndex === 0) {
        sectionLoaded = true;
      }
    };
    window.addEventListener('foliate-reader-open-timing', onTiming);

    const completed = await Promise.race([
      renderer.goTo({ index: 0, anchor: 0 }).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 800)),
    ]);

    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.removeEventListener('foliate-reader-open-timing', onTiming);
    (window as Window & { __foliateReaderOpenTimingCount?: number }).__foliateReaderOpenTimingCount = 0;
    renderer.destroy();
    renderer.remove();
    URL.revokeObjectURL(url);
    return { completed, sectionLoaded, hostFrameCalls };
  });

  expect(result.sectionLoaded).toBe(true);
  expect(result.completed).toBe(true);
  expect(result.hostFrameCalls).toBeGreaterThanOrEqual(1);
});

test('paginator uses the visible host frame while staging section-end pagination', async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate(async () => {
    const paginatorModule = '/foliate-js/paginator.js';
    const { Paginator } = await import(paginatorModule);
    const urls = [
      URL.createObjectURL(new Blob([`<!doctype html><html><body>
        <p id="hidden-section-end-rAF-probe">${'previous section '.repeat(180)}</p>
      </body></html>`], { type: 'text/html' })),
      URL.createObjectURL(new Blob([`<!doctype html><html><body><p>CURRENT SECTION</p></body></html>`], { type: 'text/html' })),
    ];
    const renderer = new Paginator();
    renderer.style.cssText = 'display:block;width:720px;height:760px';
    renderer.setAttribute('flow', 'paginated');
    renderer.setAttribute('margin', '0px');
    renderer.setAttribute('gap', '5%');
    renderer.setAttribute('max-inline-size', '1000px');
    renderer.setAttribute('max-column-count', '1');
    document.body.append(renderer);
    renderer.open({
      dir: 'ltr',
      sections: urls.map((url) => ({ linear: 'yes', load: async () => url, unload: () => undefined })),
    });
    await renderer.goTo({ index: 1, anchor: 0 });

    (window as Window & { __foliateReaderOpenTimingCount?: number }).__foliateReaderOpenTimingCount = 1;
    const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    let sectionLoaded = false;
    let hostFrameCalls = 0;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      if (sectionLoaded) hostFrameCalls += 1;
      return originalRequestAnimationFrame(callback);
    };
    const onTiming = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.phase === 'foliate-section-load' && detail?.sectionIndex === 0) {
        sectionLoaded = true;
      }
    };
    window.addEventListener('foliate-reader-open-timing', onTiming);

    const completed = await Promise.race([
      renderer.prev().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 800)),
    ]);
    const content = renderer.getContents()[0];
    const atSectionEnd = renderer.page === Math.max(1, renderer.pages - 2);

    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.removeEventListener('foliate-reader-open-timing', onTiming);
    (window as Window & { __foliateReaderOpenTimingCount?: number }).__foliateReaderOpenTimingCount = 0;
    renderer.destroy();
    renderer.remove();
    urls.forEach((url) => URL.revokeObjectURL(url));
    return {
      completed,
      sectionLoaded,
      hostFrameCalls,
      index: content?.index,
      atSectionEnd,
    };
  });

  expect(result.sectionLoaded).toBe(true);
  expect(result.completed).toBe(true);
  expect(result.hostFrameCalls).toBeGreaterThanOrEqual(3);
  expect(result.index).toBe(0);
  expect(result.atSectionEnd).toBe(true);
});

test('paginator page-turn tap skips the trailing sentinel before entering the next section', async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate(async () => {
    const paginatorModule = '/foliate-js/paginator.js';
    const { Paginator } = await import(paginatorModule);
    const urls = [
      URL.createObjectURL(new Blob([`<!doctype html><html><body style="font-size:22px;line-height:1.8;margin:0">
        ${Array.from({ length: 220 }, (_, index) => `<p>Large TXT chapter paragraph ${index} ${'content '.repeat(14)}</p>`).join('')}
        <p id="outgoing-end">OUTGOING-END</p>
      </body></html>`], { type: 'text/html' })),
      URL.createObjectURL(new Blob([`<!doctype html><html><body style="font-size:22px;line-height:1.8;margin:0">
        <p id="incoming-start">INCOMING-START</p>
        <p>${'next chapter '.repeat(80)}</p>
      </body></html>`], { type: 'text/html' })),
    ];
    const timings: Array<{ phase: string; durationMs?: number; sectionIndex?: number; sectionSize?: number }> = [];
    const onTiming = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      timings.push({
        phase: detail?.phase,
        durationMs: detail?.durationMs,
        sectionIndex: detail?.sectionIndex,
        sectionSize: detail?.sectionSize,
      });
    };
    (window as Window & { __foliateReaderOpenTimingCount?: number }).__foliateReaderOpenTimingCount = 1;
    window.addEventListener('foliate-reader-open-timing', onTiming);
    const renderer = new Paginator();
    renderer.style.cssText = 'display:block;width:720px;height:760px';
    renderer.setAttribute('flow', 'paginated');
    renderer.setAttribute('margin', '0px');
    renderer.setAttribute('gap', '5%');
    renderer.setAttribute('max-inline-size', '1000px');
    renderer.setAttribute('max-column-count', '1');
    renderer.setAttribute('swipe-navigation', 'false');
    renderer.setStyles(['', 'body { font-family: "RIDIBatang"; }']);
    document.body.append(renderer);
    renderer.open({
      dir: 'ltr',
      sections: urls.map((url) => ({
        linear: 'yes',
        load: async () => url,
        unload: () => undefined,
      })),
    });
    await renderer.goTo({ index: 0, anchor: 1 });
    const outgoingDoc = renderer.getContents()[0]?.doc as Document;
    const originalCreateRange = outgoingDoc.createRange.bind(outgoingDoc);
    let outgoingRangeCreations = 0;
    outgoingDoc.createRange = () => {
      outgoingRangeCreations += 1;
      return originalCreateRange();
    };
    const relocations: Array<{ index: number; text: string }> = [];
    renderer.addEventListener('relocate', ((event: CustomEvent) => {
      relocations.push({
        index: event.detail.index,
        text: event.detail.range?.toString?.() ?? '',
      });
    }) as EventListener);

    const before = {
      index: renderer.getContents()[0]?.index,
      page: renderer.page,
      pages: renderer.pages,
    };
    await renderer.next();
    const content = renderer.getContents()[0];
    const probe = {
      before,
      index: content?.index,
      page: renderer.page,
      outgoingRangeCreations,
      relocations,
      timings,
      incomingVisible: content?.doc.querySelector('#incoming-start') !== null,
    };
    window.removeEventListener('foliate-reader-open-timing', onTiming);
    (window as Window & { __foliateReaderOpenTimingCount?: number }).__foliateReaderOpenTimingCount = 0;
    renderer.destroy();
    renderer.remove();
    urls.forEach((url) => URL.revokeObjectURL(url));
    return probe;
  });

  expect(result.before.page).toBe(result.before.pages - 2);
  expect(result.index).toBe(1);
  expect(result.page).toBe(1);
  expect(result.incomingVisible).toBe(true);
  expect(result.outgoingRangeCreations).toBe(0);
  expect(result.relocations.length).toBeGreaterThan(0);
  expect(result.relocations.every(({ index }) => index === 1)).toBe(true);
  expect(result.timings.some(({ phase, sectionIndex }) => (
    phase === 'foliate-section-load' && sectionIndex === 0
  ))).toBe(true);
  expect(result.timings.some(({ phase, sectionIndex }) => (
    phase === 'foliate-section-stabilize' && sectionIndex === 1
  ))).toBe(true);
  expect(result.timings.some(({ phase, sectionIndex }) => (
    phase === 'foliate-section-anchor' && sectionIndex === 1
  ))).toBe(true);
  for (const phase of [
    'foliate-reader-font-load',
    'foliate-reader-font-frame',
    'foliate-reader-font-expand',
    'foliate-content-range-rect',
    'foliate-root-rect',
  ]) {
    const timing = result.timings.find((item) => item.phase === phase && item.sectionIndex === 1);
    expect(timing, phase).toBeTruthy();
    expect(timing?.durationMs, phase).toBeGreaterThanOrEqual(0);
  }
});

test('paginator waits for pagination and returns to the calculated last page across a section boundary', async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate(async () => {
    const paginatorModule = '/foliate-js/paginator.js';
    const { Paginator } = await import(paginatorModule);
    const previousUrl = URL.createObjectURL(new Blob([`<!doctype html>
      <html><body style="font-size:22px;line-height:1.8;margin:0">
        ${Array.from({ length: 180 }, (_, index) => `<p>Previous chapter paragraph ${index} ${'content '.repeat(12)}</p>`).join('')}
        <p id="chapter-end">PREVIOUS-CHAPTER-END</p>
      </body></html>`], { type: 'text/html' }));
    const currentUrl = URL.createObjectURL(new Blob([`<!doctype html>
      <html><body style="font-size:22px;line-height:1.8;margin:0">
        <p id="chapter-start">CURRENT-CHAPTER-START</p>
        <p>${'current chapter '.repeat(100)}</p>
      </body></html>`], { type: 'text/html' }));
    const renderer = new Paginator();
    renderer.style.cssText = 'display:block;width:720px;height:760px';
    renderer.setAttribute('flow', 'paginated');
    renderer.setAttribute('margin', '0px');
    renderer.setAttribute('gap', '5%');
    renderer.setAttribute('max-inline-size', '1000px');
    renderer.setAttribute('max-column-count', '1');
    renderer.setAttribute('swipe-navigation', 'false');
    document.body.append(renderer);
    const relocations: Array<{ index: number; text: string }> = [];
    renderer.addEventListener('relocate', ((event: CustomEvent) => {
      relocations.push({
        index: event.detail.index,
        text: event.detail.range?.toString?.() ?? '',
      });
    }) as EventListener);
    renderer.open({
      dir: 'ltr',
      sections: [previousUrl, currentUrl].map((url) => ({
        linear: 'yes',
        load: async () => url,
        unload: () => undefined,
      })),
    });
    await renderer.goTo({ index: 1, anchor: () => 0 });
    const before = { index: renderer.getContents()[0]?.index, page: renderer.page };
    relocations.length = 0;
    await renderer.prev();
    await new Promise((resolve) => setTimeout(resolve, 150));
    renderer.style.width = '680px';
    await new Promise((resolve) => setTimeout(resolve, 150));
    const content = renderer.getContents()[0];
    const endRect = content?.doc.querySelector('#chapter-end')?.getBoundingClientRect();
    const result = {
      before,
      index: content?.index,
      page: renderer.page,
      pages: renderer.pages,
      start: renderer.start,
      end: renderer.end,
      size: renderer.size,
      endRect: endRect ? { left: endRect.left, right: endRect.right } : null,
      relocations,
      latestRelocation: relocations.at(-1),
    };
    renderer.destroy();
    renderer.remove();
    URL.revokeObjectURL(previousUrl);
    URL.revokeObjectURL(currentUrl);
    return result;
  });

  expect(result.before).toEqual({ index: 1, page: 1 });
  expect(result.index).toBe(0);
  expect(result.page).toBe(result.pages - 2);
  expect(result.endRect).not.toBeNull();
  expect(result.endRect!.right).toBeGreaterThanOrEqual(result.start - result.size);
  expect(result.endRect!.left).toBeLessThanOrEqual(result.end - result.size);
  expect(result.latestRelocation?.index).toBe(0);
  expect(result.latestRelocation?.text).toContain('PREVIOUS-CHAPTER-END');
  const firstPreviousRelocation = result.relocations.findIndex(({ index }) => index === 0);
  expect(firstPreviousRelocation).toBeGreaterThanOrEqual(0);
  expect(result.relocations.slice(firstPreviousRelocation).every(({ index }) => index === 0)).toBe(true);
});

test('Foliate range annotations draw, receive taps, and delete in the active overlayer', async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate(async () => {
    const viewModule = '/foliate-js/view.js?v=1.8.34';
    await import(viewModule);
    await customElements.whenDefined('foliate-view');
    const urls = [
      '<!doctype html><html><body><a id="text" href="section-1">Cross-engine highlight probe text.</a></body></html>',
      '<!doctype html><html><body><p id="destination">Linked section.</p></body></html>',
    ].map((html) => URL.createObjectURL(new Blob([html], { type: 'text/html' })));
    const sections = urls.map((url, index) => ({
      id: `section-${index}`,
      linear: 'yes',
      size: 100,
      load: async () => url,
      unload: () => undefined,
    }));
    const book = {
      sections,
      toc: [],
      pageList: [],
      metadata: { language: 'en' },
      rendition: { layout: 'reflowable' },
      resolveHref: (href: string) => ({ index: href === 'section-1' ? 1 : 0 }),
      splitTOCHref: (href: string) => [href, null],
      getTOCFragment: (doc: Document) => doc.documentElement,
      destroy: () => undefined,
    };
    const view = document.createElement('foliate-view') as HTMLElement & {
      renderer: {
        getContents: () => Array<{
          doc: Document;
          index: number;
          overlayer?: {
            element: SVGElement;
            hitTest: (point: { x: number; y: number }) => unknown[];
          };
        }>;
      };
      open: (source: typeof book) => Promise<void>;
      init: (options: { lastLocation: string | null }) => Promise<void>;
      getCFI: (index: number, range: Range) => string;
      navigateTransient: (
        target: { index: number; range: Range },
        reason: string,
      ) => Promise<void>;
      addAnnotation: (annotation: { value: string; annotationId: string }) => Promise<unknown>;
      deleteAnnotation: (annotation: { value: string; annotationId: string }) => Promise<unknown>;
      addTransientOverlay: (overlay: {
        key: object;
        index: number;
        range: Range;
        draw: (rects: DOMRectList, options: { color: string }) => SVGElement;
        options: { color: string; interactive: boolean };
      }) => boolean;
      removeTransientOverlay: (overlay: { key: object; index: number }) => boolean;
      close: () => void;
    };
    view.style.cssText = 'display:block;width:720px;height:720px';
    let drawCount = 0;
    let showCount = 0;
    let overlayCount = 0;
    let linkCount = 0;
    view.addEventListener('draw-annotation', ((event: CustomEvent) => {
      drawCount += 1;
      event.detail.draw((rects: DOMRectList, options: { color: string }) => {
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('fill', options.color);
        group.setAttribute('data-e2e-highlight', 'true');
        for (const rect of Array.from(rects)) {
          const item = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          item.setAttribute('x', String(rect.left));
          item.setAttribute('y', String(rect.top));
          item.setAttribute('width', String(rect.width));
          item.setAttribute('height', String(rect.height));
          group.append(item);
        }
        return group;
      }, { color: '#facc15' });
    }) as EventListener);
    view.addEventListener('show-annotation', () => {
      showCount += 1;
    });
    view.addEventListener('link', () => {
      linkCount += 1;
    });
    view.addEventListener('create-overlay', () => {
      overlayCount += 1;
    });
    document.body.append(view);
    await view.open(book);
    await view.init({ lastLocation: null });
    const content = view.renderer.getContents()[0];
    const text = content.doc.querySelector('#text')?.firstChild;
    if (!text) throw new Error('annotation text missing');
    const range = content.doc.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 12);
    const value = view.getCFI(0, range);
    const annotation = { value, annotationId: 'annotation-1' };
    await view.addAnnotation(annotation);
    const relocateReasons: Array<string | null> = [];
    view.addEventListener('relocate', ((event: CustomEvent) => {
      relocateReasons.push(event.detail?.reason ?? null);
    }) as EventListener);
    await view.navigateTransient({ index: 0, range }, 'tts-navigation');
    const drawn = Boolean(content.overlayer?.element.querySelector('[data-e2e-highlight="true"]'));
    const rect = range.getBoundingClientRect();
    const ttsOverlayKey = {};
    const ttsOverlayAdded = view.addTransientOverlay({
      key: ttsOverlayKey,
      index: 0,
      range,
      draw: (rects: DOMRectList, options: { color: string }) => {
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('fill', options.color);
        group.setAttribute('data-e2e-tts-overlay', 'true');
        for (const itemRect of Array.from(rects)) {
          const item = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          item.setAttribute('x', String(itemRect.left));
          item.setAttribute('y', String(itemRect.top));
          item.setAttribute('width', String(itemRect.width));
          item.setAttribute('height', String(itemRect.height));
          group.append(item);
        }
        return group;
      },
      options: { color: '#38bdf8', interactive: false },
    });
    const savedDuringTts = Boolean(
      content.overlayer?.element.querySelector('[data-e2e-highlight="true"]'),
    );
    const ttsOverlayDrawn = Boolean(
      content.overlayer?.element.querySelector('[data-e2e-tts-overlay="true"]'),
    );
    const ttsOverlayHit = content.overlayer?.hitTest({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    }) ?? [];
    view.removeTransientOverlay({ key: ttsOverlayKey, index: 0 });
    const savedAfterTts = Boolean(
      content.overlayer?.element.querySelector('[data-e2e-highlight="true"]'),
    );
    const target = text.parentElement ?? content.doc.body;
    const click = new content.doc.defaultView!.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
    const clickResult = target.dispatchEvent(click);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const highlightedIndex = view.renderer.getContents()[0]?.index;
    const linksAfterHighlight = linkCount;
    const overlaysAfterHighlight = overlayCount;
    await view.deleteAnnotation(annotation);
    const deleted = !content.overlayer?.element.querySelector('[data-e2e-highlight="true"]');
    target.dispatchEvent(new content.doc.defaultView!.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
    const navigationDeadline = performance.now() + 2000;
    while ((view.renderer.getContents()[0]?.index !== 1 || overlayCount < 2)
      && performance.now() < navigationDeadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const plainLinkIndex = view.renderer.getContents()[0]?.index;
    view.close();
    view.remove();
    urls.forEach((url) => URL.revokeObjectURL(url));
    return {
      clickDefaultPrevented: !clickResult && click.defaultPrevented,
      deleted,
      drawCount,
      drawn,
      highlightedIndex,
      linksAfterHighlight,
      linkCount,
      overlaysAfterHighlight,
      overlayCount,
      plainLinkIndex,
      relocateReasons,
      savedAfterTts,
      savedDuringTts,
      showCount,
      ttsOverlayAdded,
      ttsOverlayDrawn,
      ttsOverlayHitIsSaved: ttsOverlayHit[0] === value,
    };
  });

  expect(result.overlaysAfterHighlight).toBe(1);
  expect(result.overlayCount).toBe(2);
  expect(result.drawCount).toBe(1);
  expect(result.drawn).toBe(true);
  expect(result.showCount).toBe(1);
  expect(result.clickDefaultPrevented).toBe(true);
  expect(result.highlightedIndex).toBe(0);
  expect(result.linksAfterHighlight).toBe(0);
  expect(result.deleted).toBe(true);
  expect(result.ttsOverlayAdded).toBe(true);
  expect(result.ttsOverlayDrawn).toBe(true);
  expect(result.savedDuringTts).toBe(true);
  expect(result.savedAfterTts).toBe(true);
  expect(result.ttsOverlayHitIsSaved).toBe(true);
  expect(result.relocateReasons).toContain('tts-navigation');
  expect(result.linkCount).toBe(1);
  expect(result.plainLinkIndex).toBe(1);
});

test('fixed layout blocks publication scripts and preserves navigation indexes', async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate<RendererProbe>(async () => {
    const fixedLayoutModule = '/foliate-js/fixed-layout.js';
    const { FixedLayout } = await import(fixedLayoutModule);
    const urls = [0, 1].map((index) => URL.createObjectURL(new Blob([
      `<!doctype html>
       <meta name="viewport" content="width=600,height=800">
       <body onload="parent.__publicationInlineHandlerRan = true">
         <button id="probe">Page ${index}</button>
         <p id="selection">Selectable text ${index}</p>
         <script>parent.__publicationScriptRan = true</script>
       </body>`,
    ], { type: 'text/html' })));
    const renderer = new FixedLayout();
    renderer.style.cssText = 'display:block;width:700px;height:800px';
    document.body.append(renderer);
    const events = { click: 0, keydown: 0, selectionchange: 0, touchstart: 0 };
    const loadedIndexes: number[] = [];
    const loadedDocuments: Document[] = [];
    renderer.addEventListener('load', ((event: CustomEvent) => {
      const { doc, index } = event.detail;
      loadedIndexes.push(index);
      loadedDocuments.push(doc);
      for (const name of Object.keys(events)) {
        doc.addEventListener(name, () => {
          events[name as keyof typeof events] += 1;
        });
      }
    }) as EventListener);
    renderer.open({
      dir: 'ltr',
      rendition: { layout: 'pre-paginated', spread: 'none' },
      sections: urls.map((url) => ({ id: url, load: async () => url })),
    });

    await renderer.goToSpread(0, 'center', 'initial');
    const first = renderer.getContents()[0];
    const firstDoc = first.doc as Document;
    const firstLoadMatched = loadedDocuments.at(-1) === firstDoc;
    const frameWindow = firstDoc.defaultView!;
    firstDoc.querySelector<HTMLButtonElement>('#probe')?.dispatchEvent(
      new frameWindow.MouseEvent('click', { bubbles: true }),
    );
    firstDoc.dispatchEvent(new frameWindow.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
    firstDoc.dispatchEvent(new frameWindow.Event('touchstart', { bubbles: true }));
    const selectionNode = firstDoc.querySelector('#selection')?.firstChild;
    if (selectionNode) {
      const range = firstDoc.createRange();
      range.selectNodeContents(selectionNode);
      firstDoc.getSelection()?.removeAllRanges();
      firstDoc.getSelection()?.addRange(range);
      firstDoc.dispatchEvent(new frameWindow.Event('selectionchange'));
    }
    await renderer.next();
    const contents = renderer.getContents();
    const sandbox = contents[0]?.doc.defaultView?.frameElement?.getAttribute('sandbox') ?? null;
    const probe = {
      contentIndexes: contents.map(({ index }: { index: number }) => index),
      events,
      firstLoadMatched,
      inlineHandlerRan: Boolean((window as typeof window & { __publicationInlineHandlerRan?: boolean }).__publicationInlineHandlerRan),
      loadedIndexes,
      sandbox,
      scriptRan: Boolean((window as typeof window & { __publicationScriptRan?: boolean }).__publicationScriptRan),
    };
    renderer.destroy();
    renderer.remove();
    urls.forEach((url) => URL.revokeObjectURL(url));
    return probe;
  });

  expect(result.sandbox).toBe('allow-same-origin allow-scripts');
  expect(result.scriptRan).toBe(false);
  expect(result.inlineHandlerRan).toBe(false);
  expect(result.loadedIndexes).toEqual([0, 1]);
  expect(result.contentIndexes).toEqual([1]);
  expect(result.firstLoadMatched).toBe(true);
  expect(result.events.click).toBe(1);
  expect(result.events.keydown).toBe(1);
  expect(result.events.touchstart).toBe(1);
  expect(result.events.selectionchange).toBeGreaterThanOrEqual(1);
});

test('publication sanitizer blocks executable, navigation, storage, and remote URL payloads', async ({ page }) => {
  await preparePage(page);
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://attacker.invalid/')) externalRequests.push(request.url());
  });

  const result = await page.evaluate(async () => {
    const sanitizerModule = '/foliate-js/publication-sanitizer.js';
    const { sanitizePublicationMarkup, PUBLICATION_CSP } = await import(sanitizerModule);
    Object.assign(window, {
      __publicationScriptRan: false,
      __publicationInlineHandlerRan: false,
    });
    const markup = `<!doctype html><html><head>
      <meta http-equiv="refresh" content="0;url=https://attacker.invalid/redirect">
      <base href="https://attacker.invalid/">
      <style>@import 'https://attacker.invalid/import.css'; body{background:url(https://attacker.invalid/bg.png)}</style>
      </head><body onload="parent.__publicationInlineHandlerRan=true">
      <script>localStorage.setItem('publication-pwned','1'); parent.__publicationScriptRan=true</script>
      <iframe src="https://attacker.invalid/frame"></iframe>
      <img id="remote" src="https://attacker.invalid/image.png" onerror="parent.__publicationInlineHandlerRan=true">
      <a id="external" href="https://example.com/book">external</a>
      <a id="script-link" href="javascript:parent.__publicationScriptRan=true">bad</a>
      <form id="form" action="https://attacker.invalid/form"><button>submit</button></form>
      <p id="safe">Readable text</p></body></html>`;
    const sanitized = sanitizePublicationMarkup(markup, 'text/html');
    const url = URL.createObjectURL(new Blob([sanitized], { type: 'text/html' }));
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.src = url;
    document.body.append(frame);
    await new Promise<void>((resolve, reject) => {
      // WebKit can defer a sandboxed blob-frame load while the full security
      // suite is running on a constrained CI worker. Keep the assertion strict,
      // but allow enough time for the same load event to arrive.
      const timeout = window.setTimeout(() => reject(new Error('sanitized frame timed out')), 15_000);
      frame.addEventListener('load', () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
    const doc = frame.contentDocument!;
    const external = doc.querySelector<HTMLAnchorElement>('#external')!;
    const output = {
      csp: doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
      expectedCsp: PUBLICATION_CSP,
      hasBlockedElements: Boolean(doc.querySelector('script,iframe,object,embed,base')),
      hasRemoteImage: doc.querySelector('#remote')?.hasAttribute('src'),
      hasRemoteStyle: Boolean(doc.querySelector('style')),
      hasScriptHref: doc.querySelector('#script-link')?.hasAttribute('href'),
      formAction: doc.querySelector('#form')?.hasAttribute('action'),
      externalTarget: external.target,
      externalRel: external.rel,
      readable: doc.querySelector('#safe')?.textContent,
      scriptRan: Boolean((window as typeof window & { __publicationScriptRan?: boolean }).__publicationScriptRan),
      handlerRan: Boolean((window as typeof window & { __publicationInlineHandlerRan?: boolean }).__publicationInlineHandlerRan),
      storageValue: localStorage.getItem('publication-pwned'),
    };
    frame.remove();
    URL.revokeObjectURL(url);
    return output;
  });

  expect(result.csp).toBe(result.expectedCsp);
  expect(result.hasBlockedElements).toBe(false);
  expect(result.hasRemoteImage).toBe(false);
  expect(result.hasRemoteStyle).toBe(false);
  expect(result.hasScriptHref).toBe(false);
  expect(result.formAction).toBe(false);
  expect(result.externalTarget).toBe('_blank');
  expect(result.externalRel).toBe('noopener noreferrer');
  expect(result.readable).toBe('Readable text');
  expect(result.scriptRan).toBe(false);
  expect(result.handlerRan).toBe(false);
  expect(result.storageValue).toBeNull();
  expect(externalRequests).toEqual([]);
});
