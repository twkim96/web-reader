import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Timestamp } from 'firebase-admin/firestore';
import { loadSocialCatalog, resolveLegacyReviewWork, resolveSocialWork } from '../src/server/mypage/catalog.ts';
import { getSocialReadingEvidence } from '../src/server/mypage/reading.ts';
import { platformWorkKey } from '../src/lib/readBooks.ts';
import { encodeReadingDayMember, identifyReadingDaySession, readingDayBucketFromSessionId } from '../src/lib/readingStatisticsDay.ts';
import { computeReadingFileRollups } from '../src/lib/readingStatisticsRollup.ts';

const hash = (s) => createHash('sha256').update(s).digest('hex');

test('every link in the released catalog is still available through its canonical work', async () => {
  const catalog = await loadSocialCatalog();
  const { books } = JSON.parse(await readFile(new URL('../public/catalog/discovery.v1.json', import.meta.url), 'utf8'));
  assert.ok(new Set(catalog.values()).size < books.length);
  for (const [id, , , platforms] of books) {
    const canonical = catalog.get(id);
    for (const [platform, url] of platforms) {
      assert.ok(canonical.platforms.some((link) => link.id === platform && link.url === url), `${id}: ${url}`);
    }
  }
});

test('legacy review imports require agreeing published platform identities or a unique title-only match', async () => {
  const catalog = await loadSocialCatalog();
  const [alias, first] = [...catalog].find(([id, book]) => id !== book.id);
  const second = [...catalog.values()].find((book) => book.id !== first.id);
  const firstKeys = first.platforms.map(({ id, url }) => platformWorkKey(id, url));
  const secondKey = platformWorkKey(second.platforms[0].id, second.platforms[0].url);
  const unknownKey = platformWorkKey('series', 'https://unpublished.example/123');
  const db = { collection() { throw new Error('Published platform and title IDs should never query private metadata'); } };

  const supported = await resolveLegacyReviewWork(db, [second.id], firstKeys);
  assert.equal(supported.book.id, first.id);
  assert.ok(supported.equivalentWorkIds.includes(alias));
  assert.equal(await resolveLegacyReviewWork(db, [first.id], [firstKeys[0], secondKey]), null);
  assert.equal(await resolveLegacyReviewWork(db, [first.id], [firstKeys[0], unknownKey]), null);
  assert.equal(await resolveLegacyReviewWork(db, [first.id], [unknownKey]), null);
  assert.equal(await resolveLegacyReviewWork(db, [first.id, second.id], []), null);
  assert.equal((await resolveLegacyReviewWork(db, [first.id, alias], [])).book.id, first.id);

  const collisionId = hash('unpublishedcollision');
  const collision = {
    schemaVersion: 1, titleKey: first.id, displayTitle: first.title, normalizerVersion: 'v1', publishedAt: '2026-01-01',
    platforms: [{
      platform: second.platforms[0].id, label: second.platforms[0].label, title: second.title, url: second.platforms[0].url,
      coverUrl: null, downloadCount: null, interestCount: null, viewCount: null, recommendCount: null, rating: null, ratingCount: null, lastSuccessAt: '2026-01-01',
    }],
  };
  const withCollision = { collection: () => ({ doc: () => ({ get: async () => ({
    exists: true, data: () => ({ schemaVersion: 1, entries: { [collisionId]: collision } }),
  }) }) }) };
  assert.equal(await resolveLegacyReviewWork(withCollision, [first.id, 'unpublishedcollision'], []), null);
});

test('explicit social work links require one published root even when the title matches', async () => {
  const catalog = await loadSocialCatalog();
  const first = catalog.values().next().value;
  const second = [...catalog.values()].find((book) => book.id !== first.id);
  const firstKey = platformWorkKey(first.platforms[0].id, first.platforms[0].url);
  const secondKey = platformWorkKey(second.platforms[0].id, second.platforms[0].url);
  const unknownKey = platformWorkKey('series', 'https://unpublished.example/123');
  const db = { collection() { throw new Error('Unexpected metadata lookup'); } };
  assert.equal(await resolveSocialWork(db, first.id, [unknownKey]), null);
  assert.equal((await resolveSocialWork(db, first.id, [firstKey, unknownKey])).book.id, first.id);
  assert.equal(await resolveSocialWork(db, first.id, [firstKey, secondKey]), null);
  assert.equal((await resolveSocialWork(db, first.id, [])).book.id, first.id);
});

function fixtureStats(readRows, onFullScan = () => {}, readTime = () => Timestamp.now()) {
  const value = (row, field) => typeof field === 'string' ? row.get?.(field) ?? row.data()[field] : row.id;
  const compare = (left, right) => Buffer.compare(Buffer.from(left.valueOf()), Buffer.from(right.valueOf()));
  const inequalities = {
    '>': (left, right) => left > right,
    '>=': (left, right) => left >= right,
    '<=': (left, right) => left <= right,
  };
  const makeQuery = () => {
    const ordering = [];
    const filters = [];
    let after;
    let through;
    let pageSize;
    let projection = false;
    const tuple = (row) => ordering.map(({ field }) => value(row, field));
    const compareTuples = (left, right) => {
      for (const [index, item] of right.entries()) {
        const order = compare(left[index], item);
        if (order) return ordering[index].direction === 'desc' ? -order : order;
      }
      return 0;
    };
    const query = {
      orderBy: (field, direction) => { ordering.push({ field, direction }); return query; },
      where: (field, operator, stamp) => {
        filters.push((row) => inequalities[operator](value(row, field), stamp));
        return query;
      },
      select: () => { projection = true; return query; },
      limit: (size) => { pageSize = size; return query; },
      startAfter: (...values) => { after = values[0]?.data ? tuple(values[0]) : values; return query; },
      endAt: (...values) => { through = values; return query; },
      get: async () => {
        if (!projection && typeof ordering[0]?.field !== 'string') onFullScan();
        const docs = readRows()
          .filter((row) => tuple(row).every((item) => item !== undefined) && filters.every((filter) => filter(row)))
          .sort((left, right) => compareTuples(tuple(left), tuple(right)))
          .filter((row) => (!after || compareTuples(tuple(row), after) > 0) && (!through || compareTuples(tuple(row), through) <= 0))
          .slice(0, pageSize);
        return { docs, size: docs.length, empty: docs.length === 0, readTime: readTime() };
      },
    };
    return query;
  };
  return {
    count: () => ({ get: async () => ({ data: () => ({ count: readRows().length }) }) }),
    orderBy: (...args) => makeQuery().orderBy(...args),
    select: () => makeQuery().select(),
    where: (...args) => makeQuery().where(...args),
  };
}

const readFixtureTransaction = (callback) => callback({ get: (query) => query.get() });
const emptyDayStats = fixtureStats(() => []);

function makeReadingSession(bookId, bookTitle, sessionId, start, progress) {
  return {
    schemaVersion: 1, sessionId, bookId, bookTitle, deviceId: 'device', mode: 'screen',
    startedAtClient: start, endedAtClient: start + 2000, durationMs: 2000,
    startProgressPercent: 0, endProgressPercent: progress, timezoneOffsetMinutes: 0,
    localDate: new Date(start).toISOString().slice(0, 10), completed: false,
  };
}

const fixtureLegacyRow = (session, uploadedAtServer) => ({
  id: session.sessionId,
  get: (field) => field === 'uploadedAtServer' ? uploadedAtServer : session[field],
  data: () => ({ ...session, uploadedAtServer }),
});

function fixtureDayPart(part, entries) {
  const first = entries[0];
  const bucket = readingDayBucketFromSessionId(first.session.sessionId);
  const members = {};
  let bytes = 0;
  for (const { session, firstReceivedAt } of entries) {
    const encoded = encodeReadingDayMember(session);
    members[session.sessionId] = { payload: encoded.payload, firstReceivedAt };
    bytes += encoded.bytes;
  }
  return {
    id: `${bucket}_${part}`,
    data: () => ({
      containerVersion: 2, bucket, part, hasNext: false, deviceId: first.session.deviceId, capturedDay: first.session.localDate,
      firstReceivedAt: first.firstReceivedAt, lastReceivedAt: entries.at(-1).firstReceivedAt,
      memberCount: entries.length, members, bytes, intervals: 0,
    }),
  };
}

test('published rating evidence joins the complete receipt window across both sources', async (t) => {
  const previous = process.env.NEXT_PUBLIC_ENABLE_READING_STATS_ROLLUP_READS;
  process.env.NEXT_PUBLIC_ENABLE_READING_STATS_ROLLUP_READS = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_ENABLE_READING_STATS_ROLLUP_READS;
    else process.env.NEXT_PUBLIC_ENABLE_READING_STATS_ROLLUP_READS = previous;
  });
  const book = (await loadSocialCatalog()).values().next().value;
  const start = Date.parse('2025-12-17T09:00:00Z');
  const sourceThrough = Timestamp.fromMillis(start + 100_000);
  const later = new Timestamp(sourceThrough.seconds, 1);
  const readTime = new Timestamp(sourceThrough.seconds, 2);
  const future = new Timestamp(sourceThrough.seconds, 3);
  const legacy = (id, index, progress) => makeReadingSession('file', book.id, id, start + index * 4000, progress);
  const day = (index, progress) => identifyReadingDaySession(legacy(
    `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, index, progress,
  ));
  const carry = await day(0, 20);
  const open = await day(41, 80);
  const beyondReadTime = await day(42, 99);
  const days = [
    fixtureDayPart(0, [
      { session: carry, firstReceivedAt: sourceThrough },
      { session: open, firstReceivedAt: readTime },
      { session: beyondReadTime, firstReceivedAt: future },
    ]),
    fixtureDayPart(1, [{ session: open, firstReceivedAt: readTime }]),
  ];
  const legacyRows = [
    ...Array.from({ length: 40 }, (_, index) => fixtureLegacyRow(legacy(`tail-${index}`, index + 1, 50), later)),
    fixtureLegacyRow(legacy('future', 43, 100), future),
  ];
  const closed = makeReadingSession('file', book.id, 'closed', Date.parse('2025-12-10T09:00:00Z'), 10);
  const manifest = {
    schemaVersion: 1, firstWeek: '2025-10-06', publishedThroughWeek: '2025-12-08', lastCalendarWeek: '2025-12-08',
    coversHistoryStart: true, sourceThrough,
  };
  const payload = JSON.stringify({ files: computeReadingFileRollups([closed]), carry: { sessions: [carry], sampleFloor: 0 } });
  const stats = fixtureStats(() => legacyRows, undefined, () => readTime);
  const dayStats = fixtureStats(() => days, undefined, () => readTime);
  const db = {
    collection: (path) => path.endsWith('readingStatsDaysV2') ? dayStats : stats,
    doc: () => ({ collection: (name) => ({ doc: () => ({
      get: async () => name === 'readingStatsRollupManifestsV1' ? { data: () => manifest } : {
        readTime,
        get: (field) => field === 'throughWeek' ? manifest.publishedThroughWeek : payload,
      },
    }) }) }),
    runTransaction(callback, options) {
      assert.deepEqual(options, { readOnly: true, readTime });
      return readFixtureTransaction(callback);
    },
  };
  assert.deepEqual(await getSocialReadingEvidence(db, 'published', book.id, ['file']), {
    totalMs: 43 * 2000, progressPercent: 80,
  });

  legacyRows.push(...Array.from({ length: 1_200 }, (_, index) => fixtureLegacyRow(legacy(`extra-${index}`, index, 90), later)));
  assert.deepEqual(await getSocialReadingEvidence(db, 'over-budget', book.id, ['file']), {
    totalMs: null, progressPercent: null,
  });
});

test('fallback evidence sees a new day part with an unchanged legacy cache marker', async (t) => {
  const book = (await loadSocialCatalog()).values().next().value;
  const legacy = makeReadingSession('file', book.id, 'legacy', 1000, 10);
  const day = await identifyReadingDaySession(makeReadingSession(
    'file', book.id, '00000000-0000-4000-8000-000000000001', 5000, 70,
  ));
  const stamp = Timestamp.fromMillis(10_000);
  const stats = fixtureStats(() => [fixtureLegacyRow(legacy, stamp)]);
  const days = [];
  const dayStats = fixtureStats(() => days);
  const db = {
    collection: (path) => path.endsWith('readingStatsDaysV2') ? dayStats : stats,
    runTransaction: readFixtureTransaction,
  };
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const evidence = () => getSocialReadingEvidence(db, 'mixed', book.id, ['file']);
  assert.deepEqual(await evidence(), { totalMs: 2000, progressPercent: 10 });

  days.push(fixtureDayPart(0, [{ session: day, firstReceivedAt: stamp }]));
  now += 31_000;
  assert.deepEqual(await evidence(), { totalMs: 4000, progressPercent: 70 });

  days.push({ id: 'invalid-part', data: () => ({}) });
  now += 31_000;
  assert.deepEqual(await evidence(), { totalMs: null, progressPercent: null });
});

function captureReadingEvidenceLogs(t) {
  const logs = [];
  const previousLogging = process.env.MY_PAGE_PERF_LOG;
  process.env.MY_PAGE_PERF_LOG = '1';
  t.after(() => {
    if (previousLogging === undefined) delete process.env.MY_PAGE_PERF_LOG;
    else process.env.MY_PAGE_PERF_LOG = previousLogging;
  });
  t.mock.method(console, 'info', (label, data) => {
    if (label === '[MyPagePerformance]' && data.route === 'reading-evidence-deferred') logs.push(data);
  });
  return logs;
}

test('reuses a verified empty history and rescans after the first server-timestamped upload', async (t) => {
  const book = (await loadSocialCatalog()).values().next().value;
  const session = {
    schemaVersion: 1, sessionId: 'session', bookId: 'file', bookTitle: book.id, deviceId: 'device',
    mode: 'screen', startedAtClient: 1000, endedAtClient: 3000, durationMs: 2000,
    startProgressPercent: 1, endProgressPercent: 10, timezoneOffsetMinutes: 0, localDate: '1970-01-01', completed: false,
  };
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const rows = [];
  let fullScans = 0;
  const db = {
    collection: (path) => path.endsWith('readingStatsDaysV2') ? emptyDayStats : fixtureStats(() => rows, () => { fullScans++; }),
    runTransaction: readFixtureTransaction,
  };
  const evidence = (uid) => getSocialReadingEvidence(db, uid, book.id, ['file']);
  const expectEvidence = { totalMs: 2000, progressPercent: 10 };

  await evidence('new-account');
  now += 31_000;
  await evidence('new-account');
  assert.equal(fullScans, 1);

  rows.push({ id: session.sessionId, get: () => new Timestamp(1, 0), data: () => session });
  now += 31_000;
  assert.deepEqual(await evidence('new-account'), expectEvidence);
  assert.equal(fullScans, 2);

  rows[0] = { ...rows[0], get: () => undefined };
  assert.deepEqual(await evidence('legacy-account'), expectEvidence);
  now += 31_000;
  assert.deepEqual(await evidence('legacy-account'), expectEvidence);
  assert.equal(fullScans, 4);
});

test('groups filename variants and reassigns a retained timeline after an alias remap', async (t) => {
  const [first, second, calibration] = [...new Set((await loadSocialCatalog()).values())];
  const aliasId = hash('neonaliassample');
  let aliasBook = first;
  const rows = [];
  const stats = fixtureStats(() => rows);
  const db = {
    collection(path) {
      if (path.endsWith('readingStatsV1')) return stats;
      if (path.endsWith('readingStatsDaysV2')) return emptyDayStats;
      return { doc(id) {
        return { get: async () => {
          if (path !== 'publicBookMetadataOnDemandV1' || id !== aliasId) return { exists: false, data: () => undefined };
          return { exists: true, data: () => ({
            schemaVersion: 1, aliasId, status: 'ready',
            platforms: aliasBook.platforms.map(({ id: platform, url }) => ({ platform, url })),
          }) };
        } };
      } };
    },
    runTransaction: readFixtureTransaction,
  };
  const add = (sessionId, bookId, bookTitle, deviceId, start, progress, stamp, clockOffsetMs) => {
    const session = {
      schemaVersion: 1, sessionId, bookId, bookTitle, deviceId, mode: 'screen',
      startedAtClient: start, endedAtClient: start + 2000, durationMs: 2000,
      startProgressPercent: 0, endProgressPercent: progress, timezoneOffsetMinutes: 0,
      completed: false,
      ...(clockOffsetMs === undefined ? {} : { clockOffsetMs, clockMeasuredAtClient: start, clockUncertaintyMs: 100 }),
    };
    rows.push({ id: sessionId, get: () => new Timestamp(stamp, 0), data: () => session });
  };
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const logs = captureReadingEvidenceLogs(t);
  const evidence = (book, file) => getSocialReadingEvidence(db, 'account', book.id, [file], 'reading-evidence-deferred');

  add('a-overlap-winner', 'second-file', second.id, 'second-device', 8000, 20, 1, -7000);
  add('b-overlap-loser', 'first-file', 'neonaliassample.txt', 'first-device', 1000, 10, 1);
  add('c-uncontested', 'first-file', 'neonaliassample.epub', 'first-device', 5000, 30, 1);
  assert.deepEqual(await evidence(first, 'first-file'), { totalMs: 4000, progressPercent: 30 });
  assert.equal(logs.at(-1).aliasResolutions, 1);

  // A sample on a different book makes the two devices comparable in server time.
  now += 31_000;
  add('d-calibration', 'third-file', calibration.id, 'first-device', 11000, 40, 1, 0);
  assert.deepEqual(await evidence(first, 'first-file'), { totalMs: 2000, progressPercent: 30 });
  assert.equal(logs.at(-1).scanDocuments, 1);
  assert.equal(logs.at(-1).timelineBuilds, 1);

  aliasBook = second;
  now += 5 * 60_000;
  assert.deepEqual(await evidence(first, 'first-file'), { totalMs: null, progressPercent: null });
  assert.equal(logs.at(-1).countQueries, 1);
  assert.equal(logs.at(-1).scanDocuments, 0);
  assert.equal(logs.at(-1).timelineBuilds, 0);
  assert.equal(logs.at(-1).aliasResolutions, 1);
  assert.deepEqual(await evidence(second, 'first-file'), { totalMs: 4000, progressPercent: 30 });
});

test('retains large-history evidence through alias rechecks and audits it on schedule', async (t) => {
  const book = (await loadSocialCatalog()).values().next().value;
  const sessions = Array.from({ length: 140 }, (_, index) => {
    const start = 1_700_000_000_000 + index * 2048;
    const activeIntervals = Array.from({ length: 512 }, (_, interval) => ({
      startedAtClient: start + interval * 2,
      endedAtClient: start + interval * 2 + 2,
    }));
    return {
      schemaVersion: 1, sessionId: String(index).padStart(3, '0'), bookId: 'file', bookTitle: book.id, deviceId: 'device',
      mode: 'tts', startedAtClient: start, endedAtClient: start + 1024, durationMs: 1024, activeIntervals,
      startProgressPercent: 0, endProgressPercent: 20, timezoneOffsetMinutes: 0, localDate: '2023-11-14', completed: false,
    };
  });
  assert.ok(sessions.reduce((bytes, session) => bytes + Buffer.byteLength(JSON.stringify(session)), 0) > 4 * 1024 * 1024);
  const stamp = new Timestamp(1, 0);
  const stats = fixtureStats(() => sessions.map((session) => ({
    id: session.sessionId, get: () => stamp, data: () => session,
  })));
  const db = {
    collection: (path) => path.endsWith('readingStatsDaysV2') ? emptyDayStats : stats,
    runTransaction: readFixtureTransaction,
  };
  const start = Date.now();
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const logs = captureReadingEvidenceLogs(t);
  const evidence = () => getSocialReadingEvidence(db, 'large-account', book.id, ['file'], 'reading-evidence-deferred');
  const expected = { totalMs: 140 * 1024, progressPercent: 20 };

  assert.deepEqual(await evidence(), expected);
  assert.equal(logs.at(-1).fullScanCold, 1);
  assert.equal(logs.at(-1).scanDocuments, 140);
  assert.equal(logs.at(-1).retainedRawBytes, 0);
  assert.ok(logs.at(-1).retainedEvidenceBytes > 0);

  now += 31_000;
  assert.deepEqual(await evidence(), expected);
  assert.equal(logs.at(-1).markerDocuments, 1);
  assert.equal(logs.at(-1).scanQueries, 0);

  for (const elapsed of [5, 29]) {
    now = start + elapsed * 60_000;
    assert.deepEqual(await evidence(), expected);
    assert.equal(logs.at(-1).countQueries, 1);
    assert.equal(logs.at(-1).scanQueries, 0);
    assert.equal(logs.at(-1).timelineBuilds, 0);
    assert.equal(logs.at(-1).evidenceReused, 1);
  }

  // A same-cursor, same-count edit is detected by the full audit.
  sessions[0].endProgressPercent = 40;
  now = start + 30 * 60_000;
  assert.deepEqual(await evidence(), { ...expected, progressPercent: 40 });
  assert.equal(logs.at(-1).fullScanAudit, 1);
  assert.equal(logs.at(-1).scanDocuments, 140);
  assert.equal(logs.at(-1).timelineBuilds, 1);

  const extra = sessions.at(-1);
  const extraStart = extra.endedAtClient + 1000;
  sessions.push({
    ...extra, sessionId: 'new', mode: 'screen', startedAtClient: extraStart, endedAtClient: extraStart + 2000,
    durationMs: 2000, activeIntervals: undefined, endProgressPercent: 50,
  });
  now += 31_000;
  assert.deepEqual(await evidence(), { totalMs: expected.totalMs + 2000, progressPercent: 50 });
  assert.equal(logs.at(-1).countQueries, 1);
  assert.equal(logs.at(-1).fullScanRawUnavailable, 1);
  assert.equal(logs.at(-1).scanDocuments, 141);
});

test('published aliases prove reading while private titles and unrelated file hints do not escape', async () => {
  const catalog = await loadSocialCatalog();
  const book = catalog.values().next().value;
  const alias = 'secretfilename';
  const aliasId = hash(alias);
  const canonicalId = hash(book.id);
  const metadata = {
    schemaVersion: 1, titleKey: book.id, displayTitle: book.title, normalizerVersion: 'v1', publishedAt: '2026-01-01',
    platforms: book.platforms.map((p) => ({ platform: p.id, label: p.label, title: book.title, url: p.url, coverUrl: null, downloadCount: null, interestCount: null, viewCount: null, recommendCount: null, rating: null, ratingCount: null, lastSuccessAt: '2026-01-01' })),
  };
  const buckets = new Map();
  for (const id of [aliasId, canonicalId]) buckets.set(id.slice(0, 2), { ...buckets.get(id.slice(0, 2)), [id]: metadata });
  const session = { schemaVersion: 1, sessionId: 's1', bookId: 'private-file', bookTitle: 'secretfilename.txt', deviceId: 'd1', mode: 'screen', startedAtClient: 1000, endedAtClient: 3000, durationMs: 2000, startProgressPercent: 1, endProgressPercent: 10, timezoneOffsetMinutes: 0, localDate: '1970-01-01', completed: false };
  const sessions = [session];
  const stats = fixtureStats(() => sessions.map((record) => ({ id: record.sessionId, data: () => record })));
  const ambiguousId = hash('ambiguousoldname');
  const db = { collection(path) {
    if (path.endsWith('readingStatsV1')) return stats;
    if (path.endsWith('readingStatsDaysV2')) return emptyDayStats;
    return { doc(id) {
      const data = path === 'publicBookMetadataV1' && buckets.has(id)
        ? { schemaVersion: 1, entries: buckets.get(id) }
        : path === 'publicBookMetadataOnDemandV1' && id === ambiguousId
          ? { schemaVersion: 1, aliasId: ambiguousId, status: 'ambiguous' } : undefined;
      return { get: async () => ({ exists: Boolean(data), data: () => data }) };
    } };
  }, runTransaction: readFixtureTransaction };
  assert.equal((await resolveSocialWork(db, 'secretfilename.txt')).book.id, book.id);
  assert.deepEqual(await getSocialReadingEvidence(db, 'user', book.id, ['private-file']), { totalMs: 2000, progressPercent: 10 });
  assert.deepEqual(await getSocialReadingEvidence(db, 'user', book.id, ['other-file']), { totalMs: null, progressPercent: null });

  const oldName = { ...session, sessionId: 's2', bookTitle: 'unmatched-book-name.txt', startedAtClient: 4000, endedAtClient: 6000 };
  sessions.push(oldName);
  assert.deepEqual(await getSocialReadingEvidence(db, 'renamed', book.id, ['private-file']), { totalMs: 4000, progressPercent: 10 });
  sessions[1] = { ...oldName, bookId: 'unidentified-file' };
  assert.deepEqual(await getSocialReadingEvidence(db, 'incomplete', book.id, ['private-file']), { totalMs: 2000, progressPercent: 10 });

  sessions[1] = { ...oldName, bookTitle: 'ambiguousoldname.txt' };
  assert.deepEqual(await getSocialReadingEvidence(db, 'ambiguous-same-file', book.id, ['private-file']), {
    totalMs: null, progressPercent: null,
  });
  sessions[1] = { ...sessions[1], bookId: 'different-ambiguous-file' };
  assert.deepEqual(await getSocialReadingEvidence(db, 'ambiguous-other-file', book.id, ['private-file']), {
    totalMs: 2000, progressPercent: 10,
  });

  const [other, unrelated] = [...new Set(catalog.values())].filter((work) => work.id !== book.id);
  sessions[1] = { ...oldName, bookTitle: book.id, bookId: 'conflicted-file' };
  sessions.push(
    { ...oldName, sessionId: 's3', bookTitle: other.id, bookId: 'conflicted-file', startedAtClient: 7000, endedAtClient: 9000 },
    { ...oldName, sessionId: 's4', bookTitle: unrelated.id, bookId: 'unrelated-file', startedAtClient: 10000, endedAtClient: 12000 },
  );
  assert.deepEqual(await getSocialReadingEvidence(db, 'conflicted', book.id, ['private-file']), { totalMs: null, progressPercent: null });
  assert.deepEqual(await getSocialReadingEvidence(db, 'conflicted', unrelated.id, ['unrelated-file']), { totalMs: 2000, progressPercent: 10 });
});
