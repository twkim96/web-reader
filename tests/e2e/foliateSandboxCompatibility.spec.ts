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

test('Foliate range annotations draw, receive taps, and delete in the active overlayer', async ({ page }) => {
  await preparePage(page);
  const result = await page.evaluate(async () => {
    const viewModule = '/foliate-js/view.js?v=1.8.5';
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
          overlayer?: { element: SVGElement };
        }>;
      };
      open: (source: typeof book) => Promise<void>;
      init: (options: { lastLocation: string | null }) => Promise<void>;
      getCFI: (index: number, range: Range) => string;
      addAnnotation: (annotation: { value: string; annotationId: string }) => Promise<unknown>;
      deleteAnnotation: (annotation: { value: string; annotationId: string }) => Promise<unknown>;
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
    const drawn = Boolean(content.overlayer?.element.querySelector('[data-e2e-highlight="true"]'));
    const rect = range.getBoundingClientRect();
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
      showCount,
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
      const timeout = window.setTimeout(() => reject(new Error('sanitized frame timed out')), 5_000);
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
