import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  mergePublicBookCatalogDelta,
  parsePublicBookCatalogDeltaManifest,
  parsePublicBookCatalogDeltaShard,
} from '../src/lib/publicBookCatalogDelta.ts';
import { stablePublicBookCatalogJson } from '../src/lib/publicBookCatalogSchema.ts';

const generation = 'abcdef0123456789abcd';
const documents = Array.from({ length: 16 }, (_, shard) => `${generation}_delta_${shard.toString(16)}`);
const alias = `a${'0'.repeat(63)}`;
const shard = { schemaVersion: 1, generation, kind: 'delta', shard: 10, entries: {
  [alias]: { k: 'b'.repeat(64), q: '새 작품', p: 6, g: '현대판타지', t: ['성장', '회귀'], c: [null, 300, 100] },
} };
const emptyShard = (index) => ({ schemaVersion: 1, generation, kind: 'delta', shard: index, entries: {} });
const checksum = (value) => createHash('sha256').update(stablePublicBookCatalogJson(value)).digest('hex');
const manifest = {
  schemaVersion: 1, generation, publishedAt: '2026-08-17T00:00:00Z', documents, recordCount: 1,
  checksums: Object.fromEntries(documents.map((id, index) => [id, checksum(index === 10 ? shard : emptyShard(index))])),
};

test('validates immutable delta manifest and alias shard', () => {
  const parsed = parsePublicBookCatalogDeltaManifest(manifest);
  assert.ok(parsed);
  assert.equal(parsePublicBookCatalogDeltaShard(shard, parsed, 10)?.get(alias)?.genre, '현대판타지');
  assert.equal(parsePublicBookCatalogDeltaManifest({ ...manifest, recordCount: -1 }), null);
});

test('delta replaces the base alias, augments dictionaries, and recomputes popularity', () => {
  const base = {
    manifest: { generation: 'base' },
    aliases: new Map([[alias, 0], ['c'.repeat(64), 1]]),
    records: new Map([
      [0, { id: 0, platformMask: 1, canonicalGenreId: 0, tagIds: [0], popularityScore: 2500, sourceRanks: [2500, null, null], sourceCounts: [100, null, null] }],
      [1, { id: 1, platformMask: 2, canonicalGenreId: 0, tagIds: [1], popularityScore: 5000, sourceRanks: [null, 5000, null], sourceCounts: [null, 200, null] }],
    ]),
    tags: new Map([[0, { id: 0, label: '옛태그', titleCount: 1 }], [1, { id: 1, label: '성장', titleCount: 1 }]]),
    genres: new Map([[0, '판타지']]),
    popularTags: [],
  };
  const merged = mergePublicBookCatalogDelta(base, { manifest: { generation }, entries: new Map([[alias, {
    canonicalKey: 'b'.repeat(64), queryTitle: '새 작품', platformMask: 6, genre: '현대판타지', tags: ['성장', '회귀'], sourceCounts: [null, 300, 100],
  }]]) });
  const nextId = merged.aliases.get(alias);
  assert.notEqual(nextId, 0);
  assert.deepEqual(merged.records.get(nextId).sourceCounts, [null, 300, 100]);
  assert.equal([...merged.tags.values()].find(({ label }) => label === '옛태그').titleCount, 0);
  assert.equal([...merged.tags.values()].find(({ label }) => label === '성장').titleCount, 2);
  assert.deepEqual(merged.popularTags.map(({ label }) => label), ['성장', '회귀']);
  assert.equal(merged.deltaGeneration, generation);
});
