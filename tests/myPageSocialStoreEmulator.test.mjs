import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { MY_PAGE_CODE } from '../src/lib/myPageSocial.ts';
import {
  ConflictError,
  ensureAccount,
  listReviews,
  listWishlist,
  lookupPublicAccount,
  readReview,
  searchPeople,
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

const visibility = { reviews: false, wishlist: false, reading: false };
const review = (rating, comment = '') => ({ rating, comment, totalMs: null, progressPercent: null });
const entries = (workId) => db.collection('publicBookReviewsV1')
  .doc(createHash('sha256').update(workId).digest('hex')).collection('entries');
const changeAccount = (uid, account, flags, nickname = account.nickname) => updateAccount(db, uid, {
  nickname, visibility: { ...visibility, ...flags }, revision: account.revision,
});

test('code collision retries, rename retains identity, and only opted-in accounts are discoverable', async (t) => {
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
  assert.deepEqual(initial.visibility, visibility);
  assert.deepEqual(await searchPeople(db, initial.code.toLowerCase()), []);
  assert.equal(await lookupPublicAccount(db, initial.code), null);

  const suffix = randomUUID().slice(0, 8);
  const nickname = `Café${suffix}😀`;
  const shown = await changeAccount(uid, initial, { reading: true }, nickname);
  const otherShown = await changeAccount(otherUid, other, { wishlist: true }, nickname);
  const identity = { code: initial.code, nickname };
  assert.deepEqual(await lookupPublicAccount(db, `#${initial.code.toLowerCase()}`), { uid, account: shown });
  assert.deepEqual(await searchPeople(db, `#${initial.code.toLowerCase()}`), [identity]);
  const people = await searchPeople(db, `CAFE\u0301${suffix}`);
  assert.deepEqual(people.map(({ code }) => code).sort(), [shown.code, otherShown.code].sort());
  assert.ok(people.every(({ nickname: name }) => name === nickname));
  assert.ok(people.every((person) => Object.keys(person).sort().join(',') === 'code,nickname'));

  await assert.rejects(changeAccount(uid, initial, { reviews: true }), ConflictError);
  const renamed = await changeAccount(uid, shown, { reviews: true }, `Renamed${suffix}`);
  assert.equal(renamed.code, initial.code);
  assert.deepEqual(await searchPeople(db, initial.code), [{ code: initial.code, nickname: renamed.nickname }]);
  assert.deepEqual(await searchPeople(db, nickname), [{ code: otherShown.code, nickname }]);
  await changeAccount(uid, renamed, {});
  assert.deepEqual(await searchPeople(db, renamed.nickname), []);
  assert.equal(await lookupPublicAccount(db, initial.code), null);
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

test('public reviews scan beyond the display limit and pin visibility and aliases to one server snapshot', async (t) => {
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
  await batch.commit();
  await updateReview(db, uid, workId, review(4), null);
  await updateReview(db, uid, alias, review(1), null);

  const initial = await workPublicReviews(db, workId);
  assert.equal(initial.reviews.length, 20);
  assert.equal(initial.ratingCount, 102);
  assert.equal(initial.average, (20 * 5 + 81 * 2 + 4) / 102);

  const originalRunTransaction = db.runTransaction.bind(db);
  let toggled = false;
  const mock = t.mock.method(db, 'runTransaction', async (callback, options) => {
    if (options?.readTime && !toggled) {
      toggled = true;
      await changeAccount(uid, shown, { wishlist: true });
    }
    return originalRunTransaction(callback, options);
  });
  let pinned;
  try {
    pinned = await workPublicReviews(db, workId, [alias, workId, alias]);
  } finally {
    mock.mock.restore();
  }
  assert.ok(toggled);
  assert.deepEqual(pinned.reviews[0], {
    author: { code: shown.code, nickname: shown.nickname }, ...review(1),
  });
  assert.equal(pinned.ratingCount, 102);
  assert.equal(pinned.average, (20 * 5 + 81 * 2 + 1) / 102);

  const fresh = await workPublicReviews(db, workId, [alias]);
  assert.equal(fresh.reviews.length, 20);
  assert.ok(fresh.reviews.every(({ author }) => author.code !== shown.code));
  assert.equal(fresh.ratingCount, 101);
  assert.equal(fresh.average, (20 * 5 + 81 * 2) / 101);
  assert.deepEqual(await workPublicReviews(db, alias), { reviews: [], ratingCount: 0, average: null });
});
