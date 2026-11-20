import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerHooks } from 'node:module';
import { deleteApp, getApps } from 'firebase-admin/app';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';

assert.ok(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Auth and Firestore emulators required');
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'demo-web-reader';
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === 'server-only' ? 'next/dist/compiled/server-only/empty.js' : specifier, context);
  },
});
const unwrap = (module) => module.default ?? module;
const { workAsyncStorage } = unwrap(await import('next/dist/server/app-render/work-async-storage.external.js'));
const { workUnitAsyncStorage } = unwrap(await import('next/dist/server/app-render/work-unit-async-storage.external.js'));
const { GET, POST } = unwrap(await import('../src/app/api/mypage/route.ts'));
const { GET: getBookReviews } = unwrap(await import('../src/app/api/book-reviews/route.ts'));
const { getAdminFirestore } = unwrap(await import('../src/server/firebaseAdmin.ts'));
const { loadSocialCatalog } = unwrap(await import('../src/server/mypage/catalog.ts'));
const { parseBookMetadataRefreshRequest } = unwrap(await import('../src/server/bookMetadata/requestSchema.ts'));
const { platformWorkKey } = unwrap(await import('../src/lib/readBooks.ts'));
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

test('an on-demand title uses its published edition across account review saves and reloads', async () => {
  const db = getAdminFirestore();
  const { idToken, localId: uid } = await emulatorLogin('mypage-on-demand');
  const { idToken: secondDevice } = await emulatorLogin('mypage-on-demand', 'signInWithPassword');
  const catalog = await loadSocialCatalog();
  const work = [...catalog.values()].find(({ platforms }) => platforms.length > 0);
  const other = [...catalog.values()].find(({ id, platforms }) => id !== work.id && platforms.length > 0);
  const [{ id: platform, url }] = work.platforms;
  const key = platformWorkKey(platform, url);
  const unknownKey = platformWorkKey(platform, 'https://example.test/unpublished-edition');
  const { fileName, aliasId, queryTitle } = parseBookMetadataRefreshRequest({ fileName: '테스트 요청 별칭 작품 001-050.txt' });
  assert.notEqual(queryTitle, fileName);
  assert.notEqual(queryTitle, work.id);
  assert.ok(!catalog.has(queryTitle));
  await db.collection('publicBookMetadataOnDemandV1').doc(aliasId).set({
    schemaVersion: 1, status: 'ready', aliasId, queryTitle, platforms: [{ platform, url }],
  });
  await db.doc('artifacts/' + APP_ID + '/users/' + uid + '/libraries/local/readingStatsV1/on-demand-session').set({
    schemaVersion: 1, sessionId: 'on-demand-session', bookId: 'alias-file', bookTitle: fileName, deviceId: 'alias-device',
    mode: 'screen', startedAtClient: 1000, endedAtClient: 61000, durationMs: 60000, startProgressPercent: 2, endProgressPercent: 52,
    timezoneOffsetMinutes: 0, localDate: '1970-01-01', completed: false,
  });
  const input = { workId: queryTitle, platformWorkKeys: [key, unknownKey], rating: 3, comment: '', revision: null, fileIds: ['alias-file'] };
  const conflictingKeys = [key, platformWorkKey(other.platforms[0].id, other.platforms[0].url)];
  assert.equal((await post('review', idToken, { ...input, platformWorkKeys: conflictingKeys })).status, 404);
  const saved = (await ok(post('review', idToken, input))).review;
  assert.equal(saved.workId, work.id);
  assert.equal(saved.totalMs, 60000);
  assert.equal(saved.progressPercent, 52);

  const reloaded = (await ok(get({ view: 'reviews' }, secondDevice))).reviews[0];
  assert.equal(reloaded.workId, work.id);
  assert.ok(reloaded.platformWorkKeys.includes(key));
  assert.ok(!reloaded.aliases.includes(queryTitle));

  const { review: updated } = await ok(post('review', secondDevice, {
    workId: reloaded.workId, revision: reloaded.revision, rating: 5, comment: '수정', fileIds: ['alias-file'],
  }));
  assert.equal(updated.rating, 5);
  assert.equal(updated.workId, work.id);
  await ok(post('review', secondDevice, { workId: updated.workId, revision: updated.revision, remove: true }));
  const deleted = await ok(get({ view: 'reviews' }, idToken));
  assert.deepEqual(deleted.reviews, []);
  assert.equal(deleted.deletions[0].workId, work.id);
  assert.ok(deleted.deletions[0].platformWorkKeys.includes(key));
  const restored = (await ok(post('review', idToken, {
    ...input, workId: work.id, revision: deleted.deletions[0].revision,
  }))).review;
  assert.equal(restored.workId, work.id);
});

test('an edit preserves verified private and public reading evidence when session lookup fails', async (t) => {
  const db = getAdminFirestore();
  const { idToken, localId: uid } = await emulatorLogin('mypage-evidence-failure');
  const { code, nickname, visibility, revision } = await ok(get({ view: 'account' }, idToken));
  await ok(post('account', idToken, { nickname, visibility: { ...visibility, reviews: true }, revision }));
  const workId = (await loadSocialCatalog()).values().next().value.id;
  const collection = 'artifacts/' + APP_ID + '/users/' + uid + '/libraries/local/readingStatsV1';
  await db.doc(collection + '/evidence-session').set({
    schemaVersion: 1, sessionId: 'evidence-session', bookId: 'evidence-file', bookTitle: workId, deviceId: 'evidence-device',
    mode: 'screen', startedAtClient: 1000, endedAtClient: 61000, durationMs: 60000, startProgressPercent: 0, endProgressPercent: 55,
    timezoneOffsetMinutes: 0, localDate: '1970-01-01', completed: false,
  });
  const input = { workId, rating: 3, comment: '', revision: null, fileIds: ['evidence-file'] };
  const saved = (await ok(post('review', idToken, input))).review;
  assert.equal(saved.totalMs, 60000);
  assert.equal(saved.progressPercent, 55);
  let blocked = false;
  const originalCollection = db.collection.bind(db);
  const collectionMock = t.mock.method(db, 'collection', (path) => {
    if (path === collection) { blocked = true; throw new Error('Temporary session read failure'); }
    return originalCollection(path);
  });
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now + 31_000);
  try {
    const edited = (await ok(post('review', idToken, {
      ...input, rating: 5, comment: '기존 독서기록을 보존', revision: saved.revision,
    }))).review;
    assert.equal(blocked, true);
    assert.equal(edited.rating, 5);
    assert.equal(edited.totalMs, 60000);
    assert.equal(edited.progressPercent, 55);
  } finally {
    clock.mock.restore();
    collectionMock.mock.restore();
  }
  const own = (await ok(get({ view: 'reviews' }, idToken))).reviews[0];
  const visible = (await workReviews(workId)).reviews.find(({ author }) => author.code === code);
  for (const review of [own, visible]) {
    assert.equal(review.rating, 5);
    assert.equal(review.totalMs, 60000);
    assert.equal(review.progressPercent, 55);
  }
});

test('local review reading saves immediately and missing reading fills after the response without overwriting newer edits', async (t) => {
  const db = getAdminFirestore();
  const { idToken, localId: uid } = await emulatorLogin('mypage-local-first');
  const { code, nickname, visibility, revision } = await ok(get({ view: 'account' }, idToken));
  await ok(post('account', idToken, { nickname, visibility: { ...visibility, reviews: true }, revision }));
  const workId = (await loadSocialCatalog()).values().next().value.id;
  const collection = 'artifacts/' + APP_ID + '/users/' + uid + '/libraries/local/readingStatsV1';
  await db.doc(collection + '/fallback-session').set({
    schemaVersion: 1, sessionId: 'fallback-session', bookId: 'fallback-file', bookTitle: workId, deviceId: 'fixture-device',
    mode: 'screen', startedAtClient: 1000, endedAtClient: 61000, durationMs: 60000, startProgressPercent: 0, endProgressPercent: 55,
    timezoneOffsetMinutes: 0, localDate: '1970-01-01', completed: false,
  });
  let sessionQueries = 0;
  const originalCollection = db.collection.bind(db);
  t.mock.method(db, 'collection', (path) => {
    if (path === collection) sessionQueries++;
    return originalCollection(path);
  });
  // Direct route calls in the emulator have no HTTP response lifecycle.
  const deferred = [];
  const afterContext = { after: (task) => deferred.push(task) };
  const save = (fields) => workAsyncStorage.run({ afterContext }, () =>
    workUnitAsyncStorage.run({ type: 'request' }, () => ok(post('review', idToken, fields))));
  const input = { workId, rating: 4, comment: '', revision: null, fileIds: ['fallback-file'] };
  const local = { totalMs: 45000, progressPercent: 41 };
  assert.equal((await post('review', idToken, { ...input, readingSnapshot: { ...local, progressPercent: 101 } })).status, 400);
  const { review: initial } = await save({ ...input, readingSnapshot: local });
  assert.equal(initial.totalMs, local.totalMs);
  assert.equal(initial.progressPercent, local.progressPercent);
  assert.equal(sessionQueries, 0);
  assert.equal(deferred.length, 0);
  assert.equal((await workReviews(workId)).reviews.find(({ author }) => author.code === code).totalMs, local.totalMs);

  await ok(post('review', idToken, { workId, revision: initial.revision, remove: true }));
  const { deletions: [removed] } = await ok(get({ view: 'reviews' }, idToken));
  const { review: pending } = await save({ ...input, revision: removed.revision, readingSnapshot: null });
  assert.equal(pending.totalMs, null);
  assert.equal(sessionQueries, 0);
  assert.equal(deferred.length, 1);
  await deferred.shift()();
  assert.ok(sessionQueries > 0);
  const { reviews: [filled] } = await ok(get({ view: 'reviews' }, idToken));
  assert.equal(filled.revision, pending.revision);
  assert.equal(filled.totalMs, 60000);
  assert.equal((await workReviews(workId)).reviews.find(({ author }) => author.code === code).progressPercent, 55);

  const { review: beforeEdit } = await save({ ...input, revision: filled.revision, readingSnapshot: null });
  const { review: latest } = await save({ ...input, rating: 5, revision: beforeEdit.revision, readingSnapshot: local });
  await deferred.shift()();
  const { reviews: [reloaded] } = await ok(get({ view: 'reviews' }, idToken));
  assert.equal(reloaded.revision, latest.revision);
  assert.equal(reloaded.rating, 5);
  assert.equal(reloaded.totalMs, local.totalMs);
  assert.equal((await workReviews(workId)).reviews.find(({ author }) => author.code === code).progressPercent, local.progressPercent);
});

test('retry after a lost review response returns the saved revision without replacing a newer review', async () => {
  const { idToken } = await emulatorLogin('mypage-review-retry');
  const catalog = await loadSocialCatalog();
  const work = [...catalog.values()].find(({ coverUrl }) => coverUrl);
  const workId = work.id;
  const input = {
    workId, rating: 3, comment: '', revision: null, fileIds: [],
    readingSnapshot: { totalMs: 45000, progressPercent: 41 },
    saveId: crypto.randomUUID(),
  };
  const first = await ok(post('review', idToken, input));
  assert.equal(first.review.revision, 1);
  assert.deepEqual(await ok(post('review', idToken, input)), first);

  const newer = await ok(post('review', idToken, {
    ...input, saveId: crypto.randomUUID(), revision: first.review.revision, rating: 5,
  }));
  assert.equal(newer.review.revision, 2);
  assert.equal((await post('review', idToken, input)).status, 409);
  const { reviews: [current] } = await ok(get({ view: 'reviews' }, idToken));
  assert.equal(current.rating, 5);
  assert.equal(current.revision, 2);
  assert.equal('lastSaveId' in current, false);

  const oldWork = [...catalog.values()].find(({ id }) => id !== workId);
  const legacy = await ok(post('review', idToken, { ...input, workId: oldWork.id, saveId: crypto.randomUUID() }));
  await ok(post('review', idToken, { workId: oldWork.id, revision: legacy.review.revision, remove: true }));
  const preview = await ok(get({ view: 'reviews', preview: '1' }, idToken));
  assert.deepEqual(preview.deletions, []);
  assert.deepEqual(preview.reviews.map(({ workId, coverUrl, rating }) => ({ workId, coverUrl, rating })), [
    { workId, coverUrl: work.coverUrl, rating: 5 },
  ]);
});

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
