import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';

const makeBook = async () => {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">rapid-selection-fixture</dc:identifier><dc:title>Rapid selection</dc:title><dc:language>en</dc:language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>');
  zip.file('one.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Selection</title></head><body>${Array.from({ length: 150 }, (_, index) => `<p>Rapid reader selection paragraph ${index}. ${'Continuous navigation must not select this paragraph. '.repeat(8)}</p>`).join('')}</body></html>`);
  return zip.generateAsync({ type: 'nodebuffer' });
};

const textPoint = (page: Page) => page.evaluate(() => {
  const view = document.querySelector('foliate-view') as HTMLElement & {
    lastLocation?: { cfi: string; range?: Range };
    renderer: { getContents: () => Array<{ doc: Document }> };
  };
  const contents = view.renderer.getContents();
  const doc = contents.find(({ doc }) => doc === view.lastLocation?.range?.startContainer.ownerDocument)?.doc ?? contents[0].doc;
  const frame = doc.defaultView!.frameElement!;
  const frameRect = frame.getBoundingClientRect();
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent?.includes('Continuous navigation')) continue;
    const range = doc.createRange();
    range.selectNodeContents(walker.currentNode);
    const rect = [...range.getClientRects()].find(rect => (
      rect.width > 300
      && frameRect.left + rect.left * frameRect.width / frame.clientWidth > 0
      && frameRect.left + rect.right * frameRect.width / frame.clientWidth < window.innerWidth
      && rect.top > doc.defaultView!.innerHeight * 0.55
      && rect.bottom < doc.defaultView!.innerHeight * 0.85
    ));
    if (!rect) continue;
    return {
      x: frameRect.left + (rect.left + rect.width * 0.75) * frameRect.width / frame.clientWidth,
      y: frameRect.top + (rect.top + rect.height / 2) * frameRect.height / frame.clientHeight,
      cfi: view.lastLocation?.cfi,
    };
  }
  throw new Error('No visible navigation text found');
});

const currentCfi = (page: Page) => page.evaluate(() => (
  document.querySelector('foliate-view') as HTMLElement & { lastLocation?: { cfi: string } }
).lastLocation?.cfi);

const selectedText = (page: Page) => page.evaluate(() => {
  const view = document.querySelector('foliate-view') as HTMLElement & {
    renderer: { getContents: () => Array<{ doc: Document }> };
  };
  return view.renderer.getContents().map(({ doc }) => doc.getSelection()?.toString() ?? '').join('');
});

test('rapid page clicks never create a native selection before release, while dragging still selects text', async ({ page }, testInfo) => {
  await page.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('neverShowInstallPrompt', 'true');
    localStorage.setItem('viewer_settings', JSON.stringify({ navMode: 'left-right', fontFamily: 'sans', fontSize: 18, tapLeftRightPercent: 40 }));
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Guest Library', exact: true })).toBeVisible();
  await page.locator('button[title="Add Local Book"]:visible').first().click();
  await page.locator('input[type="file"]').setInputFiles({ name: 'rapid-selection.epub', mimeType: 'application/epub+zip', buffer: await makeBook() });
  await page.getByRole('button', { name: '추가', exact: true }).click();
  const card = page.locator('[data-shelf-book-id]').filter({ hasText: 'rapid-selection' }).first();
  await expect(card).toBeVisible({ timeout: 30000 });
  await card.click();
  await expect(page.locator('foliate-view')).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('Loading...', { exact: true })).toBeHidden({ timeout: 30000 });
  const point = await textPoint(page);
  await page.evaluate(() => {
    const probe = window as typeof window & { beforeRelease: string[] };
    probe.beforeRelease = [];
    const view = document.querySelector('foliate-view') as HTMLElement & { renderer: { getContents: () => Array<{ doc: Document }> } };
    for (const { doc } of view.renderer.getContents()) {
      doc.defaultView!.addEventListener('pointerup', () => {
        probe.beforeRelease.push(doc.getSelection()?.toString() ?? '');
      }, true);
    }
  });
  await page.mouse.click(point.x, point.y);
  await expect.poll(async () => await currentCfi(page)).not.toBe(point.cfi);
  // Native double/triple-click selection happens on mouse-down. Checking after
  // release would miss the flash because the existing pointerup code clears it.
  for (const clickCount of [2, 3]) {
    await page.evaluate(async () => {
      const view = document.querySelector('foliate-view') as HTMLElement & { waitForNavigationReady: () => Promise<boolean> };
      await view.waitForNavigationReady();
    });
    const before = await currentCfi(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down({ clickCount });
    await page.mouse.up({ clickCount });
    await expect.poll(async () => await currentCfi(page)).not.toBe(before);
  }
  expect(await page.evaluate(() => (window as typeof window & { beforeRelease: string[] }).beforeRelease)).toEqual(['', '', '']);
  await expect(page.locator('[data-reader-selection-menu]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('rapid-navigation-no-selection.png') });
  const drag = await textPoint(page);
  await page.mouse.move(drag.x - 80, drag.y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.move(drag.x + 40, drag.y, { steps: 8 });
  expect((await selectedText(page)).length).toBeGreaterThan(0);
  await page.mouse.up();
  await expect(page.locator('[data-reader-selection-menu]')).toBeVisible();
});
