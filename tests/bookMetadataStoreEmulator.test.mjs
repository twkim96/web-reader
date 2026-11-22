import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import {
  acquireMetadataLease,
  BOOK_METADATA_CRAWLER_VERSION,
  buildOnDemandMetadata,
  recoverPendingCatalogPublication,
  saveMetadataAndPublish,
  waitForMetadataLease,
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

test('one of ten concurrent requests owns the alias lease and replay reads only cached metadata', async (t) => {
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

  const paths = [];
  const runTransaction = db.runTransaction.bind(db);
  t.mock.method(db, 'runTransaction', (callback, ...options) => runTransaction((transaction) => {
    const get = transaction.get.bind(transaction);
    t.mock.method(transaction, 'get', (ref) => {
      paths.push(ref.path);
      return get(ref);
    });
    return callback(transaction);
  }, ...options));
  const replay = await acquireMetadataLease(db, alias(1), 'alice', 1_000_200);
  assert.equal(replay.kind, 'cached');
  assert.deepEqual(paths, [`publicBookMetadataOnDemandV1/${alias(1)}`]);
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

test('a busy refresh waits past expired, mismatched and unpublished results', async (t) => {
  const aliasId = alias(400);
  const now = Date.now();
  const queryTitle = '최신 작품';
  const expected = { queryTitle, crawlerVersion: BOOK_METADATA_CRAWLER_VERSION };
  const source = db.collection('publicBookMetadataOnDemandV1').doc(aliasId);
  const expired = buildOnDemandMetadata(aliasId, alias(401), queryTitle, [], now - 8 * 86_400_000);
  const pending = buildOnDemandMetadata(aliasId, alias(401), queryTitle, [{
    platform: 'kakao', status: 'ok', remoteId: '123', remoteTitle: queryTitle,
    url: 'https://page.kakao.com/content/123',
  }], now);
  await source.set(expired);
  const refresh = await acquireMetadataLease(db, aliasId, 'alice', now, expected);
  assert.equal(refresh.kind, 'acquired');
  const busy = await acquireMetadataLease(db, aliasId, 'bob', now, expected);
  assert.equal(busy.kind, 'busy');
  const prototype = Object.getPrototypeOf(source);
  const get = prototype.get;
  let reads = 0;
  t.mock.method(prototype, 'get', async function (...args) {
    if (this.path === source.path) {
      reads++;
      if (reads === 2) await source.set({ ...pending, queryTitle: '다른 작품', publishPending: false });
      if (reads === 3) await source.set(pending);
      if (reads === 4) await source.update({ publishPending: false });
    }
    return get.apply(this, args);
  });
  assert.deepEqual(await waitForMetadataLease(db, aliasId, expected, busy.previousSourceVersion), { ...pending, publishPending: false });
  assert.equal(reads, 4);
});

test('an older publisher cannot activate its delta or clear a newer source publication', async () => {
  const aliasId = alias(500);
  const now = Date.now();
  const ready = (remoteId, crawledAt) => buildOnDemandMetadata(aliasId, alias(501), '동시 게시 작품', [{
    platform: 'kakao', status: 'ok', remoteId, remoteTitle: '동시 게시 작품',
    url: `https://page.kakao.com/content/${remoteId}`, sourceCount: Number(remoteId),
  }], crawledAt);
  const old = ready('123', now - 100);
  const current = ready('456', now);
  const source = db.collection('publicBookMetadataOnDemandV1').doc(aliasId);
  const delta = db.collection('publicBookCatalogDeltaV1');
  await source.set(current);
  await assert.rejects(recoverPendingCatalogPublication(db, old), /metadata source changed/);
  assert.equal((await delta.doc('manifest').get()).exists, false);
  assert.deepEqual((await source.get()).data(), current);

  const generation = await recoverPendingCatalogPublication(db, current);
  assert.equal((await delta.doc('manifest').get()).get('generation'), generation);
  assert.deepEqual((await source.get()).data(), { ...current, publishPending: false });
});

test('a waiting reader receives a newly completed crawler error, not the previous error', async (t) => {
  const aliasId = alias(600);
  const now = Date.now();
  const expected = { queryTitle: '수집 오류 작품', crawlerVersion: BOOK_METADATA_CRAWLER_VERSION };
  const failedResult = (at) => buildOnDemandMetadata(aliasId, alias(601), expected.queryTitle, [
    { platform: 'kakao', status: 'error' },
  ], at);
  const source = db.collection('publicBookMetadataOnDemandV1').doc(aliasId);
  await source.set(failedResult(now - 60_000));
  const active = await acquireMetadataLease(db, aliasId, 'alice', now, expected);
  assert.equal(active.kind, 'acquired');
  const busy = await acquireMetadataLease(db, aliasId, 'bob', now, expected);
  assert.equal(busy.kind, 'busy');
  let reads = 0;
  const prototype = Object.getPrototypeOf(source);
  const get = prototype.get;
  const current = failedResult(now + 1000);
  assert.equal(current.status, 'error');
  t.mock.method(prototype, 'get', async function (...args) {
    if (this.path === source.path && ++reads === 2) await saveMetadataAndPublish(db, current, active.owner);
    return get.apply(this, args);
  });
  assert.deepEqual(await waitForMetadataLease(db, aliasId, expected, busy.previousSourceVersion), current);
  assert.equal(reads, 2);
});

test('concurrent recovery of the same source accepts matching immutable shards', async (t) => {
  const aliasId = alias(700);
  const ready = buildOnDemandMetadata(aliasId, alias(701), '동일 게시 결과', [{
    platform: 'kakao', status: 'ok', remoteId: '123', remoteTitle: '동일 게시 결과',
    url: 'https://page.kakao.com/content/123',
  }]);
  const source = db.collection('publicBookMetadataOnDemandV1').doc(aliasId);
  await source.set(ready);
  const bothReady = Promise.withResolvers();
  const batch = db.batch.bind(db);
  let commits = 0;
  t.mock.method(db, 'batch', () => {
    const writer = batch();
    const commit = writer.commit.bind(writer);
    t.mock.method(writer, 'commit', async () => {
      if (++commits === 2) bothReady.resolve();
      await bothReady.promise;
      return commit();
    });
    return writer;
  });
  const generations = await Promise.all([
    recoverPendingCatalogPublication(db, ready),
    recoverPendingCatalogPublication(db, ready),
  ]);
  assert.equal(commits, 2);
  assert.equal(generations[0], generations[1]);
  assert.equal((await source.get()).get('publishPending'), false);
});
