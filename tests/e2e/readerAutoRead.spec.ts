import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';

const makeBook = async () => {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('book.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">auto-read-fixture</dc:identifier><dc:title>자동읽기 테스트</dc:title><dc:language>ko</dc:language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>');
  zip.file('one.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>첫 장</title></head><body><p>첫째 <em>단어</em> 문장입니다. 둘째 문장입니다. 셋째 문장입니다.</p><p hidden="hidden">숨겨진문장</p><p>마지막 단어입니다.</p></body></html>');
  zip.file('two.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>다음 장</title></head><body><p>다음장의 시작입니다. ${'계속 읽습니다. '.repeat(50)}끝입니다.</p></body></html>`);
  return zip.generateAsync({ type: 'nodebuffer' });
};

const openTwoChapterBook = async (page: Page) => {
  await page.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('neverShowInstallPrompt', 'true');
    localStorage.setItem('viewer_settings', JSON.stringify({ theme: 'midnight', navMode: 'scroll', fontFamily: 'ridi', autoOpenLastBook: false }));
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Guest Library', exact: true })).toBeVisible();
  await page.locator('button[title="Add Local Book"]:visible').first().click();
  await page.locator('input[type="file"]').setInputFiles({ name: 'auto-read.epub', mimeType: 'application/epub+zip', buffer: await makeBook() });
  await page.getByRole('button', { name: '추가', exact: true }).click();
  const card = page.locator('[data-shelf-book-id]').filter({ hasText: 'auto-read' }).first();
  await expect(card).toBeVisible({ timeout: 30000 });
  await card.click();
  await expect(page.locator('[data-reader-shell]')).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('Loading...', { exact: true })).toBeHidden({ timeout: 30000 });
};

test('auto reading controls, continuous playback, chapter continuation and return to the current word', async ({ page }, testInfo) => {
  await openTwoChapterBook(page);
  const open = page.getByRole('button', { name: '현재 위치부터 자동읽기', exact: true });
  const originalCfi = await page.evaluate(() => {
    const view = document.querySelector('foliate-view') as HTMLElement & { lastLocation: { cfi: string; anchorCfi?: string } };
    return view.lastLocation.anchorCfi || view.lastLocation.cfi;
  });
  if (!await open.isVisible()) await page.locator('[data-reader-content]').click({ position: { x: 640, y: 400 } });
  await expect(open).toBeVisible();
  const x = await open.boundingBox();
  const tts = await page.getByRole('button', { name: /현재 위치부터 듣기|이 브라우저는 TTS 미지원/ }).boundingBox();
  expect(x!.x).toBeLessThan(tts!.x);
  await open.click();
  const modal = page.getByRole('dialog', { name: '자동읽기', exact: true });
  const state = page.locator('[data-reader-auto-read]');
  const word = page.locator('[data-auto-read-word]');
  await expect(modal).toBeVisible();
  await expect(word).toHaveText('첫째');
  await expect(modal).not.toContainText('숨겨진문장');
  await expect(page.locator('[data-reader-modal-backdrop]')).toHaveCSS('backdrop-filter', /blur/);
  await page.getByRole('button', { name: '다음 단어', exact: true }).click();
  await expect(word).toHaveText('단어');
  await page.getByRole('button', { name: '이전 단어', exact: true }).click();
  await expect(word).toHaveText('첫째');
  const position = page.getByRole('slider', { name: '자동읽기 위치' });
  const positionBounds = await position.boundingBox();
  await position.click({ position: { x: positionBounds!.width / 2, y: positionBounds!.height / 2 } });
  await expect(state).toHaveAttribute('data-auto-read-index', '4');
  await expect(position).toHaveAttribute('aria-valuetext', '5/9 단어');
  await position.press('Home');
  await expect(modal.getByRole('switch')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '자동읽기 재생', exact: true })).toHaveText('');
  await expect(word.locator('.text-accent-500')).toHaveText('첫');
  await page.getByRole('slider', { name: '자동읽기 속도' }).press('End');
  await page.getByRole('button', { name: '자동읽기 재생', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(state).toHaveAttribute('data-auto-read-playing', 'false');
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(state).toHaveAttribute('data-auto-read-playing', 'false');
  await page.getByRole('button', { name: '자동읽기 재생', exact: true }).click();
  await expect(state).toHaveAttribute('data-auto-read-section', '1');
  await expect(modal).not.toContainText('복기');
  await page.getByRole('button', { name: '자동읽기 일시정지', exact: true }).click();
  await expect(state).toHaveAttribute('data-auto-read-playing', 'false');
  const pausedIndex = await state.getAttribute('data-auto-read-index');
  await page.waitForTimeout(300);
  await expect(state).toHaveAttribute('data-auto-read-index', pausedIndex!);
  await page.getByRole('slider', { name: '자동읽기 위치' }).press('Home');
  await page.locator('[data-auto-read-stage]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(state).toHaveAttribute('data-auto-read-index', '1');
  await page.keyboard.press('Space');
  await expect(state).toHaveAttribute('data-auto-read-playing', 'true');
  await page.keyboard.press('Space');
  await expect(state).toHaveAttribute('data-auto-read-playing', 'false');
  await page.getByRole('slider', { name: '자동읽기 위치' }).press('Home');
  await expect(word).toHaveAttribute('aria-label', '다음장의');
  await page.screenshot({ path: testInfo.outputPath('auto-read-desktop.png'), scale: 'css' });
  await page.setViewportSize({ width: 360, height: 780 });
  const bounds = await modal.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
  await page.screenshot({ path: testInfo.outputPath('auto-read-mobile.png'), scale: 'css' });
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  // Reopening must start at the word returned to the actual renderer, including across chapters.
  await page.setViewportSize({ width: 1280, height: 800 });
  if (!await open.isVisible()) await page.locator('[data-reader-content]').click({ position: { x: 640, y: 400 } });
  await open.click();
  await expect(word).toHaveAttribute('aria-label', '다음장의');
  await page.goBack();
  await expect(modal).toBeHidden();
  await expect(page.locator('[data-reader-shell]')).toBeVisible();
  await open.click();
  await page.getByRole('button', { name: '다음 단어', exact: true }).click();
  // A remote adoption uses the renderer's real navigation too. Superseding the
  // original position must dismiss the snapshot without saving its stale word.
  await page.evaluate(async (cfi) => {
    const view = document.querySelector('foliate-view') as HTMLElement & {
      goTo: (cfi: string) => Promise<unknown>;
    };
    await view.goTo(cfi);
  }, originalCfi);
  await expect(modal).toBeHidden();
  await open.click();
  await expect(word).toHaveAttribute('aria-label', '첫째');
  await page.keyboard.press('Escape');
});

test('skipping the last TTS sentence starts the following chapter', async ({ page }) => {
  await page.addInitScript(() => {
    class TestUtterance {
      onstart?: () => void;
      constructor(public text: string) {}
    }
    const speech = Object.assign(new EventTarget(), {
      speaking: false,
      pending: false,
      paused: false,
      getVoices: () => [],
      speak(utterance: TestUtterance) {
        speech.speaking = true;
        queueMicrotask(() => utterance.onstart?.());
      },
      cancel() { speech.speaking = false; },
    });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: speech });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: TestUtterance });
  });
  await openTwoChapterBook(page);
  const start = page.getByRole('button', { name: '현재 위치부터 듣기', exact: true });
  if (!await start.isVisible()) await page.locator('[data-reader-content]').click({ position: { x: 640, y: 400 } });
  await start.click();

  const controls = page.locator('[data-reader-tts-controls="true"]');
  await expect(controls).toContainText('현재 장 연속 읽는 중');
  const options = controls.getByText('음성·언어·속도', { exact: true });
  await options.click();
  await controls.getByLabel('장 끝 동작').selectOption('next');
  await options.click();
  const next = controls.getByRole('button', { name: '다음 문장', exact: true });
  const sentences = Number(await controls.getAttribute('data-reader-tts-total'));
  expect(sentences).toBeGreaterThan(1);
  for (let i = 1; i < sentences; i++) {
    await next.click();
    await expect(controls).toHaveAttribute('data-reader-tts-index', String(i));
  }
  await expect(controls).toContainText('마지막 단어입니다.');
  await next.click();
  await expect(controls).toContainText('다음장의 시작입니다.');
  await expect(controls).toHaveAttribute('data-reader-tts-index', '0');
  await expect(controls).toContainText('현재 장 연속 읽는 중');
  expect(await page.evaluate(() => speechSynthesis.speaking)).toBe(true);
});
