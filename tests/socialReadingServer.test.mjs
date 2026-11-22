import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Timestamp } from 'firebase-admin/firestore';
import { loadSocialCatalog, resolveLegacyReviewWork, resolveSocialWork } from '../src/server/mypage/catalog.ts';
import { getSocialReadingEvidence } from '../src/server/mypage/reading.ts';
import { platformWorkKey } from '../src/lib/readBooks.ts';

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

function fixtureStats(readRows, onFullScan = () => {}) {
  const timestamp = (row) => row.get?.('uploadedAtServer');
  return {
    count: () => ({ get: async () => ({ data: () => ({ count: readRows().length }) }) }),
    orderBy(field, direction) {
      const timestampOrdered = field === 'uploadedAtServer';
      let after;
      let pageSize;
      const query = {
        orderBy: () => query,
        select: () => query,
        limit: (size) => { pageSize = size; return query; },
        startAfter: (stamp, id) => { after = { stamp, id }; return query; },
        get: async () => {
          let docs = readRows();
          if (timestampOrdered) {
            docs = docs.filter(timestamp).sort((left, right) => (
              timestamp(left).valueOf().localeCompare(timestamp(right).valueOf())
              || Buffer.compare(Buffer.from(left.id), Buffer.from(right.id))
            ));
            if (direction === 'desc') docs.reverse();
            if (after) docs = docs.filter((row) => timestamp(row) > after.stamp
              || (timestamp(row).isEqual(after.stamp) && row.id > after.id));
          } else {
            onFullScan();
          }
          return { docs: docs.slice(0, pageSize), readTime: Timestamp.now() };
        },
      };
      return query;
    },
  };
}

const readFixtureTransaction = (callback) => callback({ get: (query) => query.get() });

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
    collection: () => fixtureStats(() => rows, () => { fullScans++; }),
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
  const db = { collection: () => stats, runTransaction: readFixtureTransaction };
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
