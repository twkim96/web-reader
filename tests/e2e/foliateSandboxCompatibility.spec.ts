import { expect, test } from '@playwright/test';

type RendererProbe = {
  contentIndexes: number[];
  events: Record<string, number>;
  inlineHandlerRan: boolean;
  firstLoadMatched: boolean;
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
