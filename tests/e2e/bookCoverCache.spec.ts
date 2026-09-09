import { expect, test, type Page } from './fixtures';
import JSZip from 'jszip';

const createPdf = () => {
  const stream = 'BT /F1 24 Tf 72 720 Td (Cached Cover) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets[index + 1] = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
};

const createCbz = async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const zip = new JSZip();
  zip.file('pages/10.png', png);
  zip.file('pages/1.png', png);
  return await zip.generateAsync({ type: 'nodebuffer' });
};

const setupGuestShelf = async (page: Page, installId: string) => {
  await page.goto('/');
  await page.evaluate((id) => {
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('web_reader_guest_install_id', id);
    localStorage.setItem('neverShowInstallPrompt', 'true');
    localStorage.setItem('shelf_viewMode_v2', 'grid');
  }, installId);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Guest Library', exact: true })).toBeVisible();
};

const findCachedCoverBookId = async (page: Page, bookName: string) => (
  page.evaluate(async (targetName) => {
    const request = indexedDB.open('web-reader-db');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['metadata-v5', 'book-covers-v14'], 'readonly');
    const metadataRequest = tx.objectStore('metadata-v5').getAll();
    const metadata = await new Promise<Array<{ id: string; name: string }>>((resolve, reject) => {
      metadataRequest.onsuccess = () => resolve(metadataRequest.result);
      metadataRequest.onerror = () => reject(metadataRequest.error);
    });
    const book = metadata.find(({ name }) => name === targetName);
    if (!book) {
      db.close();
      return null;
    }
    const coverRequest = tx.objectStore('book-covers-v14').get([
      'guest:device-library|library:local',
      book.id,
    ]);
    const cover = await new Promise<{ image?: Blob } | undefined>((resolve, reject) => {
      coverRequest.onsuccess = () => resolve(coverRequest.result);
      coverRequest.onerror = () => reject(coverRequest.error);
    });
    db.close();
    return cover?.image instanceof Blob
      && cover.image.size > 0
      && /^image\/(?:webp|jpeg)$/.test(cover.image.type)
      ? book.id
      : null;
  }, bookName)
);

test('caches a PDF cover only at import and falls back after that cache is removed', async ({
  browserName,
  page,
}) => {
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit cannot persist an input-backed File Blob to IndexedDB.',
  );
  await page.addInitScript(() => {
    Reflect.deleteProperty(Map.prototype, 'getOrInsertComputed');
    Reflect.deleteProperty(WeakMap.prototype, 'getOrInsertComputed');
    const mainMissing = !('getOrInsertComputed' in Map.prototype)
      && !('getOrInsertComputed' in WeakMap.prototype);
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.dataset.pdfCompatMainMissing = String(mainMissing);
    });
  });
  const workerProbes: string[] = [];
  const pdfWorkers: string[] = [];
  page.on('worker', (worker) => {
    if (new URL(worker.url()).pathname === '/foliate-js/pdf-worker.js') {
      pdfWorkers.push(worker.url());
    }
  });
  await page.context().route('**/__pdf-compat-worker-probe?*', async (route) => {
    workerProbes.push(new URL(route.request().url()).searchParams.get('missing') ?? '');
    await route.fulfill({ status: 204, body: '' });
  });
  await page.context().route('**/foliate-js/pdf-worker.js*', async (route) => {
    const entryUrl = new URL(route.request().url());
    if (entryUrl.searchParams.has('compat-test-original')) {
      await route.continue();
      return;
    }
    entryUrl.searchParams.set('compat-test-original', '1');
    await route.fulfill({
      contentType: 'text/javascript',
      body: `
        delete Map.prototype.getOrInsertComputed;
        delete WeakMap.prototype.getOrInsertComputed;
        const missing = !('getOrInsertComputed' in Map.prototype)
          && !('getOrInsertComputed' in WeakMap.prototype);
        await fetch('/__pdf-compat-worker-probe?missing=' + missing);
        await import(${JSON.stringify(entryUrl.href)});
      `,
    });
  });
  await setupGuestShelf(page, 'cover-cache-e2e');
  await expect(page.locator('html')).toHaveAttribute('data-pdf-compat-main-missing', 'true');

  await page.locator('button[title="Add Local Book"]:visible').first().click();
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: 'cover-cache-proof.pdf',
    mimeType: 'application/pdf',
    buffer: createPdf(),
  });
  await page.getByRole('button', { name: '추가', exact: true }).click();

  let bookId: string | null = null;
  await expect.poll(async () => {
    bookId = await findCachedCoverBookId(page, 'cover-cache-proof.pdf');
    return bookId;
  }, { timeout: 30_000 }).not.toBeNull();
  if (!bookId) throw new Error('PDF cover cache was not created.');
  expect(pdfWorkers.length, 'real PDF worker started').toBeGreaterThan(0);
  expect(workerProbes.length, 'PDF worker compatibility preflight ran').toBeGreaterThan(0);
  expect(workerProbes.every((missing) => missing === 'true')).toBe(true);

  const card = page.locator(`[data-shelf-book-id="${bookId}"]`);
  await expect(card.locator('[data-shelf-book-cover="true"]')).toBeVisible();
  await expect(card.locator('[data-shelf-book-icon="true"]')).toHaveCount(0);
  await expect(card.locator('[data-shelf-grid-cover-layout="true"]')).toBeVisible();

  await card.click({ button: 'right' });
  const bookInfoModal = page.locator('[data-book-info-modal="true"]');
  await expect(bookInfoModal.locator('[data-book-info-cover="true"]')).toBeVisible();
  await bookInfoModal.getByRole('button', { name: '도서 정보 닫기' }).click();

  await page.locator('button[title="Switch to List View"]:visible').first().click();
  await expect(card.locator('[data-shelf-book-cover="true"]')).toBeVisible();

  await page.evaluate(async (targetBookId) => {
    const request = indexedDB.open('web-reader-db');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('book-covers-v14', 'readwrite');
    tx.objectStore('book-covers-v14').delete([
      'guest:device-library|library:local',
      targetBookId,
    ]);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, bookId);

  await page.reload();
  const fallbackCard = page.locator(`[data-shelf-book-id="${bookId}"]`);
  await expect(fallbackCard.locator('[data-shelf-book-cover="true"]')).toHaveCount(0);
  await expect(fallbackCard.locator('[data-generated-book-cover="true"]')).toBeVisible();
  await expect(fallbackCard.locator('[data-shelf-book-icon="true"]')).toHaveCount(0);
});

test('uses the naturally sorted first CBZ image as the cached shelf cover', async ({
  browserName,
  page,
}) => {
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit cannot persist an input-backed File Blob to IndexedDB.',
  );
  await setupGuestShelf(page, 'archive-cover-cache-e2e');

  await page.locator('button[title="Add Local Book"]:visible').first().click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'archive-cover-proof.cbz',
    mimeType: 'application/vnd.comicbook+zip',
    buffer: await createCbz(),
  });
  await page.getByRole('button', { name: '추가', exact: true }).click();

  let bookId: string | null = null;
  await expect.poll(async () => {
    bookId = await findCachedCoverBookId(page, 'archive-cover-proof.cbz');
    return bookId;
  }, { timeout: 30_000 }).not.toBeNull();
  if (!bookId) throw new Error('CBZ cover cache was not created.');

  const card = page.locator(`[data-shelf-book-id="${bookId}"]`);
  await expect(card.locator('[data-shelf-book-cover="true"]')).toBeVisible();
  await expect(card.locator('[data-shelf-book-icon="true"]')).toHaveCount(0);
});
