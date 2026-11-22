import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalReviewReading, buildPersonalBookReading } from '../src/lib/bookDetail.ts';
import { buildReadBooks, prepareReadBooks } from '../src/lib/readBooks.ts';
import { computeWeeklyReadingRollup, getReadingFileTime } from '../src/lib/readingStatisticsRollup.ts';
import { readBookReview, saveBookReview, removeBookReview } from '../src/lib/localBookReview.ts';
import { findReviewWork, indexReviewWorks, resolveReviewWork } from '../src/lib/myPageSocial.ts';

const reset = async () => { await new Promise((resolve, reject) => { const req = indexedDB.deleteDatabase('twreader-local-book-reviews'); req.onsuccess = resolve; req.onerror = () => reject(req.error); }); };
const owner = 'firebase:alice|library:local';
const other = 'firebase:bob|library:local';
const storage = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
};
const platform = (url, name = 'series') => ({ platform: name, url });
const session = (title, id) => ({ schemaVersion: 1, ownerKey: owner, syncState: 'synced', retryCount: 0, nextAttemptAt: 0, lastErrorCode: null, sessionId: id, bookId: id, deviceId: 'device', bookTitle: title, mode: 'screen', startedAtClient: Date.UTC(2026, 10, 20, 5), endedAtClient: Date.UTC(2026, 10, 20, 5) + 60000, durationMs: 60000, startProgressPercent: 0, endProgressPercent: 20, localDate: '2026-11-20', timezoneOffsetMinutes: 0, completed: false });
const meta = (titleKey, platforms) => ({ titleKey, displayTitle: titleKey, platforms });
const a = meta('a', [platform('https://example.com/a'), platform('https://example.com/shared', 'kakao')]);
const b = meta('b', [platform('https://example.com/shared', 'kakao'), platform('https://example.com/b')]);
const books = (entries) => buildReadBooks(entries.map(([name], i) => session(name, String(i))), new Map(entries));

test('published file totals replace closed local dates and preserve aliases and both progress measures', () => {
  const read = (name, date, startProgressPercent, endProgressPercent) => {
    const startedAtClient = Date.parse(date + 'T09:00:00Z');
    return { ...session(name, 'file'), sessionId: date, localDate: date, startedAtClient,
      endedAtClient: startedAtClient + 60_000, startProgressPercent, endProgressPercent };
  };
  const closed = read('old name', '2026-11-20', 10, 13);
  // The uncovered dates have an interval that joins the archived one and
  // a stationary read whose high-water mark applies only to review evidence.
  const sessions = [closed, read('old name', '2026-11-12', 8, 11), read('new name', '2026-11-23', 70, 70)];
  const archived = { firstDay: '2026-11-16', lastDay: '2026-11-22',
    files: computeWeeklyReadingRollup([closed], '2026-11-16').files };
  const metadataByTitle = new Map([['old name', a], ['new name', b]]);
  const [book] = prepareReadBooks(sessions, archived)(metadataByTitle);
  assert.deepEqual(book.fileIds, ['file']);
  assert.equal(book.totalMs, 180_000);
  assert.equal(book.lastReadAt, sessions.at(-1).endedAtClient);
  assert.equal(getReadingFileTime(sessions, 'file', archived), 180_000);
  const detail = buildPersonalBookReading({
    ownerKey: owner, titleKeys: [book.id], platformWorkKeys: book.platformWorkKeys, knownFileIds: [],
    metadataByTitle, books: [], progress: {}, sessions: sessions.slice(1), hidden: new Set(), archived,
  });
  assert.deepEqual(detail.reviewFileIds, ['file']);
  assert.equal(detail.reviewHistoryPartial, false);
  assert.equal(detail.totalMs, 180_000);
  assert.equal(detail.progressPercent, 13);
  assert.deepEqual(buildLocalReviewReading(sessions, owner, new Set(), ['file']),
    { totalMs: 180_000, progressPercent: 70 });
  assert.deepEqual(archived.files[0].progressIntervals, [[10, 13]]);
});

test('a published account review or deletion reopens on a read book with a different title key', () => {
  const [onDemand] = books([['원본 파일', meta('요청 제목', [platform('https://example.com/a')])]]);
  const canonical = { workId: '게시 작품', revision: 2, platformWorkKeys: onDemand.platformWorkKeys };
  const collidingTitle = { workId: onDemand.id, revision: 1 };
  const review = { ...canonical, rating: 4 };
  assert.equal(findReviewWork(indexReviewWorks([collidingTitle, review]), onDemand), review);

  const deletion = { ...canonical, revision: 3 };
  assert.equal(findReviewWork(indexReviewWorks([deletion]), onDemand), deletion);
  assert.equal(findReviewWork(indexReviewWorks([collidingTitle]), onDemand), undefined);
});

test('disjoint links and ambiguous aliases cannot select a review or deletion target', () => {
  const first = { workId: 'same', revision: 1, platformWorkKeys: ['platform-one'] };
  const second = { workId: 'canonical-two', aliases: ['same'], revision: 4, platformWorkKeys: ['platform-two'] };
  const readWork = { id: 'same', platformWorkKeys: ['platform-two'] };
  assert.deepEqual(resolveReviewWork(indexReviewWorks([first]), readWork), { entry: undefined, blocked: true });
  assert.deepEqual(resolveReviewWork(indexReviewWorks([first, second]), readWork), { entry: second, blocked: false });
  assert.deepEqual(resolveReviewWork(indexReviewWorks([first, second]), {
    ...readWork, platformWorkKeys: ['platform-one', 'platform-two'],
  }), { entry: undefined, blocked: true });
  assert.deepEqual(resolveReviewWork(indexReviewWorks([first, second]), { id: 'same' }), { entry: undefined, blocked: true });
});

test('read history keeps disjoint platform editions with the same title key separate', () => {
  const entries = [
    ['first', meta('same', [platform('https://example.com/first')])],
    ['second', meta('same', [platform('https://example.com/second')])],
  ];
  const result = books(entries);
  assert.equal(result.length, 2);
  assert.equal(new Set(result.map(({ rowKey }) => rowKey)).size, 2);
  const first = result.find(({ fileIds }) => fileIds.includes('0'));
  const second = result.find(({ fileIds }) => fileIds.includes('1'));
  assert.deepEqual(first.fileIds, ['0']);
  assert.deepEqual(second.fileIds, ['1']);
  const saved = { workId: 'same', revision: 3, platformWorkKeys: first.platformWorkKeys };
  assert.equal(findReviewWork(indexReviewWorks([saved]), first), saved);
  assert.equal(findReviewWork(indexReviewWorks([saved]), second), undefined);
  assert.deepEqual(buildReadBooks(entries.map(([name]) => ({ ...session(name, 'file'), sessionId: name })), new Map(entries)), []);
});

test('long links keep their read row and conflicting files cannot contribute detail evidence', () => {
  const url = 'https://example.com/' + 'long'.repeat(200);
  const first = meta('same', [platform(url)]);
  const second = meta('same', [platform('https://example.com/second')]);
  assert.equal(books([['first', first]])[0].totalMs, 60_000);
  const metadataByTitle = new Map([['first', first], ['second', second]]);
  const history = [
    { ...session('first', 'file'), sessionId: 'first' },
    { ...session('second', 'file'), sessionId: 'second' },
  ];
  const [book] = books([['first', first]]);
  const detail = buildPersonalBookReading({
    ownerKey: owner, titleKeys: [book.id], platformWorkKeys: book.platformWorkKeys, knownFileIds: ['file'],
    metadataByTitle, books: [], progress: {}, sessions: history, hidden: new Set(),
  });
  assert.deepEqual(detail.fileIds, []);
  assert.equal(detail.hasRead, false);
  assert.deepEqual(buildReadBooks(history, new Map([['first', first]])), []);
});

test('merged works survive hidden aliases, edits and deletion after restoration', async () => {
  await reset();
  const store = storage();
  const [joined] = books([['A', a], ['B', b]]);
  const [onlyB] = books([['B', b]]);
  assert.equal(joined.platformWorkKeys.length, 3);
  await saveBookReview(owner, joined, 3, 'first', store);
  assert.equal((await readBookReview(owner, onlyB, store)).rating, 3);
  assert.equal(await readBookReview(other, onlyB, store), null);
  await saveBookReview(owner, onlyB, 5, 'edited', store);
  assert.equal((await readBookReview(owner, joined, store)).comment, 'edited');
  await removeBookReview(owner, onlyB, store);
  assert.equal(await readBookReview(owner, joined, store), null);
});

test('legacy title records migrate across aliases and cannot resurrect after delete', async () => {
  await reset();
  const store = storage();
  const legacy = { rating: 2, comment: 'legacy', totalMs: 100, progressPercent: 10 };
  store.setItem(`reader_book_review_v1:${encodeURIComponent(owner)}:${encodeURIComponent('b')}`, JSON.stringify(legacy));
  const [joined] = books([['A', a], ['B', b]]);
  const [onlyB] = books([['B', b]]);
  assert.deepEqual(await readBookReview(owner, joined, store), legacy);
  await removeBookReview(owner, onlyB, store);
  assert.equal(await readBookReview(owner, joined, store), null);
});

test('platform identities outrank colliding titles and distinct subsets do not merge by title', async () => {
  await reset();
  const store = storage();
  const base = { id: 'same', totalMs: 10, progressPercent: 1 };
  const first = { ...base, platformWorkKeys: ['platform-one'] };
  const second = { ...base, platformWorkKeys: ['platform-two'] };
  await saveBookReview(owner, first, 1, 'one', store);
  assert.equal(await readBookReview(owner, second, store), null);
  await saveBookReview(owner, second, 5, 'two', store);
  assert.equal((await readBookReview(owner, first, store)).comment, 'one');
  assert.equal((await readBookReview(owner, second, store)).comment, 'two');
  const both = { ...base, platformWorkKeys: ['platform-two', 'platform-one'] };
  assert.equal((await readBookReview(owner, both, store)).comment, 'one');
  assert.equal((await readBookReview(owner, second, store)).comment, 'one');
});

 test('overlapping saves and v2 migration preserve independent records', async () => {
  await reset();
  const store = storage();
  const old = { rating: 2, comment: 'old', totalMs: 1, progressPercent: 1 };
  const key = `reader_book_review_v1:${encodeURIComponent(owner)}:${encodeURIComponent('@associations')}:v2`;
  store.setItem(key, JSON.stringify([{ titles: ['legacy'], platforms: [], review: old }]));
  const one = { id: 'one', totalMs: 1, progressPercent: 1 };
  const two = { id: 'two', totalMs: 2, progressPercent: 2 };
  await Promise.all([saveBookReview(owner, one, 3, 'one', store), saveBookReview(owner, two, 4, 'two', store), readBookReview(owner, { id: 'legacy' }, store)]);
  assert.equal((await readBookReview(owner, one, store)).comment, 'one');
  assert.equal((await readBookReview(owner, two, store)).comment, 'two');
  assert.deepEqual(await readBookReview(owner, { id: 'legacy' }, store), old);
  await removeBookReview(owner, { id: 'legacy' }, store);
  assert.equal(await readBookReview(owner, { id: 'legacy' }, store), null);
  assert.ok(store.getItem(key));
});
