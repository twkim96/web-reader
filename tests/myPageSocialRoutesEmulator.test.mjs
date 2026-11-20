import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { deleteApp, getApps } from 'firebase-admin/app';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';

assert.ok(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Auth and Firestore emulators required');
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'demo-web-reader';
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'server-only' ? 'next/dist/compiled/server-only/empty.js' : specifier, context);
  },
});
const unwrap = (module) => module.default ?? module;
const { GET, POST } = unwrap(await import('../src/app/api/mypage/route.ts'));
const { GET: getBookReviews } = unwrap(await import('../src/app/api/book-reviews/route.ts'));
const { getAdminFirestore } = unwrap(await import('../src/server/firebaseAdmin.ts'));
const { loadSocialCatalog } = unwrap(await import('../src/server/mypage/catalog.ts'));
const { APP_ID } = unwrap(await import('../src/lib/appIdentity.ts'));

const base = 'http://localhost/api/mypage';
const get = (params, token) => GET(new Request(base + '?' + new URLSearchParams(params), {
  headers: token ? { Authorization: 'Bearer ' + token } : {},
}));
const post = (action, token, body) => POST(new Request(base + '?' + new URLSearchParams({ action }), {
  method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));
async function emulatorLogin(label, operation = 'signUp') {
  const url = 'http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST + '/identitytoolkit.googleapis.com/v1/accounts:' + operation + '?key=demo';
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: label + '@example.test', password: 'fixture-password-for-emulator', returnSecureToken: true }),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function ok(response) {
  const result = await response;
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal(result.headers.get('cache-control'), 'no-store');
  return result.json();
}
const workReviews = (workId) => ok(getBookReviews(new Request('http://localhost/api/book-reviews?' + new URLSearchParams({ workId }))));
after(async () => { await Promise.all(getApps().map((app) => deleteApp(app))); });

test('authenticated account writes, code search and every visibility combination share one public contract', async () => {
  const db = getAdminFirestore();
  const { idToken: alice, localId: uid } = await emulatorLogin('mypage-alice');
  const { idToken: secondDevice } = await emulatorLogin('mypage-alice', 'signInWithPassword');
  const { idToken: bob } = await emulatorLogin('mypage-bob');
  const catalog = await loadSocialCatalog();
  const [aliasId, work] = [...catalog].find(([id, book]) => id !== book.id);
  assert.equal((await get({ view: 'account' })).status, 401);
  let account = await ok(get({ view: 'account' }, alice));
  assert.match(account.code, /^[0-9A-Z]{8}$/);
  assert.equal((await get({ view: 'profile', code: account.code })).status, 404);
  assert.deepEqual((await ok(get({ view: 'people', q: account.code }))).people, []);
  await ok(post('wishlist', alice, { workId: aliasId, saved: true, revision: null }));
  const saved = (await ok(get({ view: 'wishlist' }, secondDevice))).entries[0];
  assert.equal(saved.book.id, work.id);
  assert.ok(saved.aliases.includes(aliasId));
  assert.deepEqual((await ok(get({ view: 'wishlist', uid }, bob))).entries, []);
  assert.equal((await post('wishlist', alice, { workId: work.id, saved: true, revision: null })).status, 409);
  await db.doc('artifacts/' + APP_ID + '/users/' + uid + '/libraries/local/readingStatsV1/fixture-session').set({
    schemaVersion: 1, sessionId: 'fixture-session', bookId: 'nonpublic-file', bookTitle: work.id, deviceId: 'nonpublic-device',
    mode: 'screen', startedAtClient: 1000, endedAtClient: 61000, durationMs: 60000, startProgressPercent: 2, endProgressPercent: 52,
    timezoneOffsetMinutes: 0, localDate: '1970-01-01', completed: false,
  });
  const { review } = await ok(post('review', alice, {
    workId: aliasId, rating: 4, comment: '', revision: null, fileIds: ['nonpublic-file'], totalMs: 123,
  }));
  assert.equal(review.totalMs, 60_000);
  assert.equal(review.progressPercent, 52);
  assert.equal((await ok(get({ view: 'reviews' }, secondDevice))).reviews[0].rating, 4);
  assert.deepEqual(await workReviews(work.id), { reviews: [], average: null, ratingCount: 0 });

  const code = account.code;
  for (let flags = 0; flags < 8; flags++) {
    const visibility = { reviews: Boolean(flags & 1), reading: Boolean(flags & 2), wishlist: Boolean(flags & 4) };
    account = await ok(post('account', alice, { code: '11111111', nickname: '행복한도서인', visibility, revision: account.revision }));
    assert.equal(account.code, code);
    if (flags === 0) assert.equal((await get({ view: 'profile', code })).status, 404);
    else {
      const profile = await ok(get({ view: 'profile', code }));
      assert.equal('reviews' in profile, visibility.reviews);
      assert.equal('reading' in profile, visibility.reading);
      assert.equal('wishlist' in profile, visibility.wishlist);
      assert.ok(!JSON.stringify(profile).includes('nonpublic-file'));
      assert.ok(!JSON.stringify(profile).includes(uid));
      if (visibility.reading) assert.equal(profile.reading[0].workId, work.id);
    }
    const publicReviews = await workReviews(aliasId);
    assert.equal(publicReviews.ratingCount, visibility.reviews ? 1 : 0);
    assert.equal(publicReviews.average, visibility.reviews ? 4 : null);
    if (visibility.reviews) assert.deepEqual(publicReviews.reviews[0].author, { code, nickname: '행복한도서인' });
  }
  const people = await ok(get({ view: 'people', q: '행복한도서인#' + code }));
  assert.equal(people.people[0].code, code);
  const revoked = await ok(post('account', alice, {
    nickname: '행복한도서인', visibility: { reviews: false, reading: false, wishlist: false }, revision: account.revision,
  }));
  assert.equal((await get({ view: 'profile', code })).status, 404);
  assert.deepEqual(await workReviews(aliasId), { reviews: [], average: null, ratingCount: 0 });
  assert.equal((await ok(get({ view: 'reviews' }, alice))).reviews[0].rating, 4);
  assert.equal((await post('import-wishlist', alice, { accountRevision: account.revision, workIds: [work.id] })).status, 409);
  await ok(post('wishlist', alice, { workId: work.id, saved: false, revision: saved.item.revision }));
  await ok(post('import-wishlist', alice, { accountRevision: revoked.revision, workIds: [work.id] }));
  assert.equal((await post('wishlist', secondDevice, { workId: aliasId, saved: true, revision: null })).status, 409);
  const removedWishlist = (await ok(get({ view: 'wishlist' }, secondDevice))).entries[0];
  assert.equal(removedWishlist.item.saved, false);
  await ok(post('wishlist', secondDevice, { workId: removedWishlist.item.workId, saved: true, revision: removedWishlist.item.revision }));
  assert.equal((await ok(get({ view: 'wishlist' }, alice))).entries[0].item.saved, true);

  const publicAgain = await ok(post('account', alice, {
    nickname: revoked.nickname, visibility: { ...revoked.visibility, reviews: true }, revision: revoked.revision,
  }));
  assert.equal(publicAgain.visibility.reviews, true);
  assert.equal((await workReviews(work.id)).ratingCount, 1);
  await db.doc('artifacts/' + APP_ID + '/users/' + uid + '/libraries/local/readingStatsV1/fixture-session').delete();
  const ownReview = (await ok(get({ view: 'reviews' }, secondDevice))).reviews[0];
  assert.equal(ownReview.title, work.title);
  await ok(post('review', secondDevice, { workId: ownReview.workId, revision: ownReview.revision, remove: true }));
  const stale = { workId: work.id, rating: 5, comment: '', revision: null, fileIds: [] };
  assert.equal((await post('review', alice, stale)).status, 409);
  const own = await ok(get({ view: 'reviews' }, alice));
  assert.equal(own.reviews.length, 0);
  assert.equal(own.deletions[0].workId, work.id);
  assert.deepEqual(await workReviews(work.id), { reviews: [], average: null, ratingCount: 0 });
  const restored = await ok(post('review', alice, { ...stale, revision: own.deletions[0].revision }));
  assert.equal(restored.review.rating, 5);
  assert.equal((await workReviews(work.id)).average, 5);

  const otherWork = [...catalog.values()].find((entry) => entry.id !== work.id);
  const platformKey = ({ platforms: [entry] }) => JSON.stringify([entry.id, entry.url]);
  const bobAccount = await ok(get({ view: 'account' }, bob));
  const legacyReviews = [
    { workIds: [work.id], platformWorkKeys: [platformKey(work)], rating: 4, comment: '첫 번째 작품' },
    { workIds: [work.id], platformWorkKeys: [platformKey(otherWork)], rating: 2, comment: '두 번째 작품' },
    { workIds: [work.id], platformWorkKeys: [platformKey(work), platformKey(otherWork)], rating: 1, comment: '모호한 작품' },
  ];
  const importBody = { accountRevision: bobAccount.revision, reviews: legacyReviews };
  const imported = await ok(post('import-reviews', bob, importBody));
  assert.deepEqual(imported, { current: 2, unavailable: 1, kept: 0 });
  const importedReviews = new Map((await ok(get({ view: 'reviews' }, bob))).reviews.map(({ workId, comment }) => [workId, comment]));
  assert.deepEqual(importedReviews, new Map([[work.id, '첫 번째 작품'], [otherWork.id, '두 번째 작품']]));
  assert.deepEqual(await ok(post('import-reviews', bob, importBody)), { current: 0, unavailable: 1, kept: 2 });

  const client = await initializeTestEnvironment({ projectId: 'demo-web-reader' });
  try {
    const firestore = client.authenticatedContext(uid).firestore();
    await assertFails(getDoc(doc(firestore, 'publicReaderProfilesV1', code)));
    await assertFails(setDoc(doc(firestore, 'publicReaderProfilesV1', code), { nickname: 'tampered' }));
    await assertFails(getDoc(doc(firestore, 'artifacts', APP_ID, 'users', uid, 'libraries', 'local', 'myPageSharingV1', 'settings')));
  } finally { await client.cleanup(); }
});
