import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const { loadBookFromLocalV5, loadBookMetadataFromLocalV5 } = await import('../src/lib/localDBV5.ts');
const { loadBookCoverFromLocalV14 } = await import('../src/lib/bookCoverCache.ts');
const { DEVICE_CONTENT_OWNER_KEY } = await import('../src/lib/ownerIdentity.ts');
const {
  createSampleBookPackage,
  installSampleBook,
  installSampleBooks,
  SAMPLE_BOOK_ID,
  SAMPLE_BOOK_TITLE,
  SAMPLE_BOOK_VARIANTS,
} = await import('../src/lib/sampleBook.ts');

test.after(async () => {
  await closeLocalDB();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

test('builds a readable local EPUB with cover and public-domain metadata', async () => {
  const { book, content, cover } = await createSampleBookPackage();
  const zip = await JSZip.loadAsync(await content.arrayBuffer());
  const opf = await zip.file('OEBPS/content.opf').async('string');
  const nav = await zip.file('OEBPS/nav.xhtml').async('string');
  const style = await zip.file('OEBPS/style.css').async('string');
  const story = await zip.file('OEBPS/challenge.xhtml').async('string');
  const about = await zip.file('OEBPS/about.xhtml').async('string');

  assert.equal(book.id, SAMPLE_BOOK_ID);
  assert.equal(book.name.startsWith(SAMPLE_BOOK_TITLE), true);
  assert.equal(book.source, 'local');
  assert.equal(book.sourceFormat, 'epub');
  assert.equal(book.readerFormat, 'epub');
  assert.equal(book.size, content.size);
  assert.equal(cover.type, 'image/svg+xml');
  assert.match(await cover.text(), /토끼와 거북이 표지/);
  assert.equal(await zip.file('mimetype').async('string'), 'application/epub+zip');
  assert.match(opf, /<dc:title>토끼와 거북이<\/dc:title>/);
  assert.match(opf, /<dc:creator id="creator">이솝 \(Aesop\)<\/dc:creator>/);
  assert.match(opf, /<dc:language>ko<\/dc:language>/);
  assert.match(opf, /<dc:description>[^<]+<\/dc:description>/);
  assert.match(opf, /<dc:rights>Public domain source;[^<]+CC0\.<\/dc:rights>/);
  assert.match(opf, /properties="cover-image"/);
  assert.match(nav, /1\. 뜻밖의 경주/);
  assert.match(nav, /샘플 도서 안내/);
  assert.match(style, /word-break:normal/);
  assert.match(style, /line-break:strict/);
  assert.doesNotMatch(style, /word-break:keep-all/);
  assert.doesNotMatch(style, /text-align:justify/);
  assert.match(story, /숲 가장자리의 넓은 풀밭/);
  assert.match(about, /원문 번역을 복제하지 않고 새로 제작/);

  for (const chapterId of ['challenge', 'road', 'finish', 'lesson']) {
    const chapter = await zip.file(`OEBPS/${chapterId}.xhtml`).async('string');
    const paragraphCount = chapter.match(/<p>/g)?.length ?? 0;
    const plainText = chapter.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const paragraphs = [...chapter.matchAll(/<p>(.*?)<\/p>/g)].map((match) => match[1]);
    assert.ok(paragraphCount >= 20, `${chapterId} should have at least 20 paragraphs`);
    assert.ok(plainText.length >= 1_000, `${chapterId} should exceed 1,000 characters`);
    assert.equal(
      paragraphs.some((paragraph) => /(?:\s|&nbsp;){2,}/.test(paragraph)),
      false,
      `${chapterId} should not contain repeated spaces`,
    );
  }
});

test('installs one stable sample book and its cover in the device-local namespace', async () => {
  const first = await installSampleBook();
  const second = await installSampleBook();
  const metadata = await loadBookMetadataFromLocalV5(DEVICE_CONTENT_OWNER_KEY, SAMPLE_BOOK_ID);
  const content = await loadBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, SAMPLE_BOOK_ID);
  const cover = await loadBookCoverFromLocalV14(DEVICE_CONTENT_OWNER_KEY, first);

  assert.equal(first.id, second.id);
  assert.equal(metadata?.id, SAMPLE_BOOK_ID);
  assert.ok(content instanceof Blob);
  assert.ok(content.size > 0);
  assert.equal(cover?.type, 'image/svg+xml');
});

test('builds and installs eight stable sample variants with distinct cover themes', async () => {
  const samples = await Promise.all(SAMPLE_BOOK_VARIANTS.map((variant) => createSampleBookPackage(variant)));
  const coverSvgs = await Promise.all(samples.map(({ cover }) => cover.text()));
  const installed = await installSampleBooks();
  const installedAgain = await installSampleBooks();

  assert.equal(SAMPLE_BOOK_VARIANTS.length, 8);
  assert.equal(new Set(samples.map(({ book }) => book.id)).size, 8);
  assert.equal(new Set(samples.map(({ book }) => book.name)).size, 8);
  assert.equal(new Set(coverSvgs).size, 8);
  assert.equal(installed.length, 8);
  assert.deepEqual(installedAgain.map(({ id }) => id), installed.map(({ id }) => id));

  for (const [index, book] of installed.entries()) {
    const variant = SAMPLE_BOOK_VARIANTS[index];
    const metadata = await loadBookMetadataFromLocalV5(DEVICE_CONTENT_OWNER_KEY, variant.id);
    const content = await loadBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, variant.id);
    const cover = await loadBookCoverFromLocalV14(DEVICE_CONTENT_OWNER_KEY, book);
    assert.equal(metadata?.name, variant.fileName);
    assert.ok(content instanceof Blob);
    assert.ok(content.size > 0);
    assert.equal(cover?.type, 'image/svg+xml');
  }
});
