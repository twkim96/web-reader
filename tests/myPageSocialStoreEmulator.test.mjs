import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { DocumentReference, getFirestore, Query, Timestamp } from 'firebase-admin/firestore';
import { APP_ID } from '../src/lib/appIdentity.ts';
import { MY_PAGE_CODE } from '../src/lib/myPageSocial.ts';
import { WISHLIST_SNAPSHOT_ROW_LIMIT } from '../src/server/mypage/wishlistSnapshot.ts';
import {
  ConflictError,
  ensureAccount,
  listOwnWishlist,
  listReviews,
  listWishlist,
  lookupPublicAccount,
  readReview,
  updateAccount,
  updateReview,
  updateWishlist,
  workPublicReviews,
} from '../src/server/mypage/store.ts';

let app;
let db;

before(() => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator required');
  app = initializeApp({ projectId: 'demo-web-reader' }, 'mypage-social-store-test');
  db = getFirestore(app);
});

after(async () => {
  if (app) await deleteApp(app);
});

const visibility = { reviews: false, wishlist: false };
const review = (rating, comment = '') => ({ rating, comment, totalMs: null, progressPercent: null });
const entries = (workId) => db.collection('publicBookReviewsV1')
  .doc(createHash('sha256').update(workId).digest('hex')).collection('entries');
const changeAccount = (uid, account, flags, nickname = account.nickname) => updateAccount(db, uid, {
  nickname, visibility: { ...visibility, ...flags }, revision: account.revision,
});

test('code collision retries, rename retains identity, and public profile follows current visibility', async (t) => {
  const uid = randomUUID();
  const otherUid = randomUUID();
  const [initial, concurrent] = await Promise.all([ensureAccount(db, uid), ensureAccount(db, uid)]);
  assert.deepEqual(concurrent, initial);
  assert.match(initial.code, MY_PAGE_CODE);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const codeBytes = Buffer.from(Array.from(initial.code, (character) => alphabet.indexOf(character)));
  const originalRandomBytes = crypto.randomBytes;
  let allocations = 0;
  const mock = t.mock.method(crypto, 'randomBytes', (size, ...args) => {
    if (size === 8 && args.length === 0 && ++allocations === 1) return codeBytes;
    return originalRandomBytes(size, ...args);
  });
  syncBuiltinESMExports();
  let other;
  try {
    other = await ensureAccount(db, otherUid);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(allocations, 2);
  assert.notEqual(other.code, initial.code);
  assert.equal((await ensureAccount(db, uid)).code, initial.code);
  assert.deepEqual(initial.visibility, { reviews: true, wishlist: false });
  assert.deepEqual(await lookupPublicAccount(db, initial.code), { uid, account: initial });

  const suffix = randomUUID().slice(0, 8);
  const nickname = `Café${suffix}😀`;
  const shown = await changeAccount(uid, initial, { wishlist: true }, nickname);
  assert.deepEqual(await lookupPublicAccount(db, `#${initial.code.toLowerCase()}`), { uid, account: shown });
  await assert.rejects(changeAccount(uid, initial, { reviews: true }), ConflictError);
  const renamed = await changeAccount(uid, shown, { reviews: true }, `Renamed${suffix}`);
  assert.equal(renamed.code, initial.code);
  assert.deepEqual(await lookupPublicAccount(db, initial.code), { uid, account: renamed });
  await changeAccount(uid, renamed, {});
  assert.equal(await lookupPublicAccount(db, initial.code), null);
});

test('saving unchanged account settings keeps the profile revision and update time', async () => {
  const uid = randomUUID();
  const account = await ensureAccount(db, uid);
  const profile = db.collection('publicReaderProfilesV1').doc(account.code);
  const stored = await profile.get();

  assert.deepEqual(await updateAccount(db, uid, account), account);
  assert.ok((await profile.get()).updateTime.isEqual(stored.updateTime));

  const updated = await changeAccount(uid, account, { wishlist: true });
  assert.equal(updated.revision, account.revision + 1);
  await assert.rejects(updateAccount(db, uid, { ...updated, revision: account.revision }), ConflictError);

  // Malformed legacy visibility is interpreted as private, but an explicit
  // save should still repair the stored fields for subsequent queries.
  await profile.update({ visibility: null });
  const repaired = await updateAccount(db, uid, { ...updated, visibility });
  assert.equal(repaired.revision, updated.revision + 1);
  assert.deepEqual((await profile.get()).get('visibility'), visibility);
});

test('item revisions isolate works and preserve tombstones during import', async () => {
  const uid = randomUUID();
  const account = await ensureAccount(db, uid);
  const otherUid = randomUUID();
  const a = randomUUID();
  const b = randomUUID();
  const [saved, otherSaved] = await Promise.all([
    updateWishlist(db, uid, a, true, null),
    updateWishlist(db, uid, b, true, null),
  ]);
  assert.deepEqual(new Set((await listWishlist(db, uid)).map(({ workId }) => workId)), new Set([a, b]));
  assert.deepEqual(await listWishlist(db, otherUid), []);

  const [written, otherWritten] = await Promise.all([
    updateReview(db, uid, a, review(3, 'original'), null),
    updateReview(db, uid, b, review(4), null),
  ]);
  assert.deepEqual(await readReview(db, uid, a), written);
  assert.equal(await readReview(db, otherUid, a), null);
  const removed = await updateWishlist(db, uid, a, false, saved.revision);
  assert.equal(await updateReview(db, uid, a, null, written.revision), null);
  assert.deepEqual(await updateWishlist(db, uid, a, true, null, true, account.revision), removed);
  assert.equal(await updateReview(db, uid, a, review(5), null, true, account.revision), null);
  assert.deepEqual(await listWishlist(db, uid), [otherSaved]);
  assert.deepEqual(await listReviews(db, uid), [otherWritten]);

  await assert.rejects(updateWishlist(db, uid, a, true, saved.revision), ConflictError);
  await assert.rejects(updateReview(db, uid, a, review(5), written.revision), ConflictError);
  await assert.rejects(updateWishlist(db, uid, a, true, null), ConflictError);
  await assert.rejects(updateReview(db, uid, a, review(5), null), ConflictError);
  const restored = await updateReview(db, uid, a, review(5), written.revision + 1);
  assert.ok(restored.revision > written.revision);
  assert.equal((await updateWishlist(db, uid, a, true, removed.revision)).saved, true);

  const nextAccount = await changeAccount(uid, account, { reviews: true, wishlist: true });
  const c = randomUUID();
  await assert.rejects(updateReview(db, uid, c, review(2), null, true, account.revision), ConflictError);
  await assert.rejects(updateWishlist(db, uid, c, true, null, true, account.revision), ConflictError);
  assert.equal(await readReview(db, uid, c), null);
  assert.ok(!(await listWishlist(db, uid)).some(({ workId }) => workId === c));
  assert.equal((await updateReview(db, uid, c, review(2), null, true, nextAccount.revision)).rating, 2);
  assert.equal((await updateWishlist(db, uid, c, true, null, true, nextAccount.revision)).saved, true);
});

const wishlistList = (uid) => db.collection(`artifacts/${APP_ID}/users/${uid}/libraries/local/myPageWishlistV1`);
const wishlistSnapshot = (uid) => wishlistList(uid).parent.collection('myPageWishlistSnapshotV1').doc('current');

test('one-document wishlist keeps deletes, independent writes, and rollback data in sync', async (t) => {
  const uid = randomUUID();
  const generation = 'test-first';
  const flag = 'MY_PAGE_WISHLIST_SNAPSHOT_GENERATION';
  const previous = process.env[flag];
  t.after(() => {
    if (previous === undefined) delete process.env[flag]; else process.env[flag] = previous;
  });
  delete process.env[flag];
  const account = await ensureAccount(db, uid);
  const removed = await updateWishlist(db, uid, 'removed', false, null);
  const original = await updateWishlist(db, uid, 'original', true, null);
  assert.equal((await wishlistSnapshot(uid).get()).exists, false);
  process.env[flag] = generation;
  const [, added, independent] = await Promise.all([
    listOwnWishlist(db, uid),
    updateWishlist(db, uid, 'added', true, null),
    updateWishlist(db, uid, 'independent', true, null),
  ]);
  assert.equal((await wishlistSnapshot(uid).get()).get('generation'), generation);
  const query = t.mock.method(Query.prototype, 'get');
  const getDocument = t.mock.method(DocumentReference.prototype, 'get');
  const warm = await listOwnWishlist(db, uid);
  const warmQueries = query.mock.callCount();
  const warmDocuments = getDocument.mock.callCount();
  query.mock.restore();
  getDocument.mock.restore();
  assert.equal(warmQueries, 0);
  assert.equal(warmDocuments, 1);
  assert.deepEqual(warm, await listWishlist(db, uid, true));
  assert.deepEqual(new Set(warm.map(({ workId }) => workId)), new Set(['removed', 'original', 'added', 'independent']));
  assert.deepEqual(await updateWishlist(db, uid, removed.workId, true, null, true, account.revision), removed);

  const racing = await Promise.allSettled([
    updateWishlist(db, uid, 'original', false, original.revision),
    updateWishlist(db, uid, 'original', false, original.revision),
  ]);
  assert.equal(racing.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.ok(racing.find(({ status }) => status === 'rejected').reason instanceof ConflictError);
  const deleted = JSON.parse((await wishlistSnapshot(uid).get()).get('payload'));
  assert.ok(!deleted.saved.some(([workId]) => workId === 'original'));
  assert.ok(deleted.removed.some(([workId, revision]) => workId === 'original' && revision === original.revision + 1));
  assert.deepEqual(await listOwnWishlist(db, uid), await listWishlist(db, uid, true));
  assert.deepEqual((await updateWishlist(db, uid, 'original', true, original.revision + 1)).saved, true);

  delete process.env[flag];
  await updateWishlist(db, uid, 'added', false, added.revision);
  assert.equal((await wishlistSnapshot(uid).get()).get('generation'), generation);
  assert.ok((await listOwnWishlist(db, uid)).some(({ workId, saved }) => workId === 'added' && !saved));
  process.env[flag] = 'test-after-legacy-write';
  assert.deepEqual(await listOwnWishlist(db, uid), await listWishlist(db, uid, true));
  assert.equal((await wishlistSnapshot(uid).get()).get('generation'), 'test-after-legacy-write');
  assert.ok((await listOwnWishlist(db, uid)).some(({ workId, saved, revision }) => (
    workId === independent.workId && saved && revision === independent.revision
  )));
});

test('oversized wishlists use the complete legacy list after first read or later growth', async (t) => {
  const flag = 'MY_PAGE_WISHLIST_SNAPSHOT_GENERATION';
  const previous = process.env[flag];
  process.env[flag] = 'test-overflow';
  t.after(() => {
    if (previous === undefined) delete process.env[flag]; else process.env[flag] = previous;
  });
  const seed = async (uid, count, prefix = '한'.repeat(480)) => {
    for (let offset = 0; offset < count; offset += 400) {
      const batch = db.batch();
      for (let index = offset; index < Math.min(offset + 400, count); index++) {
        const workId = prefix + index;
        batch.create(wishlistList(uid).doc(createHash('sha256').update(workId).digest('hex')),
          { workId, revision: 1, addedAt: 1_000, saved: index > 0 });
      }
      await batch.commit();
    }
  };
  const oversized = randomUUID();
  await seed(oversized, 370);
  assert.equal((await listOwnWishlist(db, oversized)).length, 370);
  assert.equal((await wishlistSnapshot(oversized).get()).get('payload'), null);

  const growing = randomUUID();
  await seed(growing, 355);
  assert.equal((await listOwnWishlist(db, growing)).length, 355);
  assert.equal(typeof (await wishlistSnapshot(growing).get()).get('payload'), 'string');
  for (let index = 0; index < 15; index++) {
    await updateWishlist(db, growing, '글'.repeat(480) + index, true, null);
  }
  assert.equal((await wishlistSnapshot(growing).get()).get('payload'), null);
  const all = await listOwnWishlist(db, growing);
  assert.equal(all.length, 370);
  assert.ok(all.some(({ saved, workId }) => !saved && workId === '한'.repeat(480) + '0'));

  const many = randomUUID();
  const count = WISHLIST_SNAPSHOT_ROW_LIMIT + 2;
  await seed(many, count, 'short-');
  assert.equal((await listOwnWishlist(db, many)).length, count);
  assert.equal((await wishlistSnapshot(many).get()).get('payload'), null);
});

test('public reviews scan beyond the display limit and pin visibility and aliases to one server snapshot', async (t) => {
  const previousPerf = process.env.MY_PAGE_PERF_LOG;
  process.env.MY_PAGE_PERF_LOG = '1';
  t.after(() => { if (previousPerf === undefined) delete process.env.MY_PAGE_PERF_LOG; else process.env.MY_PAGE_PERF_LOG = previousPerf; });
  const timing = t.mock.method(console, 'info', () => {});
  const uid = randomUUID();
  const workId = randomUUID();
  const alias = randomUUID();
  const account = await ensureAccount(db, uid);
  const shown = await changeAccount(uid, account, { reviews: true, wishlist: true });
  // Seed enough public rows to cross the scan page boundary.
  const batch = db.batch();
  const baseTime = Date.now() - 1_000_000;
  const codePrefix = randomUUID().slice(0, 5).toUpperCase();
  for (let index = 0; index < 101; index += 1) {
    const code = `${codePrefix}${index.toString(8).padStart(3, '0')}`;
    batch.create(db.collection('publicReaderProfilesV1').doc(code), {
      uid: randomUUID(), nickname: `Reader ${index}`, revision: 1, visibility: { ...visibility, reviews: true },
    });
    batch.create(entries(workId).doc(code), {
      code, workId, ...review(index < 20 ? 5 : 2),
      publishedAt: Timestamp.fromMillis(baseTime - index),
    });
  }
  batch.create(entries(workId).doc('anonymous-legacy'), {
    ...review(1), publishedAt: Timestamp.fromMillis(baseTime + 1),
  });
  const malformedCode = `${codePrefix}777`;
  batch.create(db.collection('publicReaderProfilesV1').doc(malformedCode), {
    uid: randomUUID(), nickname: 'Malformed visibility', revision: 1, visibility: { reviews: true },
  });
  batch.create(entries(alias).doc(malformedCode), {
    code: malformedCode, workId: alias, ...review(5), publishedAt: Timestamp.fromMillis(baseTime),
  });
  await batch.commit();
  await updateReview(db, uid, workId, review(4), null);
  await updateReview(db, uid, alias, review(1), null);

  const initial = await workPublicReviews(db, workId);
  assert.equal(initial.reviews.length, 20);
  assert.equal(initial.ratingCount, 102);
  assert.equal(initial.average, (20 * 5 + 81 * 2 + 4) / 102);

  const originalRunTransaction = db.runTransaction.bind(db);
  let toggled = false;
  let profileReads = 0;
  const mock = t.mock.method(db, 'runTransaction', async (callback, options) => {
    if (options?.readTime && !toggled) {
      toggled = true;
      await changeAccount(uid, shown, { wishlist: true });
    }
    return originalRunTransaction(async (transaction) => {
      const getAll = transaction.getAll.bind(transaction);
      transaction.getAll = (...args) => {
        profileReads += args.filter((ref) => ref.id === shown.code).length;
        return getAll(...args);
      };
      return callback(transaction);
    }, options);
  });
  let pinned;
  try {
    pinned = await workPublicReviews(db, workId, [alias, workId, alias]);
  } finally {
    mock.mock.restore();
  }
  assert.ok(toggled);
  assert.equal(profileReads, 1, 'both alias entries share the same author read at the pinned visibility snapshot');
  assert.deepEqual(pinned.reviews[0], {
    author: { code: shown.code, nickname: shown.nickname }, ...review(1),
  });
  assert.equal(pinned.ratingCount, 102);
  assert.equal(pinned.average, (20 * 5 + 81 * 2 + 1) / 102);
  const [label, metrics] = timing.mock.calls.at(-1).arguments;
  assert.equal(label, '[MyPagePerformance]');
  const { durationMs, reviewQueryMs, authorReadMs, ...counts } = metrics;
  assert.ok(durationMs >= 0 && reviewQueryMs > 0 && authorReadMs > 0);
  assert.deepEqual(counts, {
    route: 'book-reviews', workCount: 2, reviewRows: 105, validReviewRows: 104, visibleReviewRows: 103,
    reviewQueries: 3, emptyReviewQueries: 0, authorReads: 103, authorBatches: 3, ratingCount: 102, returned: 20,
  });

  const fresh = await workPublicReviews(db, workId, [alias]);
  assert.equal(fresh.reviews.length, 20);
  assert.ok(fresh.reviews.every(({ author }) => author.code !== shown.code));
  assert.equal(fresh.ratingCount, 101);
  assert.equal(fresh.average, (20 * 5 + 81 * 2) / 101);
  assert.deepEqual(await workPublicReviews(db, alias), { reviews: [], ratingCount: 0, average: null });
  assert.deepEqual(await workPublicReviews(db, randomUUID()), { reviews: [], ratingCount: 0, average: null });
  const [, empty] = timing.mock.calls.at(-1).arguments;
  assert.equal(empty.reviewQueries, 1);
  assert.equal(empty.emptyReviewQueries, 1);
  assert.equal(empty.authorBatches, 0);
});
