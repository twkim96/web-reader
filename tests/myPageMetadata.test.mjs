import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createDiscoveryLoader, groupDiscoveryBooks, loadBookDiscovery, parseDiscoveryIndex } from '../src/lib/bookDiscovery.ts';
import { cacheReadBookMetadata, readCachedReadBookMetadata as readCachedMatches } from '../src/lib/readBookMetadataCache.ts';
import { buildLocalReviewReading, buildPersonalBookReading, getWorkReadingTitles } from '../src/lib/bookDetail.ts';
import { platformWorkKey } from '../src/lib/readBooks.ts';
import { listLocalBookReviews, removeBookReview, saveBookReview } from '../src/lib/localBookReview.ts';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/readBookMetadata.ts')
      && ['firebase/firestore', './publicBookMetadata'].includes(specifier)) {
      return {
        url: new URL('./fixtures/readBookMetadataDocuments.cjs', import.meta.url).href,
        format: 'commonjs',
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { createReadMetadataLoader, loadReadBookMetadata } = await import('../src/lib/readBookMetadata.ts');
const readCachedReadBookMetadata = async (owner, titles) => (
  new Map([...(await readCachedMatches(owner, titles))].map(([title, match]) => [title, match.metadata]))
);
test.after(() => hooks.deregister());

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

test('persisted metadata isolates accounts, expires misses, and keeps a newer match over a late lookup', async (t) => {
  const start = Date.UTC(2026, 10, 21, 1);
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const owner = 'firebase:metadata-cache|library:local';
  const other = 'firebase:metadata-other|library:local';
  const title = '로컬 파일 이름.txt';
  const miss = '미게시 도서';
  const metadata = {
    schemaVersion: 1, titleKey: 'published-book', displayTitle: '게시된 도서',
    normalizerVersion: '1.3.3', publishedAt: new Date(start).toISOString(), platforms: [],
  };
  const lookups = [title, miss, '조회 실패'];
  const read = () => readCachedReadBookMetadata(owner, lookups);
  const roundTrip = new Map([[title, { metadata, observedAt: start }], [miss, { metadata: null, observedAt: start }]]);
  await cacheReadBookMetadata(owner, roundTrip);
  const earlier = { ...metadata, titleKey: 'old-book' };
  await cacheReadBookMetadata(owner, new Map([[title, { metadata: earlier, observedAt: start - 1 }]]));
  assert.deepEqual(await read(), new Map([[title, metadata], [miss, null]]));
  assert.deepEqual(await readCachedReadBookMetadata(other, lookups), new Map());
  await cacheReadBookMetadata(other, new Map([[title, { metadata: earlier, observedAt: start }]]));
  assert.deepEqual(await readCachedReadBookMetadata(other, lookups), new Map([[title, earlier]]));

  t.mock.timers.tick(5 * 60 * 1000);
  assert.deepEqual(await read(), new Map([[title, metadata]]));
  t.mock.timers.tick(55 * 60 * 1000);
  assert.deepEqual(await read(), new Map());
});

test('a large read history only fetches cache records with matching unexpired keys', async (t) => {
  const now = Date.UTC(2026, 10, 21, 1);
  t.mock.timers.enable({ apis: ['Date'], now });
  const owner = 'firebase:large-reads-cache|library:local';
  const other = 'firebase:other-large-reads-cache|library:local';
  const metadata = {
    schemaVersion: 1, titleKey: 'large-history-hit', displayTitle: '캐시된 도서',
    normalizerVersion: '1.3.3', publishedAt: new Date(now).toISOString(), platforms: [],
  };
  await cacheReadBookMetadata(owner, new Map([
    ['found', { metadata, observedAt: now }],
    ['miss', { metadata: null, observedAt: now }],
    ['expired', { metadata: null, observedAt: now - 4 * 60 * 1000 }],
  ]));
  await cacheReadBookMetadata(other, new Map([['elsewhere', { metadata, observedAt: now }]]));
  t.mock.timers.tick(60 * 1000);

  const get = t.mock.method(IDBObjectStore.prototype, 'get');
  const scan = t.mock.method(IDBIndex.prototype, 'getAllKeys');
  const titles = ['found', 'miss', 'expired', 'elsewhere', ...Array.from({ length: 600 }, (_, i) => `never-cached-${i}`)];
  assert.deepEqual(await readCachedReadBookMetadata(owner, titles), new Map([['found', metadata], ['miss', null]]));
  assert.equal(scan.mock.callCount(), 1);
  assert.equal(get.mock.callCount(), 2);
});

test('an older bucket reused after a title waits in the queue cannot overwrite a newer saved match', async (t) => {
  const started = Date.UTC(2026, 10, 21, 1);
  t.mock.timers.enable({ apis: ['Date'], now: started });
  const owner = 'firebase:bucket-cache-race|library:local';
  const record = (titleKey) => ({
    schemaVersion: 1, titleKey, displayTitle: titleKey, normalizerVersion: '1.3.3',
    publishedAt: new Date(started).toISOString(), platforms: [],
  });
  const older = record('old-work');
  const current = record('new-work');
  const snapshot = (metadata, fromCache = false) => ({
    exists: () => true, metadata: { fromCache }, data: () => metadata,
  });
  let bucketReads = 0;
  let waiting = 0;
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  globalThis.readBookTestDocument = async ({ path }) => {
    if (path === 'shared-bucket') {
      bucketReads++;
      return snapshot(older);
    }
    if (path === 'offline') return snapshot(record('offline-work'), true);
    if (path === 'error') throw new Error('offline with no snapshot');
    waiting++;
    await gate;
    return snapshot(record(path));
  };
  globalThis.readBookTestTitle = async (title, read) => {
    const path = ['warm-bucket', 'queued-title'].includes(title) ? 'shared-bucket' : title;
    return (await read({ path })).data();
  };
  try {
    await loadReadBookMetadata(['warm-bucket']);
    t.mock.timers.tick(1000);
    const titles = ['first', 'second', 'third', 'fourth', 'queued-title', 'offline', 'error'];
    const pending = loadReadBookMetadata(titles, { cacheOwnerKey: owner });
    for (let attempt = 0; attempt < 30 && waiting < 4; attempt++) await delay(2);
    assert.equal(waiting, 4, 'the target title is queued behind four active reads');
    await cacheReadBookMetadata(owner, new Map([['queued-title', { metadata: current, observedAt: Date.now() }]]));
    t.mock.timers.tick(1000);
    resume();
    const result = await pending;
    assert.deepEqual(result.metadata.get('queued-title'), older);
    assert.equal(bucketReads, 1);
    assert.ok(result.failed.has('error'));

    let persisted;
    for (let attempt = 0; attempt < 30; attempt++) {
      persisted = await readCachedReadBookMetadata(owner, titles);
      if (persisted.has('fourth')) break;
      await delay(2);
    }
    assert.ok(persisted.has('fourth'), 'the delayed batch committed to the device cache');
    assert.deepEqual(persisted.get('queued-title'), current);
    assert.equal(persisted.has('offline'), false);
    assert.equal(persisted.has('error'), false);
  } finally {
    resume();
    delete globalThis.readBookTestTitle;
    delete globalThis.readBookTestDocument;
  }
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
  assert.deepEqual(direct, {
    totalMs: 120_000, progressPercent: 9, fileIds: ['private-id', 'bridge-id'],
    reviewFileIds: ['private-id', 'bridge-id'], bookmarks: [bookmark], hasRead: true,
  });
  assert.deepEqual(direct, buildPersonalBookReading({ ...reading, metadataByTitle: metadata, knownFileIds: ['private-id', 'bridge-id'] }));
});

test('a file that loses its metadata cannot give list and direct detail different review evidence', async () => {
  const ownerKey = 'firebase:missing-metadata|library:local';
  const start = Date.UTC(2026, 10, 20, 5);
  const platform = { platform: 'series', url: 'https://books.example/book' };
  const metadata = { titleKey: 'published', platforms: [platform] };
  const makeSession = (bookId, bookTitle, offset, durationMs, endProgressPercent) => ({
    schemaVersion: 1, ownerKey, sessionId: bookId, bookId, bookTitle, deviceId: 'device',
    startedAtClient: start + offset, endedAtClient: start + offset + durationMs, durationMs,
    localDate: '2026-11-20', timezoneOffsetMinutes: 0, mode: 'screen', completed: false,
    startProgressPercent: 0, endProgressPercent, syncState: 'synced',
  });
  const primary = makeSession('primary', '첫 번째 파일.epub', 0, 60_000, 20);
  const edition = makeSession('edition', '다른 판본.txt', 120_000, 120_000, 80);
  const sessions = [primary, edition];
  const hidden = new Set();
  const input = {
    ownerKey, sessions, hidden, books: [], progress: {}, titleKeys: ['published'],
    platformWorkKeys: [platformWorkKey(platform.platform, platform.url)],
  };
  const load = createReadMetadataLoader(async (title) => title === primary.bookTitle ? metadata : null);
  const missing = await load(sessions.map(({ bookTitle }) => bookTitle));
  assert.equal(missing.failed.size, 0);
  const fromList = buildPersonalBookReading({ ...input, metadataByTitle: missing.metadata, knownFileIds: ['primary', 'edition'] });
  const direct = buildPersonalBookReading({ ...input, metadataByTitle: missing.metadata, knownFileIds: [] });
  assert.equal(fromList.totalMs, 180_000);
  assert.equal(direct.totalMs, 60_000);
  assert.equal(fromList.reviewFileIds, null);
  assert.equal(direct.reviewFileIds, null);

  const resolved = new Map(missing.metadata).set(edition.bookTitle, metadata);
  const recovered = buildPersonalBookReading({ ...input, metadataByTitle: resolved, knownFileIds: [] });
  assert.deepEqual(buildLocalReviewReading(sessions, ownerKey, hidden, recovered.reviewFileIds), {
    totalMs: 180_000, progressPercent: 80,
  });

  // A missing old name poses no problem when both records are for the
  // same file and its other name still identifies the work.
  const otherName = makeSession(edition.bookId, '다른 작품으로 연결된 이름.txt', 300_000, 60_000, 10);
  const conflict = new Map(resolved).set(otherName.bookTitle, {
    titleKey: 'another-work', platforms: [{ ...platform, url: 'https://books.example/other' }],
  });
  const ambiguous = buildPersonalBookReading({
    ...input, sessions: [...sessions, otherName], metadataByTitle: conflict, knownFileIds: ['primary', 'edition'],
  });
  assert.deepEqual(ambiguous.fileIds, ['primary']);
  assert.equal(ambiguous.reviewFileIds, null);

  const sameFile = [primary, { ...edition, bookId: primary.bookId }];
  const renamed = buildPersonalBookReading({ ...input, sessions: sameFile, metadataByTitle: missing.metadata, knownFileIds: [] });
  assert.deepEqual(buildLocalReviewReading(sameFile, ownerKey, hidden, renamed.reviewFileIds), {
    totalMs: 180_000, progressPercent: 80,
  });
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
  assert.deepEqual(buildLocalReviewReading(sessions, ownerKey, hidden, direct.reviewFileIds), { totalMs: 60_000, progressPercent: 80 });
  assert.equal(buildLocalReviewReading(sessions, ownerKey, new Set([session.sessionId]), direct.fileIds), null);
});
