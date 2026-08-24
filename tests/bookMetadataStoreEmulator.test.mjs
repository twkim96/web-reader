import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import {
  acquireMetadataLease,
  BOOK_METADATA_CRAWLER_VERSION,
  buildOnDemandMetadata,
  saveMetadataAndPublish,
} from '../src/server/bookMetadata/store.ts';

let app;
let db;
const collections = [
  'publicBookMetadataOnDemandV1',
  'publicBookCatalogDeltaV1',
  'bookMetadataRequestStateV1',
  'bookMetadataDailyQuotaV1',
];

before(() => {
  app = initializeApp({ projectId: 'demo-web-reader' }, 'book-metadata-store-test');
  db = getFirestore(app);
});

beforeEach(async () => {
  for (const name of collections) {
    const snapshot = await db.collection(name).get();
    const batch = db.batch();
    snapshot.docs.forEach((document) => batch.delete(document.ref));
    await batch.commit();
  }
});

after(async () => {
  await deleteApp(app);
});

const alias = (value) => value.toString(16).padStart(64, '0');

test('one of ten concurrent requests owns the alias lease and replay uses the cache', async () => {
  const attempts = await Promise.all(Array.from({ length: 10 }, () => (
    acquireMetadataLease(db, alias(1), 'alice', 1_000_000)
  )));
  const acquired = attempts.filter(({ kind }) => kind === 'acquired');
  assert.equal(acquired.length, 1);
  assert.equal(attempts.filter(({ kind }) => kind === 'busy').length, 9);

  const document = buildOnDemandMetadata(alias(1), alias(2), '테스트 작품', [{
    platform: 'kakao', status: 'ok', remoteId: '123', remoteTitle: '테스트 작품',
    url: 'https://page.kakao.com/content/123', genre: '현대판타지', tags: ['성장', '회귀'], sourceCount: 1234,
  }], 1_000_100);
  assert.equal(document.platforms[0].coverUrl, null);
  const generation = await saveMetadataAndPublish(db, document, acquired[0].owner);
  assert.match(generation, /^[0-9a-f]{20}$/);

  const replay = await acquireMetadataLease(db, alias(1), 'alice', 1_000_200);
  assert.equal(replay.kind, 'cached');
  assert.equal(replay.document.publishPending, false);
  const manifest = await db.collection('publicBookCatalogDeltaV1').doc('manifest').get();
  assert.equal(manifest.data().recordCount, 1);
  assert.equal(manifest.data().documents.length, 16);
});

test('stale leases can be reclaimed and the daily quota fails closed', async () => {
  await db.collection('bookMetadataRequestStateV1').doc(alias(100)).set({
    schemaVersion: 1, owner: 'stale', leaseUntil: 1, lastStartedAt: 1,
  });
  assert.equal((await acquireMetadataLease(db, alias(100), 'bob', 1_000_000)).kind, 'acquired');

  const results = [];
  for (let index = 0; index < 21; index += 1) {
    results.push(await acquireMetadataLease(db, alias(200 + index), 'quota-user', 2_000_000));
  }
  assert.equal(results.filter(({ kind }) => kind === 'acquired').length, 20);
  assert.equal(results[20].kind, 'quota');
});

test('a corrected query and crawler version replace a fresh legacy not-found cache', async () => {
  const aliasId = alias(300);
  const now = 3_000_000;
  await db.collection('publicBookMetadataOnDemandV1').doc(aliasId).set({
    schemaVersion: 1,
    aliasId,
    canonicalKey: alias(301),
    queryTitle: '회귀로 바로잡다 1-472',
    status: 'not-found',
    platforms: [],
    platformStatuses: [],
    crawledAt: new Date(now - 1_000).toISOString(),
    nextRefreshAt: new Date(now + 60_000).toISOString(),
    crawlerVersion: 'web-reader-1.8.15-v1',
    publishPending: false,
  });
  await db.collection('bookMetadataRequestStateV1').doc(aliasId).set({
    schemaVersion: 1, owner: null, leaseUntil: 0, lastStartedAt: now - 1_000,
  });
  const refreshed = await acquireMetadataLease(db, aliasId, 'alice', now, {
    queryTitle: '회귀로 바로잡다',
    crawlerVersion: BOOK_METADATA_CRAWLER_VERSION,
  });
  assert.equal(refreshed.kind, 'acquired');
});
