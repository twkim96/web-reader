import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { deleteApp, getApps } from 'firebase-admin/app';
import { GrpcStatus, Timestamp } from 'firebase-admin/firestore';
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
const { loadSocialCatalog, resolveSocialWork } = unwrap(await import('../src/server/mypage/catalog.ts'));
const { parseBookMetadataRefreshRequest } = unwrap(await import('../src/server/bookMetadata/requestSchema.ts'));
const { platformWorkKey } = unwrap(await import('../src/lib/readBooks.ts'));
const { getPublicBookMetadataAliasCandidates } = unwrap(await import('../src/lib/publicBookMetadataSchema.ts'));
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

test('public profile sorts all visible reviews before selecting a page', async () => {
  const { idToken, localId: uid } = await emulatorLogin('mypage-public-review-sort');
  const account = await ok(get({ view: 'account' }, idToken));
  const works = [...new Set((await loadSocialCatalog()).values())].slice(0, 31);
  assert.equal(works.length, 31);
  const db = getAdminFirestore();
  const collection = db.collection(`artifacts/${APP_ID}/users/${uid}/libraries/local/myPageReviewsV1`);
  const batch = db.batch();
  works.forEach(({ id }, index) => batch.set(collection.doc(`sort-${index}`), {
    workId: id, revision: 1, rating: index === 0 ? 5 : 2, comment: '', totalMs: null, progressPercent: null,
    deleted: false, updatedAt: Timestamp.fromMillis((index + 1) * 1000),
  }));
  await batch.commit();

  const params = { view: 'profile', code: account.code, section: 'reviews' };
  const recent = await ok(get(params));
  assert.equal(recent.reviews[0].workId, works[30].id);
  assert.equal(recent.reviews.length, 30);
  assert.equal(recent.next.reviews, 30);
  assert.ok(!recent.reviews.some(({ workId }) => workId === works[0].id));

  const highest = await ok(get({ ...params, reviewSort: 'rating-desc' }));
  assert.equal(highest.reviews[0].workId, works[0].id);
  const rest = await ok(get({ ...params, reviewSort: 'rating-desc', offset: String(highest.next.reviews) }));
  assert.equal(rest.next.reviews, null);
  assert.equal(new Set([...highest.reviews, ...rest.reviews].map(({ workId }) => workId)).size, 31);
  assert.equal((await get({ ...params, reviewSort: 'unsupported' })).status, 400);
});

test('public profile cursors survive removal of earlier rows and the boundary itself', async () => {
  const { idToken, localId: uid } = await emulatorLogin('profile-cursor-removal');
  const account = await ok(get({ view: 'account' }, idToken));
  const settings = await ok(post('account', idToken, {
    nickname: account.nickname, revision: account.revision, visibility: { reviews: true, wishlist: true },
  }));
  const works = [...new Set((await loadSocialCatalog()).values())].slice(0, 33);
  const db = getAdminFirestore();
  const library = db.doc(`artifacts/${APP_ID}/users/${uid}/libraries/local`);
  const collections = {
    reviews: library.collection('myPageReviewsV1'),
    wishlist: library.collection('myPageWishlistV1'),
  };
  const review = (workId, time) => ({
    workId, revision: 1, rating: 2.5, comment: '', totalMs: null, progressPercent: null,
    deleted: false, updatedAt: Timestamp.fromMillis(time),
  });
  const wishlist = (workId, time) => ({ workId, saved: true, revision: 1, addedAt: time });
  const entriesFor = { reviews: review, wishlist };
  const batch = db.batch();
  const ids = new Map();
  works.slice(0, 32).forEach(({ id }, index) => {
    ids.set(id, `row-${index}`);
    for (const section of ['reviews', 'wishlist']) {
      batch.set(collections[section].doc(ids.get(id)), entriesFor[section](id, 1000));
    }
  });
  await batch.commit();

  const base = { view: 'profile', code: account.code, pagination: 'cursor', reviewSort: 'rating-desc' };
  const first = await ok(get(base));
  const client = await initializeTestEnvironment({ projectId: 'demo-web-reader' });
  try {
    for (const context of [client.unauthenticatedContext(), client.authenticatedContext(uid)]) {
      const ref = doc(context.firestore(), 'serverSecretsV1', 'myPageProfileCursor');
      await assertFails(getDoc(ref));
      await assertFails(setDoc(ref, { key: 'new-key' }));
    }
  } finally {
    await client.cleanup();
  }
  const expected = works.slice(0, 32).map(({ id }) => id)
    .sort((a, b) => a.localeCompare(b) || Number(a > b) - Number(a < b));
  const changes = db.batch();
  for (const section of ['reviews', 'wishlist']) {
    assert.deepEqual(first[section].map(({ workId }) => workId), expected.slice(0, 30));
    assert.equal(typeof first.next[section], 'string');
    assert.throws(() => JSON.parse(Buffer.from(first.next[section], 'base64url').toString('utf8')));
    const collection = collections[section];
    for (const row of [first[section][0], first[section].at(-1)]) {
      changes.update(collection.doc(ids.get(row.workId)), section === 'reviews' ? { deleted: true } : { saved: false });
    }
    changes.set(collection.doc('newer-row'), entriesFor[section](works[32].id, 2000));
  }
  await changes.commit();

  for (const section of ['reviews', 'wishlist']) {
    const params = { ...base, section, cursor: first.next[section] };
    const rest = await ok(get({ ...params, reviewSort: section === 'wishlist' ? 'recent' : 'rating-desc' }));
    assert.deepEqual(rest[section].map(({ workId }) => workId), expected.slice(30));
    assert.equal(rest.next[section], null);
    assert.equal((await get({ ...params, cursor: 'invalid' })).status, 400);
    const tampered = (params.cursor[0] === 'A' ? 'B' : 'A') + params.cursor.slice(1);
    assert.equal((await get({ ...params, cursor: tampered })).status, 400);
    assert.equal((await get({ ...params, offset: '30' })).status, 400);
    assert.equal((await get({ ...params, section: section === 'reviews' ? 'wishlist' : 'reviews' })).status, 400);
    assert.equal((await get({ ...params, code: account.code === '00000000' ? '00000001' : '00000000' })).status, 400);
  }
  assert.equal((await get({ ...base, section: 'reviews', cursor: first.next.reviews, reviewSort: 'rating-asc' })).status, 400);

  await ok(post('account', idToken, {
    nickname: account.nickname, revision: settings.revision, visibility: { reviews: false, wishlist: true },
  }));
  assert.equal((await get({ ...base, section: 'reviews', cursor: first.next.reviews })).status, 409);
  assert.equal((await ok(get(base))).reviews, undefined);
});

test('public profile chooses one newest evaluation per canonical work before paging', async () => {
  const { idToken, localId: uid } = await emulatorLogin('profile-canonical-alias');
  const account = await ok(get({ view: 'account' }, idToken));
  const catalog = await loadSocialCatalog();
  const [alias, work] = [...catalog].find(([id, book]) => id !== book.id);
  const otherWorks = [...new Set(catalog.values())].filter(({ id }) => id !== work.id).slice(0, 30);
  assert.equal(otherWorks.length, 30);
  const db = getAdminFirestore();
  const reviews = db.collection(`artifacts/${APP_ID}/users/${uid}/libraries/local/myPageReviewsV1`);
  const add = (workId, rating, comment, updatedAt) => ({
    workId, revision: 1, rating, comment, totalMs: null, progressPercent: null,
    deleted: false, updatedAt,
  });
  const batch = db.batch();
  otherWorks.forEach(({ id }, index) => batch.set(reviews.doc(`other-${index}`), add(id, 3, '', Timestamp.fromMillis(1000))));
  batch.set(reviews.doc('canonical'), add(work.id, 5, '이전 평가', new Timestamp(2, 321000000)));
  batch.set(reviews.doc('alias'), add(alias, 1.5, '최신 평가', new Timestamp(2, 321999000)));
  await batch.commit();

  const params = { view: 'profile', code: account.code, section: 'reviews', pagination: 'cursor' };
  const recent = await ok(get(params));
  assert.equal(recent.reviews[0].workId, work.id);
  assert.equal(recent.reviews.filter(({ workId }) => workId === work.id).length, 1);
  assert.equal(recent.reviews[0].comment, '최신 평가');
  const ranked = await ok(get({ ...params, reviewSort: 'rating-desc' }));
  assert.deepEqual(new Set(ranked.reviews.map(({ workId }) => workId)), new Set(otherWorks.map(({ id }) => id)));
  const last = await ok(get({ ...params, reviewSort: 'rating-desc', cursor: ranked.next.reviews }));
  assert.deepEqual(last.reviews.map(({ workId, rating, comment }) => ({ workId, rating, comment })), [
    { workId: work.id, rating: 1.5, comment: '최신 평가' },
  ]);
  assert.equal(last.next.reviews, null);
});

test('concurrent catalog aliases share a cold bucket read and can retry a failed read', async (t) => {
  const db = getAdminFirestore();
  const catalog = await loadSocialCatalog();
  const work = catalog.values().next().value;
  const title = '병렬버킷재시도테스트'.normalize('NFC');
  const [candidate] = getPublicBookMetadataAliasCandidates(title);
  const hash = createHash('sha256').update(candidate).digest('hex');
  assert.ok(!catalog.has(title));
  const ref = db.collection('publicBookMetadataV1').doc(hash.slice(0, 2));
  await ref.set({
    schemaVersion: 1, entries: { [hash]: {
      schemaVersion: 1, titleKey: work.id, displayTitle: work.title,
      normalizerVersion: '1.3.3', publishedAt: new Date().toISOString(), platforms: [],
    } },
  }, { merge: true });

  const prototype = Object.getPrototypeOf(ref);
  const original = prototype.get;
  let reads = 0;
  t.mock.method(prototype, 'get', function (...args) {
    if (this.isEqual(ref) && ++reads === 1) return Promise.reject(new Error('fixture bucket read failure'));
    return original.apply(this, args);
  });
  const lookups = () => Array.from({ length: 12 }, () => resolveSocialWork(db, title));
  const first = await Promise.allSettled(lookups());
  assert.ok(first.every(({ status }) => status === 'rejected'));
  assert.equal(reads, 1);
  const recovered = await Promise.all(lookups());
  assert.deepEqual(recovered.map(({ book }) => book.id), Array(12).fill(work.id));
  assert.equal(reads, 2);
});

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
  assert.equal((await post('review', idToken, { ...input, workId: work.id, platformWorkKeys: [unknownKey] })).status, 404);
  const saved = (await ok(post('review', idToken, input))).review;
  assert.equal(saved.workId, work.id);
  assert.equal(saved.totalMs, 60000);
  assert.equal(saved.progressPercent, 52);
  const staleKey = platformWorkKey(other.platforms[0].id, other.platforms[0].url);
  assert.equal((await post('review', idToken, { ...input, workId: other.id, detailWorkId: work.id,
    revision: null, platformWorkKeys: [staleKey] })).status, 404);
  assert.equal((await post('review', idToken, { ...input, workId: work.id, detailWorkId: work.id,
    revision: saved.revision, platformWorkKeys: [key, staleKey] })).status, 404);
  assert.equal((await post('review', idToken, { ...input, workId: work.id, revision: saved.revision, platformWorkKeys: [staleKey] })).status, 404);
  assert.equal((await post('review', idToken, { workId: work.id, revision: saved.revision, remove: true, platformWorkKeys: [staleKey] })).status, 404);
  assert.equal((await post('review', idToken, { workId: work.id, revision: saved.revision, remove: true, platformWorkKeys: [unknownKey] })).status, 404);

  const reloaded = (await ok(get({ view: 'reviews' }, secondDevice))).reviews[0];
  assert.equal(reloaded.workId, work.id);
  assert.ok(reloaded.platformWorkKeys.includes(key));
  assert.ok(!reloaded.aliases.includes(queryTitle));

  const { review: updated } = await ok(post('review', secondDevice, {
    workId: reloaded.workId, revision: reloaded.revision, rating: 5, comment: '수정', fileIds: ['alias-file'], platformWorkKeys: [key, unknownKey],
  }));
  assert.equal(updated.rating, 5);
  assert.equal(updated.workId, work.id);
  await ok(post('review', secondDevice, { workId: updated.workId, revision: updated.revision, remove: true }));
  const deleted = await ok(get({ view: 'reviews' }, idToken));
  assert.deepEqual(deleted.reviews, []);
  assert.equal(deleted.deletions[0].workId, work.id);
  assert.ok(deleted.deletions[0].platformWorkKeys.includes(key));
  assert.equal((await post('review', idToken, {
    ...input, workId: work.id, revision: deleted.deletions[0].revision, platformWorkKeys: [staleKey],
  })).status, 404);
  const restored = (await ok(post('review', idToken, {
    ...input, workId: work.id, revision: deleted.deletions[0].revision,
  }))).review;
  assert.equal(restored.workId, work.id);
  await ok(post('review', idToken, { workId: work.id, revision: restored.revision, remove: true, platformWorkKeys: [key, unknownKey] }));
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
  const { review: initial } = await save({ ...input, readingSnapshot: local, readingSnapshotVersion: 1 });
  assert.equal(initial.totalMs, local.totalMs);
  assert.equal(initial.progressPercent, local.progressPercent);
  assert.equal(sessionQueries, 0);
  assert.equal(deferred.length, 0);
  assert.equal((await workReviews(workId)).reviews.find(({ author }) => author.code === code).totalMs, local.totalMs);

  await ok(post('review', idToken, { workId, revision: initial.revision, remove: true }));
  const { deletions: [removed] } = await ok(get({ view: 'reviews' }, idToken));
  const retryInput = { ...input, revision: removed.revision, readingSnapshot: null, saveId: crypto.randomUUID() };
  const { review: pending } = await save(retryInput);
  assert.equal(pending.totalMs, null);
  assert.equal(sessionQueries, 0);
  assert.equal(deferred.length, 1);
  assert.equal((await save(retryInput)).review.revision, pending.revision);
  assert.equal(deferred.length, 1);
  await deferred.shift()();
  assert.ok(sessionQueries > 0);
  const { reviews: [filled] } = await ok(get({ view: 'reviews' }, idToken));
  assert.equal(filled.revision, pending.revision);
  assert.equal(filled.totalMs, 60000);
  assert.equal((await workReviews(workId)).reviews.find(({ author }) => author.code === code).progressPercent, 55);
  const queriesAfterFill = sessionQueries;
  assert.equal((await save(retryInput)).review.totalMs, 60000);
  assert.equal(deferred.length, 0);
  assert.equal(sessionQueries, queriesAfterFill);

  await ok(post('review', idToken, { workId, revision: filled.revision, remove: true }));
  const { deletions: [removedAgain] } = await ok(get({ view: 'reviews' }, idToken));
  const { review: beforeEdit } = await save({ ...input, revision: removedAgain.revision, readingSnapshot: null });
  const fullReading = { totalMs: 180_000, progressPercent: 80 };
  const { review: latest } = await save({
    ...input, rating: 5, revision: beforeEdit.revision, readingSnapshot: fullReading, readingSnapshotVersion: 1,
  });
  await deferred.shift()();
  assert.equal((await workReviews(workId)).reviews.find(({ author }) => author.code === code).progressPercent, 80);

  const { review: incompleteEdit } = await save({
    ...input, rating: 4.5, comment: '새 한줄평', revision: latest.revision, readingSnapshot: null,
  });
  assert.equal(incompleteEdit.totalMs, 180_000);
  assert.equal(incompleteEdit.progressPercent, 80);
  assert.equal(deferred.length, 0);

  // An older client can still request the synchronous fallback. Its smaller
  // verified server total must not replace the evidence already on the review.
  const { review: legacy } = await save({ ...input, rating: 3, revision: incompleteEdit.revision });
  const { review: staleClient } = await save({
    ...input, rating: 4, comment: '이전 PWA에서 수정', revision: legacy.revision,
    readingSnapshot: { totalMs: 60_000, progressPercent: 20 },
  });
  assert.equal(deferred.length, 0);
  const { reviews: [reloaded] } = await ok(get({ view: 'reviews' }, idToken));
  const published = (await workReviews(workId)).reviews.find(({ author }) => author.code === code);
  assert.equal(reloaded.revision, staleClient.revision);
  for (const review of [reloaded, published]) {
    assert.equal(review.rating, 4);
    assert.equal(review.comment, '이전 PWA에서 수정');
    assert.equal(review.totalMs, 180_000);
    assert.equal(review.progressPercent, 80);
  }
});

test('retry after a lost review response returns the saved revision without replacing a newer review', async () => {
  const { idToken } = await emulatorLogin('mypage-review-retry');
  const catalog = await loadSocialCatalog();
  const work = [...catalog.values()].find(({ coverUrl }) => coverUrl);
  const workId = work.id;
  const input = {
    workId, rating: 3, comment: '', revision: null, fileIds: [],
    readingSnapshot: { totalMs: 45000, progressPercent: 41 }, readingSnapshotVersion: 1,
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
  const previewParams = { view: 'reviews', preview: '1' };
  assert.equal((await get(previewParams, idToken)).headers.get('server-timing'), null);
  const unauthorized = await get({ ...previewParams, timing: '1' });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('server-timing'), null);
  const measured = await get({ ...previewParams, timing: '1' }, idToken);
  const timings = measured.headers.get('server-timing');
  assert.match(timings, /^auth;dur=[\d.]+, query;dur=[\d.]+, rows;desc="records=1", resolve;dur=[\d.]+, total;dur=[\d.]+$/);
  const preview = await ok(measured);
  assert.deepEqual(preview.deletions, []);
  assert.deepEqual(preview.reviews.map(({ workId, coverUrl, rating }) => ({ workId, coverUrl, rating })), [
    { workId, coverUrl: work.coverUrl, rating: 5 },
  ]);
});

test('authenticated account writes and both public visibility flags share one public contract', async () => {
  const db = getAdminFirestore();
  const { idToken: alice, localId: uid } = await emulatorLogin('mypage-alice');
  const { idToken: secondDevice } = await emulatorLogin('mypage-alice', 'signInWithPassword');
  const { idToken: bob } = await emulatorLogin('mypage-bob');
  const catalog = await loadSocialCatalog();
  const [aliasId, work] = [...catalog].find(([id, book]) => id !== book.id);
  assert.equal((await get({ view: 'account' })).status, 401);
  let account = await ok(get({ view: 'account' }, alice));
  assert.match(account.code, /^[0-9A-Z]{8}$/);
  assert.deepEqual(account.visibility, { reviews: true, wishlist: false });
  assert.equal((await get({ view: 'profile', code: account.code })).status, 200);
  assert.equal((await get({ view: 'people', q: account.code })).status, 404);
  account = await ok(post('account', alice, {
    nickname: account.nickname, visibility: { reviews: false, wishlist: false }, revision: account.revision,
  }));
  await db.collection('publicReaderProfilesV1').doc(account.code).update({ 'visibility.reading': true });
  assert.equal((await get({ view: 'profile', code: account.code })).status, 404);
  assert.equal((await get({ view: 'profile', code: account.code, section: 'reading' })).status, 400);
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
  const input = { workId: aliasId, rating: 4.5, comment: '', revision: null, fileIds: ['nonpublic-file'] };
  assert.equal((await post('review', alice, { ...input, rating: 4.25 })).status, 400);
  const { review } = await ok(post('review', alice, input));
  assert.equal(review.rating, 4.5);
  assert.equal(review.totalMs, 60_000);
  assert.equal(review.progressPercent, 52);
  assert.equal((await ok(get({ view: 'reviews' }, secondDevice))).reviews[0].rating, 4.5);
  assert.deepEqual(await workReviews(work.id), { reviews: [], average: null, ratingCount: 0 });

  const code = account.code;
  for (let flags = 0; flags < 4; flags++) {
    const visibility = { reviews: Boolean(flags & 1), wishlist: Boolean(flags & 2) };
    account = await ok(post('account', alice, { code: '11111111', nickname: '행복한도서인', visibility, revision: account.revision }));
    assert.equal(account.code, code);
    if (flags === 0) assert.equal((await get({ view: 'profile', code })).status, 404);
    else {
      const profile = await ok(get({ view: 'profile', code }));
      assert.equal('reviews' in profile, visibility.reviews);
      if (visibility.reviews) assert.equal(profile.reviews[0].rating, 4.5);
      assert.ok(!('reading' in profile));
      assert.equal('wishlist' in profile, visibility.wishlist);
      assert.ok(!JSON.stringify(profile).includes('nonpublic-file'));
      assert.ok(!JSON.stringify(profile).includes(uid));
    }
    const publicReviews = await workReviews(aliasId);
    assert.equal(publicReviews.ratingCount, visibility.reviews ? 1 : 0);
    assert.equal(publicReviews.average, visibility.reviews ? 4.5 : null);
    if (visibility.reviews) assert.deepEqual(publicReviews.reviews[0].author, { code, nickname: '행복한도서인' });
  }
  const revoked = await ok(post('account', alice, {
    nickname: '행복한도서인', visibility: { reviews: false, wishlist: false }, revision: account.revision,
  }));
  assert.equal((await get({ view: 'profile', code })).status, 404);
  assert.deepEqual(await workReviews(aliasId), { reviews: [], average: null, ratingCount: 0 });
  assert.equal((await ok(get({ view: 'reviews' }, alice))).reviews[0].rating, 4.5);
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
    { workIds: [work.id], platformWorkKeys: [platformKey(work)], rating: 3.5, comment: '첫 번째 작품' },
    { workIds: [work.id], platformWorkKeys: [platformKey(otherWork)], rating: 2, comment: '두 번째 작품' },
    { workIds: [work.id], platformWorkKeys: [platformKey(work), platformKey(otherWork)], rating: 1, comment: '모호한 작품' },
  ];
  const importBody = { accountRevision: bobAccount.revision, reviews: legacyReviews };
  const imported = await ok(post('import-reviews', bob, importBody));
  assert.deepEqual(imported, { current: 2, unavailable: 1, kept: 0 });
  const importedReviews = new Map((await ok(get({ view: 'reviews' }, bob))).reviews.map(({ workId, comment }) => [workId, comment]));
  assert.deepEqual(importedReviews, new Map([[work.id, '첫 번째 작품'], [otherWork.id, '두 번째 작품']]));
  assert.equal((await workReviews(work.id)).average, 4.25);
  assert.deepEqual(await ok(post('import-reviews', bob, importBody)), { current: 0, unavailable: 1, kept: 2 });

  const client = await initializeTestEnvironment({ projectId: 'demo-web-reader' });
  try {
    const firestore = client.authenticatedContext(uid).firestore();
    await assertFails(getDoc(doc(firestore, 'publicReaderProfilesV1', code)));
    await assertFails(setDoc(doc(firestore, 'publicReaderProfilesV1', code), { nickname: 'tampered' }));
    await assertFails(getDoc(doc(firestore, 'artifacts', APP_ID, 'users', uid, 'libraries', 'local', 'myPageSharingV1', 'settings')));
  } finally { await client.cleanup(); }
});

test('public wishlist feed limits after selecting the newest saves and keeps removed books out', async (t) => {
  const { idToken, localId: uid } = await emulatorLogin('browse-latest-wishlist');
  const account = await ok(get({ view: 'account' }, idToken));
  await ok(post('account', idToken, {
    nickname: '최근에 담는 독자', visibility: { reviews: false, wishlist: true }, revision: account.revision,
  }));
  const works = [...new Set((await loadSocialCatalog()).values())].slice(0, 15);
  assert.equal(works.length, 15);
  const db = getAdminFirestore();
  const collection = db.collection(`artifacts/${APP_ID}/users/${uid}/libraries/local/myPageWishlistV1`);
  const batch = db.batch();
  works.forEach(({ id }, index) => batch.set(collection.doc(`save-${String(index).padStart(2, '0')}`), {
    workId: id, saved: index !== 14, revision: 1, addedAt: index < 3 ? 1000 : 1000 + index,
  }));
  await batch.commit();

  let cursor;
  let group;
  do {
    const page = await ok(get({ view: 'browse', section: 'wishlist', ...(cursor ? { cursor } : {}) }));
    group = page.groups.find(({ reader }) => reader.code === account.code);
    cursor = page.next;
  } while (!group && cursor);
  assert.ok(group);
  const ids = group.books.map(({ workId }) => workId);
  const stableOldest = works.slice(0, 3).map(({ id }) => id).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))[0];
  assert.deepEqual(ids, [...works.slice(3, 14).reverse().map(({ id }) => id), stableOldest]);
  assert.ok(!ids.includes(works[14].id));

  const own = await ok(get({ view: 'wishlist' }, idToken));
  assert.equal(own.entries.find(({ item }) => item.workId === works[14].id)?.item.saved, false);

  const indexedQuery = collection.where('saved', '==', true).orderBy('addedAt', 'desc').orderBy('workId', 'asc').limit(12);
  const queryPrototype = Object.getPrototypeOf(indexedQuery);
  const original = queryPrototype.get;
  let rejected = 0;
  t.mock.method(queryPrototype, 'get', function (...args) {
    if (this.isEqual(indexedQuery)) {
      rejected++;
      return Promise.reject(Object.assign(new Error('The query requires an index'), { code: GrpcStatus.FAILED_PRECONDITION }));
    }
    return original.apply(this, args);
  });
  cursor = undefined;
  group = undefined;
  do {
    const page = await ok(get({ view: 'browse', section: 'wishlist', ...(cursor ? { cursor } : {}) }));
    group = page.groups.find(({ reader }) => reader.code === account.code);
    cursor = page.next;
  } while (!group && cursor);
  assert.equal(rejected, 1);
  assert.deepEqual(group?.books.map(({ workId }) => workId), ids);
});

test('browse groups the same book by reader and honors both privacy switches and the viewer', async () => {
  const [first, second] = await Promise.all([emulatorLogin('browse-first'), emulatorLogin('browse-second')]);
  const work = [...(await loadSocialCatalog()).values()][0];
  const accounts = await Promise.all([first, second].map(({ idToken }) => ok(get({ view: 'account' }, idToken))));
  await Promise.all([first, second].map(({ idToken }, index) => ok(post('review', idToken, {
    workId: work.id, rating: index + 3, comment: index === 0 ? '첫 독자의 평가' : '', revision: null, fileIds: [],
  }))));
  await ok(post('wishlist', first.idToken, { workId: work.id, saved: true, revision: null }));

  const groupsFor = async (section, token) => {
    const groups = new Map();
    const visited = new Set();
    let cursor = null;
    do {
      const data = await ok(get({ view: 'browse', section, ...(cursor ? { cursor } : {}) }, token));
      for (const group of data.groups) {
        assert.ok(!groups.has(group.reader.code));
        groups.set(group.reader.code, group);
      }
      cursor = data.next;
      assert.ok(!visited.has(cursor));
      visited.add(cursor);
    } while (cursor);
    return groups;
  };
  const [alice, bob] = accounts;
  const reviews = await groupsFor('reviews');
  assert.equal(reviews.get(alice.code).books[0].workId, work.id);
  assert.equal(reviews.get(bob.code).books[0].workId, work.id);
  assert.deepEqual(reviews.get(alice.code), {
    reader: { code: alice.code, nickname: alice.nickname },
    books: [{ workId: work.id, title: work.title, coverUrl: work.coverUrl, rating: 3, comment: '첫 독자의 평가' }],
  });
  const otherReviews = await groupsFor('reviews', first.idToken);
  assert.ok(!otherReviews.has(alice.code));
  assert.ok(otherReviews.has(bob.code));
  assert.ok(!(await groupsFor('wishlist')).has(alice.code));

  const changed = await ok(post('account', first.idToken, {
    nickname: alice.nickname, visibility: { reviews: false, wishlist: true }, revision: alice.revision,
  }));
  assert.ok(!(await groupsFor('reviews')).has(alice.code));
  assert.deepEqual((await groupsFor('wishlist')).get(alice.code).books, [
    { workId: work.id, title: work.title, coverUrl: work.coverUrl },
  ]);
  await ok(post('account', first.idToken, {
    nickname: alice.nickname, visibility: { reviews: false, wishlist: false }, revision: changed.revision,
  }));
  assert.ok(!(await groupsFor('wishlist')).has(alice.code));
});

test('browse skips empty account pages within a bounded scan and returns a usable cursor', async () => {
  const db = getAdminFirestore();
  const work = [...(await loadSocialCatalog()).values()][0];
  const visibility = { reviews: true, wishlist: false };
  const prefix = '000NE';
  const accountCode = (number) => prefix + String(number).padStart(3, '0');
  const batch = db.batch();
  for (let index = 1; index <= 25; index++) {
    batch.create(db.collection('publicReaderProfilesV1').doc(accountCode(index)), {
      uid: `sparse-feed-${index}`, revision: 1, visibility, nickname: '테스트 독자',
    });
  }
  const reviews = db.collection(`artifacts/${APP_ID}/users/sparse-feed-25/libraries/local/myPageReviewsV1`);
  batch.create(reviews.doc('fixture'), {
    workId: work.id, rating: 4, comment: '', revision: 1, deleted: false,
    totalMs: null, progressPercent: null, updatedAt: Timestamp.fromMillis(1000),
  });
  await batch.commit();
  try {
    const params = { view: 'browse', section: 'reviews' };
    const empty = await ok(get({ ...params, cursor: accountCode(0) }));
    assert.deepEqual(empty, { groups: [], next: accountCode(24) });
    const next = await ok(get({ ...params, cursor: empty.next }));
    assert.equal(next.groups[0].reader.code, accountCode(25));
    assert.equal(next.groups[0].books[0].workId, work.id);

    const skipped = await ok(get({ ...params, cursor: accountCode(18) }));
    assert.equal(skipped.groups[0].reader.code, accountCode(25));
  } finally {
    const cleanup = db.batch();
    for (let index = 1; index <= 25; index++) {
      cleanup.delete(db.collection('publicReaderProfilesV1').doc(accountCode(index)));
    }
    cleanup.delete(reviews.doc('fixture'));
    await cleanup.commit();
  }
});

test('removing a merged wishlist work compares all saved revisions before changing any alias', async () => {
  const { idToken, localId: uid } = await emulatorLogin('wishlist-merged-revisions');
  const catalog = await loadSocialCatalog();
  const [alias, work] = [...catalog].find(([id, book]) => id !== book.id);
  const account = await ok(get({ view: 'account' }, idToken));
  await ok(post('account', idToken, {
    nickname: account.nickname, visibility: { reviews: true, wishlist: true }, revision: account.revision,
  }));
  const db = getAdminFirestore();
  const list = db.collection(`artifacts/${APP_ID}/users/${uid}/libraries/local/myPageWishlistV1`);
  const ref = (id) => list.doc(createHash('sha256').update(id).digest('hex'));
  const seed = (workId, revision, addedAt) => ref(workId).set({ workId, revision, addedAt, saved: true });

  await Promise.all([seed(work.id, 1, 1000), seed(alias, 1, 500)]);
  const first = (await ok(get({ view: 'wishlist' }, idToken))).entries[0];
  assert.equal(first.item.workId, work.id);
  assert.deepEqual(first.siblingRevisions, [{ workId: work.id, revision: 1 }, { workId: alias, revision: 1 }]);

  await ok(post('wishlist', idToken, { workId: alias, revision: 1, saved: false }));
  await ok(post('wishlist', idToken, { workId: alias, revision: 2, saved: true }));
  const remove = (entry) => post('wishlist', idToken, {
    workId: entry.item.workId, revision: entry.item.revision, saved: false, siblingRevisions: entry.siblingRevisions,
  });
  assert.equal((await remove(first)).status, 409);
  assert.equal((await ref(work.id).get()).get('saved'), true);
  assert.equal((await ref(alias).get()).get('revision'), 3);
  assert.equal((await ref(alias).get()).get('saved'), true);

  const latest = (await ok(get({ view: 'wishlist' }, idToken))).entries[0];
  const deleted = await ok(remove(latest));
  assert.equal(deleted.item.saved, false);
  assert.deepEqual(new Map(deleted.siblingRevisions.map(({ workId, revision }) => [workId, revision])),
    new Map([[work.id, 2], [alias, 4]]));
  assert.ok((await ok(get({ view: 'wishlist' }, idToken))).entries.every(({ item }) => !item.saved));
  const profile = await ok(get({ view: 'profile', code: account.code, section: 'wishlist', pagination: 'cursor' }));
  assert.deepEqual(profile.wishlist, []);
  let cursor = null;
  do {
    const feed = await ok(get({ view: 'browse', section: 'wishlist', ...(cursor ? { cursor } : {}) }));
    assert.ok(feed.groups.every(({ reader }) => reader.code !== account.code));
    cursor = feed.next;
  } while (cursor);
});
