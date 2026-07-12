import { expect, test } from '@playwright/test';

type RendererProbe = {
  contentIndexes: number[];
  events: Record<string, number>;
  inlineHandlerRan: boolean;
  loadedIndexes: number[];
  sandbox: string | null;
  scriptRan: boolean;
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
         <script>parent.__publicationScriptRan = true</script>
       </body></html>`,
    ], { type: 'text/html' })));
    const renderer = new Paginator();
    renderer.style.cssText = 'display:block;width:720px;height:760px';
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
    renderer.addEventListener('load', ((event: CustomEvent) => {
      const { doc, index } = event.detail;
      loadedIndexes.push(index);
      for (const name of Object.keys(events)) {
        doc.addEventListener(name, () => {
          events[name as keyof typeof events] += 1;
        });
      }
    }) as EventListener);

    await renderer.goTo({ index: 0 });
    const first = renderer.getContents()[0];
    const firstDoc = first.doc as Document;
    firstDoc.querySelector<HTMLButtonElement>('#probe')?.click();
    firstDoc.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
    firstDoc.dispatchEvent(new Event('touchstart', { bubbles: true }));
    const selectionNode = firstDoc.querySelector('#selection')?.firstChild;
    if (selectionNode) {
      const range = firstDoc.createRange();
      range.selectNodeContents(selectionNode);
      firstDoc.getSelection()?.removeAllRanges();
      firstDoc.getSelection()?.addRange(range);
      firstDoc.dispatchEvent(new Event('selectionchange'));
    }
    await renderer.nextSection();
    const contents = renderer.getContents();
    const sandbox = contents[0]?.doc.defaultView?.frameElement?.getAttribute('sandbox') ?? null;
    const probe = {
      contentIndexes: contents.map(({ index }: { index: number }) => index),
      events,
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

  expect(result.sandbox).toBe('allow-same-origin');
  expect(result.scriptRan).toBe(false);
  expect(result.inlineHandlerRan).toBe(false);
  expect(result.loadedIndexes).toEqual([0, 1]);
  expect(result.contentIndexes).toEqual([1]);
  expect(result.events).toEqual({ click: 1, keydown: 1, selectionchange: 1, touchstart: 1 });
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
    renderer.addEventListener('load', ((event: CustomEvent) => {
      const { doc, index } = event.detail;
      loadedIndexes.push(index);
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
    firstDoc.querySelector<HTMLButtonElement>('#probe')?.click();
    firstDoc.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
    firstDoc.dispatchEvent(new Event('touchstart', { bubbles: true }));
    const selectionNode = firstDoc.querySelector('#selection')?.firstChild;
    if (selectionNode) {
      const range = firstDoc.createRange();
      range.selectNodeContents(selectionNode);
      firstDoc.getSelection()?.removeAllRanges();
      firstDoc.getSelection()?.addRange(range);
      firstDoc.dispatchEvent(new Event('selectionchange'));
    }
    await renderer.next();
    const contents = renderer.getContents();
    const sandbox = contents[0]?.doc.defaultView?.frameElement?.getAttribute('sandbox') ?? null;
    const probe = {
      contentIndexes: contents.map(({ index }: { index: number }) => index),
      events,
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

  expect(result.sandbox).toBe('allow-same-origin');
  expect(result.scriptRan).toBe(false);
  expect(result.inlineHandlerRan).toBe(false);
  expect(result.loadedIndexes).toEqual([0, 1]);
  expect(result.contentIndexes).toEqual([1]);
  expect(result.events).toEqual({ click: 1, keydown: 1, selectionchange: 1, touchstart: 1 });
});
