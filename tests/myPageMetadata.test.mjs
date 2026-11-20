import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscoveryLoader, groupDiscoveryBooks, loadBookDiscovery, parseDiscoveryIndex } from '../src/lib/bookDiscovery.ts';
import { createReadMetadataLoader } from '../src/lib/readBookMetadata.ts';
import { buildLocalReviewReading, buildPersonalBookReading, getWorkReadingTitles } from '../src/lib/bookDetail.ts';
import { platformWorkKey } from '../src/lib/readBooks.ts';
import { listLocalBookReviews, removeBookReview, saveBookReview } from '../src/lib/localBookReview.ts';

const index = {
  schemaVersion: 1,
  generation: 'test-index',
  genres: ['판타지'],
  tags: ['마법', '모험'],
  books: [['stable-title-key', '마법의 책', 'https://images.example/cover', [['series', 'https://books.example/1']], 0, [1, 0], 9490, 12345]],
};

test('discovery decodes saved work IDs, filters and sort fields from the public asset', () => {
  assert.deepEqual(parseDiscoveryIndex(index), [{
    id: 'stable-title-key',
    title: '마법의 책',
    coverUrl: 'https://images.example/cover',
    platforms: [{ id: 'series', label: '네이버 시리즈', url: 'https://books.example/1' }],
    genre: '판타지', tags: ['모험', '마법'], popularity: 9490, sourceCount: 12345,
  }]);
  const [, ...rest] = index.books[0];
  assert.throws(() => parseDiscoveryIndex({ ...index, books: [...index.books, ['stable-title-key', ...rest]] }), /Invalid discovery index/);
  assert.throws(() => parseDiscoveryIndex({ ...index, tags: ['마법'] }), /Invalid discovery index/);
  assert.throws(() => parseDiscoveryIndex({ ...index, schemaVersion: 2 }), /Invalid discovery index/);
  assert.throws(() => parseDiscoveryIndex({ ...index, books: [['key', 'book', null, [['series', 'http://example.com']], null, [], null, null]] }), /Invalid discovery index/);
});

test('a discovery asset is lazy, shared across callers, and retryable after a bad response', async () => {
  const retries = [];
  const load = createDiscoveryLoader(async (retry) => {
    retries.push(retry);
    return retry ? index : { unexpected: 'response' };
  });
  assert.deepEqual(retries, []);
  const first = load();
  assert.equal(load(), first);
  await assert.rejects(first, /Invalid discovery index/);
  const recovered = await load();
  assert.equal(recovered[0].id, 'stable-title-key');
  assert.equal(await load(), recovered);
  assert.deepEqual(retries, [false, true]);
});

test('the protected preview can load its same-origin discovery catalog after sign-in', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/catalog/discovery.v1.json');
    return options.credentials === 'same-origin'
      ? Response.json(index)
      : new Response('Vercel Authentication', { status: 401 });
  });
  assert.equal((await loadBookDiscovery())[0].id, 'stable-title-key');
});

test('discovery joins transitive catalog aliases and retains distinct links on the same platform', () => {
  const [root, alias, bridge, independent] = parseDiscoveryIndex({
    ...index,
    books: [
      ['a', 'Canonical title', null, [['series', 'https://books.example/1']], null, [], null, null],
      ['c', 'Other edition', null, [['kakao', 'https://books.example/2'], ['series', 'https://books.example/3']], null, [], null, null],
      ['b', 'Bridge', null, [['series', 'https://books.example/1'], ['kakao', 'https://books.example/2']], null, [], null, null],
      ['z', 'Canonical title', null, [['series', 'https://books.example/4']], null, [], null, null],
    ],
  });
  const grouped = groupDiscoveryBooks([alias, root, bridge, independent]);
  assert.deepEqual(grouped.books.map(({ id }) => id), ['a', 'z']);
  const book = grouped.books[0];
  assert.equal(book.title, 'Canonical title');
  assert.equal(grouped.byId.get('b'), book);
  assert.equal(grouped.byId.get('c'), book);
  assert.deepEqual(grouped.equivalents.get('a'), ['a', 'b', 'c']);
  assert.deepEqual(book.platforms.map(({ url }) => url).sort(), [
    'https://books.example/1', 'https://books.example/2', 'https://books.example/3',
  ]);
  assert.equal(root.platforms.length, 1);
});

test('legacy review export retains recorded platform keys, title-only reviews and local originals', async () => {
  const owner = 'firebase:review-export|library:local';
  const prefix = `reader_book_review_v1:${encodeURIComponent(owner)}:`;
  const original = { rating: 2, comment: 'title-only', totalMs: 100, progressPercent: 5 };
  const initial = JSON.stringify(original);
  const entries = new Map([[prefix + 'old-title', initial], [prefix + 'deleted-title', initial]]);
  const storage = { length: entries.size, key: (index) => [...entries.keys()][index], getItem: (key) => entries.get(key) ?? null };
  const platformWorkKeys = [platformWorkKey('series', 'https://books.example/1'), platformWorkKey('kakao', 'https://books.example/2')];
  const review = await saveBookReview(owner, {
    id: 'maybe-colliding-title', equivalentTitleKeys: ['an-alias'], platformWorkKeys, totalMs: 100, progressPercent: 5,
  }, 4, 'identified', storage);
  await removeBookReview(owner, { id: 'deleted-title' }, storage);
  const expected = [
    { workIds: ['an-alias', 'maybe-colliding-title'], platformWorkKeys: [...platformWorkKeys].sort(), review },
    { workIds: ['old-title'], platformWorkKeys: [], review: original },
  ];
  assert.deepEqual(await listLocalBookReviews(owner, storage), expected);
  assert.deepEqual(await listLocalBookReviews(owner, storage), expected);
  assert.deepEqual([...entries.values()], [initial, initial]);
});

test('metadata publishes successful titles despite failures and retries only failed titles', async () => {
  const calls = [];
  const load = createReadMetadataLoader(async (title) => {
    calls.push(title);
    if (title === 'bad' && calls.filter((name) => name === title).length === 1) throw Error('offline');
    return { titleKey: title };
  });
  const updates = [];
  const result = await load(['good', 'bad', 'other'], { onProgress: ({ metadata, failed }) => updates.push([metadata.size, failed.size]) });
  assert.deepEqual([...result.metadata.keys()].sort(), ['good', 'other']);
  assert.deepEqual([...result.failed], ['bad']);
  assert.ok(updates.some(([count]) => count > 0));
  const retry = await load([...result.failed]);
  assert.equal(retry.metadata.get('bad').titleKey, 'bad');
  assert.deepEqual(calls.sort(), ['bad', 'bad', 'good', 'other']);
});

test('cleanup cancels unstarted titles and suppresses late updates', async () => {
  const started = [];
  const releases = [];
  const load = createReadMetadataLoader((title) => new Promise((resolve) => { started.push(title); releases.push(resolve); }));
  const controller = new AbortController();
  let updates = 0;
  const pending = load(Array.from({ length: 20 }, (_, i) => String(i)), { signal: controller.signal, onProgress: () => updates++ });
  assert.equal(started.length, 4);
  controller.abort();
  releases.forEach((resolve) => resolve(null));
  await pending;
  assert.equal(started.length, 4);
  assert.equal(updates, 0);
});

test('a direct detail lookup resolves transitive published aliases and keeps local bookmarks with a newer position', async () => {
  const ownerKey = 'firebase:detail-alias|library:local';
  const start = Date.UTC(2026, 10, 20, 5);
  const series = { platform: 'series', url: 'https://books.example/book' };
  const kakao = { platform: 'kakao', url: 'https://example.net/book' };
  const bookTitle = '완전히 다른 이름.epub';
  const bridgeName = '다른 판본.txt';
  const bookmark = { id: 'saved-bookmark', name: '보존할 책갈피', type: 'manual', createdAt: start };
  const lookup = createReadMetadataLoader(async (title) => ({
    [bookTitle]: { titleKey: 'other-key', platforms: [kakao] },
    [bridgeName]: { titleKey: 'bridge-key', platforms: [series, kakao] },
  }[title] ?? null));
  const makeSession = (bookId, title, first) => ({
    schemaVersion: 1, ownerKey, sessionId: bookId, bookId, bookTitle: title, deviceId: 'device',
    startedAtClient: first, endedAtClient: first + 60_000, durationMs: 60_000, localDate: '2026-11-20',
    timezoneOffsetMinutes: 0, mode: 'screen', completed: false, startProgressPercent: 4, endProgressPercent: 9,
  });
  const reading = {
    ownerKey, books: [], hidden: new Set(),
    sessions: [makeSession('private-id', bookTitle, start), makeSession('bridge-id', bridgeName, start + 120_000)],
    progress: { 'private-id': { syncRevision: 2, progressPercent: 50 } },
    bookmarkProgress: { 'private-id': { syncRevision: 1, progressPercent: 9, bookmarks: [bookmark] } },
    titleKeys: ['published-title'], platformWorkKeys: [platformWorkKey(series.platform, series.url)],
  };
  const { metadata } = await lookup(getWorkReadingTitles(reading));
  const direct = buildPersonalBookReading({ ...reading, metadataByTitle: metadata, knownFileIds: [] });
  assert.deepEqual(direct, { totalMs: 120_000, progressPercent: 9, fileIds: ['private-id', 'bridge-id'], bookmarks: [bookmark], hasRead: true });
  assert.deepEqual(direct, buildPersonalBookReading({ ...reading, metadataByTitle: metadata, knownFileIds: ['private-id', 'bridge-id'] }));
});

test('review evidence uses the highest synced progress even below the detail display threshold', () => {
  const ownerKey = 'firebase:review-progress|library:local';
  const start = Date.UTC(2026, 10, 20, 5);
  const session = {
    schemaVersion: 1, ownerKey, sessionId: '1', bookId: 'edition', bookTitle: 'title', deviceId: 'device',
    startedAtClient: start, endedAtClient: start + 60_000, durationMs: 60_000, localDate: '2026-11-20',
    timezoneOffsetMinutes: 0, mode: 'screen', completed: false, startProgressPercent: 79, endProgressPercent: 80,
    syncState: 'synced',
  };
  const sessions = [session, { ...session, sessionId: '2', syncState: 'pending', endProgressPercent: 99 }];
  const hidden = new Set();
  const direct = buildPersonalBookReading({
    ownerKey, books: [], hidden, sessions: [session], progress: {}, knownFileIds: [], titleKeys: ['title'],
  });
  assert.equal(direct.progressPercent, 0);
  assert.deepEqual(buildLocalReviewReading(sessions, ownerKey, hidden, direct.fileIds), { totalMs: 60_000, progressPercent: 80 });
  assert.equal(buildLocalReviewReading(sessions, ownerKey, new Set([session.sessionId]), direct.fileIds), null);
});
