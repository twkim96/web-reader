import { expect, test } from './fixtures';

test('archive webtoon joins images, tracks only the visible page, and bounds prefetch and decoded images', async ({ page }) => {
  await page.route('**/__archive-webtoon-fixture', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><body style="margin:0"></body>',
  }));
  await page.goto('/__archive-webtoon-fixture');
  await page.evaluate(async () => {
    const modulePath = '/foliate-js/fixed-layout.js';
    const { FixedLayout } = await import(modulePath);
    const dimensions = Array.from({ length: 24 }, (_, index) => [600, index === 7 ? 20 : 1800]);
    const blobs = await Promise.all(dimensions.map(async ([width, height]) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#345678';
      context.fillRect(0, 0, width, height);
      return await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
    }));
    const urls = dimensions.map(([width, height], index) => URL.createObjectURL(new Blob([
      `<!doctype html><meta name="viewport" content="width=${width},height=${height}"><img src="${URL.createObjectURL(blobs[index])}">`,
    ], { type: 'text/html' })));
    const calls: number[] = [];
    const relocates: number[] = [];
    const renderer = new FixedLayout();
    renderer.style.cssText = 'display:flex;width:720px;height:480px';
    document.body.append(renderer);
    renderer.addEventListener('relocate', () => relocates.push(renderer.index));
    renderer.open({ rendition: { layout: 'pre-paginated', spread: 'none' },
      sections: urls.map(url => ({ id: url, load: async () => url })),
      getImagePage: async (index: number, signal: AbortSignal) => {
        calls.push(index);
        await new Promise(resolve => setTimeout(resolve, 5));
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        return { blob: blobs[index], width: index === 8 ? null : dimensions[index][0], height: index === 8 ? null : dimensions[index][1] };
      },
    });
    renderer.setAttribute('webtoon', 'true');
    await renderer.goToSpread(6, 'center', 'initial');
    Object.assign(window, { probeRenderer: renderer, probeCalls: calls, probeRelocates: relocates });
  });
  const probe = () => page.evaluate(() => {
    const { probeRenderer: renderer, probeCalls: calls, probeRelocates: relocates } = window as unknown as {
      probeRenderer: HTMLElement & { index: number; getContents(): Array<{ doc: Document }> };
      probeCalls: number[]; probeRelocates: number[];
    };
    const doc = renderer.getContents()[0]?.doc;
    if (!doc) return { index: renderer.index, calls, relocates };
    const image = doc.querySelector<HTMLImageElement>('[data-image-index="6"] img');
    return { index: renderer.index, calls, relocates, slots: doc.querySelectorAll('[data-image-index]').length,
      decoded: doc.querySelectorAll('img').length, width: image?.getBoundingClientRect().width,
      height: image?.getBoundingClientRect().height,
      stripHeight: doc.querySelector<HTMLElement>('[data-image-index="7"]')?.getBoundingClientRect().height };
  });
  await expect.poll(async () => (await probe()).calls.length).toBe(11);
  await expect.poll(async () => (await probe()).stripHeight).toBeCloseTo(24, 0);
  const initial = await probe();
  expect(initial.index).toBe(6);
  expect(initial.relocates).toEqual([6]);
  expect(initial.slots).toBe(11);
  expect(initial.decoded).toBeLessThanOrEqual(4);
  expect(initial.width).toBeCloseTo(720, 0);
  expect(initial.height).toBeCloseTo(2160, 0);
  await page.evaluate(async () => {
    const renderer = Reflect.get(window, 'probeRenderer');
    await renderer.scrollWebtoon(2150, true);
  });
  expect((await probe()).index).toBe(6);
  await page.evaluate(() => {
    const renderer = Reflect.get(window, 'probeRenderer');
    const doc = renderer.getContents()[0].doc;
    const root = doc.scrollingElement;
    const descriptor = Object.getOwnPropertyDescriptor(doc.defaultView.Element.prototype, 'scrollTop')!;
    Reflect.set(window, 'scrollPositionWrites', 0);
    Object.defineProperty(root, 'scrollTop', {
      configurable: true,
      get: () => descriptor.get!.call(root),
      set: value => {
        Reflect.set(window, 'scrollPositionWrites', Reflect.get(window, 'scrollPositionWrites') + 1);
        descriptor.set!.call(root, value);
      },
    });
  });
  await page.evaluate(async () => Reflect.get(window, 'probeRenderer').scrollWebtoon(20, true));
  expect(await page.evaluate(() => Reflect.get(window, 'scrollPositionWrites'))).toBe(1);
  await expect.poll(async () => (await probe()).index).toBe(7);
  await page.evaluate(async () => Reflect.get(window, 'probeRenderer').scrollWebtoon(40, true));
  await expect.poll(async () => (await probe()).index).toBe(8);
  await page.evaluate(async () => Reflect.get(window, 'probeRenderer').scrollWebtoon(-100, true));
  await expect.poll(async () => (await probe()).index).toBe(6);
  await page.evaluate(() => { Reflect.get(window, 'probeRenderer').style.width = '540px'; });
  await expect.poll(async () => (await probe()).width).toBeCloseTo(540, 0);
  expect((await probe()).index).toBe(6);
  expect((await probe()).relocates).toEqual([6, 7, 8, 6]);
  await page.evaluate(async () => Reflect.get(window, 'probeRenderer').goTo({ index: 20 }));
  expect((await probe()).index).toBe(20);
  expect((await probe()).slots).toBeLessThanOrEqual(11);
  await page.evaluate(() => Reflect.get(window, 'probeRenderer').setAttribute('webtoon', 'false'));
  await expect.poll(async () => (await probe()).index).toBe(20);
  await page.evaluate(() => Reflect.get(window, 'probeRenderer').destroy());
});

test('archive webtoon cancels superseded loads and releases image URLs on close', async ({ page }) => {
  await page.route('**/__archive-webtoon-lifecycle', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><body style="margin:0"></body>',
  }));
  await page.goto('/__archive-webtoon-lifecycle');
  const result = await page.evaluate(async () => {
    const modulePath = '/foliate-js/fixed-layout.js';
    const { FixedLayout } = await import(modulePath);
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 900;
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
    const activeURLs = new Set<string>();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = create(value); activeURLs.add(url); return url; };
    URL.revokeObjectURL = value => { activeURLs.delete(value); revoke(value); };
    const calls: number[] = [];
    const signals: AbortSignal[] = [];
    const relocates: number[] = [];
    let loading = 0, maxLoading = 0;
    const renderer = new FixedLayout();
    renderer.style.cssText = 'display:block;width:720px;height:480px';
    document.body.append(renderer);
    renderer.addEventListener('relocate', () => relocates.push(renderer.index));
    renderer.open({ rendition: { layout: 'pre-paginated', spread: 'none' },
      sections: Array.from({ length: 30 }, (_, index) => ({ id: index })),
      getImagePage: async (index: number, signal: AbortSignal) => {
        calls.push(index);
        signals.push(signal);
        loading++;
        maxLoading = Math.max(maxLoading, loading);
        try {
          if (index < 15) await new Promise((_, reject) => {
            const abort = () => reject(new DOMException('aborted', 'AbortError'));
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
          else await new Promise(resolve => setTimeout(resolve, 5));
          return { blob, width: 600, height: 900 };
        } finally { loading--; }
      },
    });
    renderer.setAttribute('webtoon', 'true');
    const superseded = renderer.goTo({ index: 10 }).then(() => 'committed', (error: Error) => error.name);
    while (calls.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
    await renderer.goTo({ index: 20 });
    const oldResult = await superseded;
    const current = renderer.index;
    const doc = renderer.getContents()[0].doc;
    let releaseDecode: (() => void) | undefined;
    doc.defaultView!.HTMLImageElement.prototype.decode = () => new Promise((_, reject) => {
      releaseDecode = () => reject(new DOMException('closed', 'EncodingError'));
    });
    const closing = renderer.goTo({ index: 21 }).then(() => 'committed', (error: Error) => error.name);
    while (!releaseDecode) await new Promise(resolve => setTimeout(resolve, 1));
    renderer.destroy();
    const closeResult = await closing;
    releaseDecode();
    await new Promise(resolve => setTimeout(resolve, 15));
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    return { oldResult, closeResult, current, relocates, maxLoading, activeURLs: activeURLs.size, aborted: signals.every(signal => signal.aborted) };
  });
  expect(result.oldResult).toBe('AbortError');
  expect(result.closeResult).toBe('AbortError');
  expect(result.current).toBe(20);
  expect(result.relocates).toEqual([20]);
  expect(result.maxLoading).toBeLessThanOrEqual(2);
  expect(result.activeURLs).toBe(0);
  expect(result.aborted).toBe(true);
});

test('short image strips fill the viewport without trapping the reader in the first prefetch window', async ({ page }) => {
  await page.route('**/__archive-webtoon-strips', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><body style="margin:0"></body>',
  }));
  await page.goto('/__archive-webtoon-strips');
  await page.evaluate(async () => {
    const modulePath = '/foliate-js/fixed-layout.js';
    const { FixedLayout } = await import(modulePath);
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 20;
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
    const renderer = new FixedLayout();
    renderer.style.cssText = 'display:block;width:600px;height:480px';
    document.body.append(renderer);
    renderer.open({ rendition: { layout: 'pre-paginated', spread: 'none' },
      sections: Array.from({ length: 12 }, (_, id) => ({ id })),
      getImagePage: async () => ({ blob, width: null, height: null }),
    });
    renderer.setAttribute('webtoon', 'true');
    await renderer.goTo({ index: 0 });
    Object.assign(window, { stripRenderer: renderer });
  });
  await expect.poll(() => page.evaluate(() => {
    const renderer = Reflect.get(window, 'stripRenderer');
    return renderer.getContents()[0].doc.querySelectorAll('img').length;
  })).toBe(12);
  expect(await page.evaluate(() => Reflect.get(window, 'stripRenderer').index)).toBe(0);
  await page.evaluate(() => Reflect.get(window, 'stripRenderer').scrollWebtoon(100));
  expect(await page.evaluate(() => Reflect.get(window, 'stripRenderer').index)).toBe(11);
  await page.evaluate(() => Reflect.get(window, 'stripRenderer').scrollWebtoon(-100));
  expect(await page.evaluate(() => Reflect.get(window, 'stripRenderer').index)).toBe(0);
  await page.evaluate(() => Reflect.get(window, 'stripRenderer').destroy());
});
