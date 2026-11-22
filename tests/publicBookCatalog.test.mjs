import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  parsePublicBookCatalogAliasShard,
  parsePublicBookCatalogDataShard,
  parsePublicBookCatalogManifest,
  stablePublicBookCatalogJson,
} from '../src/lib/publicBookCatalogSchema.ts';
import {
  getPublicBookCatalogSnapshot,
  invalidatePublicBookCatalog,
  joinBooksToPublicCatalog,
  loadPublicBookCatalog,
  resetPublicBookCatalogMemoryForTests,
} from '../src/lib/publicBookCatalog.ts';

const digest = (value) => createHash('sha256')
  .update(stablePublicBookCatalogJson(value))
  .digest('hex');

const generation = '0123456789abcdefabcd';
const aliasDocuments = Array.from({ length: 16 }, (_, index) => (
  `${generation}_alias_${index.toString(16)}`
));
const catalogDocuments = Array.from({ length: 8 }, (_, index) => (
  `${generation}_catalog_${index}`
));
const aliasId = createHash('sha256').update('테스트작품').digest('hex');
const rawDocuments = new Map();
for (let index = 0; index < 16; index += 1) {
  rawDocuments.set(aliasDocuments[index], {
    schemaVersion: 1,
    generation,
    kind: 'alias',
    shard: index,
    entries: index === Number.parseInt(aliasId[0], 16) ? { [aliasId]: 0 } : {},
  });
}
for (let index = 0; index < 8; index += 1) {
  rawDocuments.set(catalogDocuments[index], {
    schemaVersion: 1,
    generation,
    kind: 'catalog',
    shard: index,
    records: index === 0 ? {
      0: { p: 3, g: 0, t: [0], s: 8750, r: [7500, 10000, null], c: [1234, 5678, null] },
    } : {},
    ...(index === 0 ? {
      tags: { 0: { l: '하렘', n: 1 } },
      genres: { 0: '판타지' },
    } : {}),
  });
}
const rawManifest = {
  schemaVersion: 1,
  generation,
  publishedAt: '2026-08-17T00:00:00+00:00',
  normalizerVersion: '1.3.3',
  genrePolicyVersion: 'file_check-v1',
  popularityFormulaVersion: 1,
  aliasDocuments,
  catalogDocuments,
  aliasCount: 1,
  titleCount: 1,
  tagCount: 1,
  genreCount: 1,
  excludedAliasCollisionCount: 7,
  checksums: Object.fromEntries(
    [...rawDocuments].map(([documentId, value]) => [documentId, digest(value)]),
  ),
};

const snapshot = (value) => ({ exists: () => value !== undefined, data: () => value });

test('parses the bounded manifest and compact shard records', () => {
  const manifest = parsePublicBookCatalogManifest(rawManifest);
  assert.ok(manifest);
  const aliasShard = parsePublicBookCatalogAliasShard(
    rawDocuments.get(aliasDocuments[Number.parseInt(aliasId[0], 16)]),
    manifest,
  );
  assert.equal(aliasShard?.entries[aliasId], 0);
  const catalogShard = parsePublicBookCatalogDataShard(rawDocuments.get(catalogDocuments[0]), manifest);
  assert.deepEqual(catalogShard?.records[0], {
    id: 0,
    platformMask: 3,
    canonicalGenreId: 0,
    tagIds: [0],
    popularityScore: 8750,
    sourceRanks: [7500, 10000, null],
    sourceCounts: [1234, 5678, null],
  });
  assert.equal(catalogShard?.tags[0].label, '하렘');
  assert.equal(catalogShard?.genres.get(0), '판타지');
});

test('rejects malformed source tuples and unexpected manifest checksums', () => {
  const manifest = parsePublicBookCatalogManifest(rawManifest);
  assert.ok(manifest);
  const malformed = structuredClone(rawDocuments.get(catalogDocuments[0]));
  malformed.records[0].c = [1234, 5678];
  assert.equal(parsePublicBookCatalogDataShard(malformed, manifest), null);
  assert.equal(parsePublicBookCatalogManifest({
    ...rawManifest,
    checksums: { ...rawManifest.checksums, unexpected: '0'.repeat(64) },
  }), null);
});

test('loads generation documents cache-first and joins filename aliases', async () => {
  resetPublicBookCatalogMemoryForTests();
  const serverCalls = [];
  const cacheCalls = [];
  const api = {
    getFromServer: async (documentId) => {
      serverCalls.push(documentId);
      return snapshot(documentId === 'manifest' ? rawManifest : rawDocuments.get(documentId));
    },
    getFromCache: async (documentId) => {
      cacheCalls.push(documentId);
      return snapshot(rawDocuments.get(documentId));
    },
  };
  const catalog = await loadPublicBookCatalog(api);
  assert.deepEqual(serverCalls, ['manifest']);
  assert.equal(cacheCalls.length, 24);
  assert.equal(catalog.popularTags[0].label, '하렘');
  const books = [{ id: 'book-1', name: '테스트 작품 1-231 완.epub', mimeType: 'application/epub+zip' }];
  const joined = await joinBooksToPublicCatalog(books, catalog);
  assert.equal(joined.get('book-1')?.genreLabel, '판타지');
  assert.deepEqual(joined.get('book-1')?.record.sourceCounts, [1234, 5678, null]);
});

test('falls back to the server only for missing cached generation documents', async () => {
  resetPublicBookCatalogMemoryForTests();
  const missingId = catalogDocuments[7];
  const serverCalls = [];
  const api = {
    getFromServer: async (documentId) => {
      serverCalls.push(documentId);
      return snapshot(documentId === 'manifest' ? rawManifest : rawDocuments.get(documentId));
    },
    getFromCache: async (documentId) => {
      if (documentId === missingId) throw new Error('cache miss');
      return snapshot(rawDocuments.get(documentId));
    },
  };
  await loadPublicBookCatalog(api);
  assert.deepEqual(serverCalls, ['manifest', missingId]);
});

test('replaces a checksum-mismatched cached shard from the server', async () => {
  resetPublicBookCatalogMemoryForTests();
  const corruptedId = aliasDocuments[3];
  const serverCalls = [];
  const api = {
    getFromServer: async (documentId) => {
      serverCalls.push(documentId);
      return snapshot(documentId === 'manifest' ? rawManifest : rawDocuments.get(documentId));
    },
    getFromCache: async (documentId) => snapshot(
      documentId === corruptedId
        ? { ...rawDocuments.get(documentId), entries: { broken: 0 } }
        : rawDocuments.get(documentId),
    ),
  };
  await loadPublicBookCatalog(api);
  assert.deepEqual(serverCalls, ['manifest', corruptedId]);
});


test('reuses a verified snapshot within the bound and forces explicit refresh', async () => {
  resetPublicBookCatalogMemoryForTests();
  let calls = 0;
  const api = {
    getFromServer: async (id) => { calls++; return snapshot(id === 'manifest' ? rawManifest : rawDocuments.get(id)); },
    getFromCache: async (id) => snapshot(rawDocuments.get(id)),
  };
  const first = await loadPublicBookCatalog(api);
  assert.equal(getPublicBookCatalogSnapshot(), first);
  assert.equal(await loadPublicBookCatalog(api), first);
  assert.equal(calls, 1);
  assert.equal(await loadPublicBookCatalog(api, { force: true }), first);
  assert.equal(calls, 2);
});

test('offline manifest and failed delta never become fresh', async () => {
  resetPublicBookCatalogMemoryForTests();
  let online = false;
  let manifestCalls = 0;
  const api = {
    getFromServer: async (id) => { if (id === 'manifest') { manifestCalls++; if (!online) throw Error('offline'); return snapshot(rawManifest); } return snapshot(rawDocuments.get(id)); },
    getFromCache: async (id) => snapshot(id === 'manifest' ? rawManifest : rawDocuments.get(id)),
  };
  await loadPublicBookCatalog(api);
  online = true;
  await loadPublicBookCatalog(api);
  assert.equal(manifestCalls, 2);
  await loadPublicBookCatalog(api);
  assert.equal(manifestCalls, 2);
  invalidatePublicBookCatalog();
  let deltaCalls = 0;
  const deltaApi = { getFromServer: async () => { deltaCalls++; throw Error('offline'); }, getFromCache: async () => { throw Error('missing'); } };
  await loadPublicBookCatalog(api, { deltaApi });
  await loadPublicBookCatalog(api, { deltaApi });
  assert.equal(deltaCalls, 2);
});

test('invalidation during an in-flight verification requires a new server check', async () => {
  resetPublicBookCatalogMemoryForTests();
  let release;
  let calls = 0;
  const api = {
    getFromServer: async (id) => {
      if (id !== 'manifest') return snapshot(rawDocuments.get(id));
      calls++;
      if (calls === 1) await new Promise((resolve) => { release = resolve; });
      return snapshot(rawManifest);
    },
    getFromCache: async (id) => snapshot(rawDocuments.get(id)),
  };
  const pending = loadPublicBookCatalog(api);
  invalidatePublicBookCatalog();
  release();
  await pending;
  await loadPublicBookCatalog(api);
  assert.equal(calls, 2);
});


test('a verified snapshot expires after the bounded interval', async (t) => {
  resetPublicBookCatalogMemoryForTests();
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  let calls = 0;
  const api = {
    getFromServer: async (id) => { calls++; return snapshot(id === 'manifest' ? rawManifest : rawDocuments.get(id)); },
    getFromCache: async (id) => snapshot(rawDocuments.get(id)),
  };
  await loadPublicBookCatalog(api);
  t.mock.timers.tick(59_999);
  await loadPublicBookCatalog(api);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await loadPublicBookCatalog(api);
  assert.equal(calls, 2);
});


test('a failed delta refresh retains the last complete snapshot and remains retryable', async () => {
  resetPublicBookCatalogMemoryForTests();
  let deltaCalls = 0;
  let fail = false;
  const api = {
    getFromServer: async (id) => snapshot(id === 'manifest' ? rawManifest : rawDocuments.get(id)),
    getFromCache: async (id) => snapshot(rawDocuments.get(id)),
  };
  const deltaApi = {
    getFromServer: async () => { deltaCalls++; if (fail) throw Error('offline'); return snapshot(undefined); },
    getFromCache: async () => { throw Error('cache unavailable'); },
  };
  const complete = await loadPublicBookCatalog(api, { deltaApi });
  fail = true;
  invalidatePublicBookCatalog();
  assert.equal(await loadPublicBookCatalog(api, { deltaApi }), complete);
  assert.equal(getPublicBookCatalogSnapshot(), complete);
  fail = false;
  assert.equal(await loadPublicBookCatalog(api, { deltaApi }), complete);
  assert.equal(deltaCalls, 3);
});

test('forced refresh after publication waits for old in-flight work and checks again', async () => {
  resetPublicBookCatalogMemoryForTests();
  let release;
  let calls = 0;
  const api = {
    getFromServer: async (id) => {
      if (id !== 'manifest') return snapshot(rawDocuments.get(id));
      calls++;
      if (calls === 1) await new Promise((resolve) => { release = resolve; });
      return snapshot(rawManifest);
    },
    getFromCache: async (id) => snapshot(rawDocuments.get(id)),
  };
  const beforePublication = loadPublicBookCatalog(api);
  invalidatePublicBookCatalog();
  const afterPublication = loadPublicBookCatalog(api, { force: true });
  release();
  await Promise.all([beforePublication, afterPublication]);
  assert.equal(calls, 2);
});
