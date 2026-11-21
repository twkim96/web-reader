import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  const db = { collection: () => ({
    orderBy: (field) => ({ limit: () => ({ get: async () => {
      if (field === 'uploadedAtServer') return { docs: rows.filter((row) => row.get('uploadedAtServer')) };
      fullScans++;
      return { docs: rows };
    } }) }),
  }) };
  const evidence = (uid) => getSocialReadingEvidence(db, uid, book.id, ['file']);
  const expectEvidence = { totalMs: 2000, progressPercent: 10 };

  await evidence('new-account');
  now += 31_000;
  await evidence('new-account');
  assert.equal(fullScans, 1);

  rows.push({ id: session.sessionId, get: () => ({ seconds: 1, nanoseconds: 0 }), data: () => session });
  now += 31_000;
  assert.deepEqual(await evidence('new-account'), expectEvidence);
  assert.equal(fullScans, 2);

  rows[0] = { ...rows[0], get: () => undefined };
  assert.deepEqual(await evidence('legacy-account'), expectEvidence);
  now += 31_000;
  assert.deepEqual(await evidence('legacy-account'), expectEvidence);
  assert.equal(fullScans, 4);
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
  const empty = () => ({ docs: [] });
  const stats = {
    orderBy(field) {
      return { limit: () => ({ get: async () => field === 'uploadedAtServer' ? empty() : { docs: sessions.map((record) => ({ id: record.sessionId, data: () => record })) } }) };
    },
  };
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
  } };
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
