import { expect, test } from '@playwright/test';

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

test('caches a PDF cover only at import and falls back after that cache is removed', async ({
  browserName,
  page,
}) => {
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit cannot persist an input-backed File Blob to IndexedDB.',
  );
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('web_reader_guest_install_id', 'cover-cache-e2e');
    localStorage.setItem('neverShowInstallPrompt', 'true');
    localStorage.setItem('shelf_viewMode', 'grid');
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Guest Library', exact: true })).toBeVisible();

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
    bookId = await page.evaluate(async () => {
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
      const book = metadata.find(({ name }) => name === 'cover-cache-proof.pdf');
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
    });
    return bookId;
  }, { timeout: 30_000 }).not.toBeNull();
  if (!bookId) throw new Error('PDF cover cache was not created.');

  const card = page.locator(`[data-shelf-book-id="${bookId}"]`);
  await expect(card.locator('[data-shelf-book-cover="true"]')).toBeVisible();
  await expect(card.locator('[data-shelf-book-icon="true"]')).toHaveCount(0);

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
  await expect(fallbackCard.locator('[data-shelf-book-icon="true"]')).toBeVisible();
});
