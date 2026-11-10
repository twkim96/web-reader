import { expect, test } from './fixtures';

test('archive webtoon fits width without distortion and turns only beyond the image edge', async ({ page }) => {
  await page.route('**/__archive-webtoon-fixture', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><body style="margin:0"></body>',
  }));
  await page.goto('/__archive-webtoon-fixture');
  const result = await page.evaluate(async () => {
    const modulePath = '/foliate-js/fixed-layout.js';
    const { FixedLayout } = await import(modulePath);
    const dimensions = [[600, 1800], [1200, 600]];
    const urls = dimensions.map(([width, height]) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#345678';
      context.fillRect(0, 0, width, height);
      return URL.createObjectURL(new Blob([`<!doctype html><style>
        html,body{margin:0;width:100%;height:100%;overflow:hidden}
        body{display:flex;align-items:center;justify-content:center}
        img{display:block;max-width:100%;max-height:100%;object-fit:contain}
        </style><img src="${canvas.toDataURL()}">`], { type: 'text/html' }));
    });
    const renderer = new FixedLayout();
    renderer.style.cssText = 'display:flex;width:720px;height:480px';
    document.body.append(renderer);
    renderer.open({ rendition: { layout: 'pre-paginated', spread: 'none' },
      sections: urls.map(url => ({ id: url, load: async () => url })) });
    await renderer.goToSpread(0, 'center', 'initial');
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await settle();
    const size = () => {
      const img = renderer.getContents()[0].doc.querySelector('img');
      const rect = img.getBoundingClientRect();
      return { width: rect.width * renderer.effectiveScale, height: rect.height * renderer.effectiveScale };
    };
    const fitted = size();
    renderer.setAttribute('webtoon', 'true');
    await settle();
    const tall = size();
    const top = renderer.scrollTop;
    const noPrematureTurn = await renderer.scrollWebtoon(renderer.scrollHeight - renderer.clientHeight, true);
    const reachedEdge = renderer.getWebtoonBoundary(1);
    const indexAtEdge = renderer.index;
    const turned = await renderer.scrollWebtoon(100, true);
    const short = size();
    const nextTop = renderer.scrollTop;
    const nextIndex = renderer.index;
    await renderer.scrollWebtoon(1000, false);
    const lastNoWrap = await renderer.scrollWebtoon(100, true);
    const lastIndex = renderer.index;
    await renderer.scrollWebtoon(-1000, false);
    const previous = await renderer.scrollWebtoon(-100, true);
    const previousAtBottom = renderer.getWebtoonBoundary(1);
    renderer.style.width = '540px';
    await settle();
    const resized = size();
    renderer.setAttribute('webtoon', 'false');
    await settle();
    const restored = size();
    renderer.destroy();
    renderer.remove();
    urls.forEach(url => URL.revokeObjectURL(url));
    return { fitted, tall, top, noPrematureTurn, reachedEdge, indexAtEdge, turned,
      short, nextTop, nextIndex, lastNoWrap, lastIndex, previous, previousAtBottom, resized, restored };
  });
  expect(result.fitted.height).toBeCloseTo(480, 0);
  expect(result.tall.width).toBeCloseTo(720, 0);
  expect(result.tall.height / result.tall.width).toBeCloseTo(3, 4);
  expect(result.top).toBe(0);
  expect(result.noPrematureTurn).toBe(false);
  expect(result.reachedEdge).toBe(true);
  expect(result.indexAtEdge).toBe(0);
  expect(result.turned).toBe(true);
  expect(result.short.width).toBeCloseTo(720, 0);
  expect(result.short.height / result.short.width).toBeCloseTo(0.5, 4);
  expect(result.nextTop).toBe(0);
  expect(result.nextIndex).toBe(1);
  expect(result.lastNoWrap).toBe(false);
  expect(result.lastIndex).toBe(1);
  expect(result.previous).toBe(true);
  expect(result.previousAtBottom).toBe(true);
  expect(result.resized.width).toBeCloseTo(540, 0);
  expect(result.restored.height).toBeCloseTo(480, 0);
});
