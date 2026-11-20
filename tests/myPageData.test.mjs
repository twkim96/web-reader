import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readWishlist, setWishlistSaved } from '../src/lib/localWishlist.ts';
import { buildReadBooks, selectSyncedReadingSessions } from '../src/lib/readBooks.ts';
import { readBookReview, removeBookReview, saveBookReview } from '../src/lib/localBookReview.ts';
import { buildPersonalBookReading } from '../src/lib/bookDetail.ts';
import { parsePublicBookReview } from '../src/lib/publicBookReviews.ts';

const ownerA = 'firebase:alice|library:local';
const ownerB = 'firebase:bob|library:local';
const book = { id: 'book', title: '책', coverUrl: null, platforms: [], genre: null, tags: [], popularity: null, sourceCount: null };
class MockStorage {
  data = new Map();
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, value); }
  removeItem(key) { this.data.delete(key); }
}
test('wishlist persists separately per owner and book, and applies the stated add or remove action', () => {
  const storage = new MockStorage();
  setWishlistSaved(ownerA, book, true, storage);
  setWishlistSaved(ownerA, { ...book, id: 'other' }, true, storage);
  setWishlistSaved(ownerB, book, true, storage);
  assert.equal(readWishlist(ownerA, storage).length, 2);
  assert.equal(readWishlist(ownerB, storage).length, 1);
  setWishlistSaved(ownerA, book, true, storage);
  assert.equal(readWishlist(ownerA, storage).length, 2);
  setWishlistSaved(ownerA, book, false, storage);
  setWishlistSaved(ownerA, book, false, storage);
  assert.deepEqual(readWishlist(ownerA, storage).map((entry) => entry.book.id), ['other']);
  assert.equal(readWishlist(ownerB, storage)[0].book.id, 'book');
  assert.throws(() => readWishlist('bad', storage), /owner/);
  storage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => setWishlistSaved(ownerA, book, true, storage), /quota/);
  assert.equal(readWishlist(ownerA, storage).length, 1);
});
const syncedSession = (sessionId, title, start, end, progress, overrides = {}) => ({
  schemaVersion: 1, ownerKey: ownerA, syncState: 'synced', retryCount: 0, nextAttemptAt: 0, lastErrorCode: null,
  sessionId, bookId: sessionId, deviceId: 'device', bookTitle: title, mode: 'screen',
  startedAtClient: start, endedAtClient: end, durationMs: end - start, startProgressPercent: 0,
  endProgressPercent: progress, timezoneOffsetMinutes: 0, localDate: '2026-11-20', completed: false,
  ...overrides,
});

test('read books use synced account history even without shelf files, merge metadata matches and count overlapping time once', () => {
  const start = Date.UTC(2026, 10, 20, 5);
  const history = [
    syncedSession('a', '삭제한 파일 1.epub', start, start + 60_000, 72),
    syncedSession('b', '다른 파일명.txt', start + 30_000, start + 90_000, 18),
    syncedSession('renamed', '이름 변경.epub', start + 90_000, start + 120_000, 25, { bookId: 'a' }),
    syncedSession('pending', '다른 파일명.txt', start + 120_000, start + 240_000, 100, { syncState: 'pending' }),
    syncedSession('other', '다른 파일명.txt', start + 240_000, start + 300_000, 100, { ownerKey: ownerB }),
    syncedSession('hidden', '다른 파일명.txt', start + 300_000, start + 360_000, 100),
    syncedSession('unmatched', '메타데이터 없음.epub', start + 360_000, start + 420_000, 100),
  ];
  const platforms = [{ platform: 'series', url: 'https://series.naver.com/novel/detail.series?productNo=1' }];
  const metadata = new Map([
    ['삭제한 파일 1.epub', { titleKey: 'canonical', displayTitle: '정식 제목', platforms }],
    ['다른 파일명.txt', { titleKey: 'requested-alias', displayTitle: '요청 당시 제목', platforms }],
  ]);
  const records = selectSyncedReadingSessions(history, ownerA, new Set(['hidden']));
  const [book, ...otherBooks] = buildReadBooks(records, metadata);
  assert.deepEqual(otherBooks, []);
  assert.equal(book.id, 'canonical');
  assert.equal(book.title, '정식 제목');
  assert.equal(book.totalMs, 120_000);
  assert.equal(book.progressPercent, 72);
  assert.equal(book.lastReadAt, start + 120_000);
  assert.deepEqual(book.fileIds, ['a', 'b']);
  assert.deepEqual(selectSyncedReadingSessions(history, 'guest:test|library:local', new Set()), []);
});

test('work details merge adjacent reading ranges, retain gaps, and omit foreign and hidden sessions', () => {
  const start = Date.UTC(2026, 10, 20, 5);
  const session = (id, from, to, minute, overrides = {}) => syncedSession(id, '작품 1권.epub',
    start + minute * 60_000, start + (minute + 1) * 60_000, to, { startProgressPercent: from, ...overrides });
  const reading = buildPersonalBookReading({
    ownerKey: ownerA, titleKeys: ['작품'], knownFileIds: ['alias-file'], books: [], progress: {},
    hidden: new Set(['hidden']),
    sessions: [
      session('first', 10, 20, 0),
      session('second', 20, 30, 1, { bookId: 'alias-file', bookTitle: '다른 파일명' }),
      session('backward', 64, 60, 2),
      session('hidden', 30, 60, 3),
      session('other-account', 30, 60, 4, { ownerKey: ownerB }),
    ],
  });
  assert.deepEqual(reading, { bookmarks: [], ranges: [[10, 30], [60, 64]], totalMs: 180_000, hasRead: true });
});

test('a public review exposes only the rating, optional comment and reading evidence', () => {
  const ratingOnly = { rating: 4, comment: '', totalMs: 60_000, progressPercent: 19 };
  assert.deepEqual(parsePublicBookReview({ ...ratingOnly, uid: 'private', bookTitle: 'private.epub', deviceId: 'private' }), ratingOnly);
  assert.equal(parsePublicBookReview({ ...ratingOnly, progressPercent: 101 }), null);
});

test('stars alone save with evidence and reviews can be edited or removed by the same account', async () => {
  await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('twreader-local-book-reviews'); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
  const storage = new MockStorage();
  const readBook = { ...book, totalMs: 300_000, progressPercent: 31.4, lastReadAt: 1 };
  await saveBookReview(ownerA, readBook, 4, '  ', storage);
  assert.deepEqual(await readBookReview(ownerA, readBook, storage), { rating: 4, comment: '', totalMs: 300_000, progressPercent: 31.4 });
  assert.equal(await readBookReview(ownerB, readBook, storage), null);
  await assert.rejects(saveBookReview(ownerA, readBook, 0, 'no rating', storage));
  await saveBookReview(ownerA, readBook, 5, '좋았어요', storage);
  assert.equal((await readBookReview(ownerA, readBook, storage)).comment, '좋았어요');
  await removeBookReview(ownerA, readBook, storage);
  assert.equal(await readBookReview(ownerA, readBook, storage), null);
});

test('a saved rating remains visible when newly matched titles join the same work', async () => {
  await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('twreader-local-book-reviews'); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
  const storage = new MockStorage();
  const oldBook = { ...book, id: 'old-title', totalMs: 60_000, progressPercent: 10 };
  const joined = { ...oldBook, id: 'canonical', equivalentTitleKeys: [oldBook.id] };
  await saveBookReview(ownerA, oldBook, 3, '같은 작품', storage);
  assert.equal((await readBookReview(ownerA, joined, storage)).rating, 3);
  await removeBookReview(ownerA, joined, storage);
  assert.equal(await readBookReview(ownerA, oldBook, storage), null);
});
