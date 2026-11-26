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
const { GET: sharedDriveGet, POST: sharedDrivePost } = unwrap(await import('../src/app/api/shared-drive/route.ts'));
const { GET: getBookReviews } = unwrap(await import('../src/app/api/book-reviews/route.ts'));
const { getAdminFirestore } = unwrap(await import('../src/server/firebaseAdmin.ts'));
const { loadSocialCatalog, resolveSocialWork } = unwrap(await import('../src/server/mypage/catalog.ts'));
const { getSocialReadingEvidence } = unwrap(await import('../src/server/mypage/reading.ts'));
const { createReadingRollupCarry } = unwrap(await import('../src/server/readingRollupInputs.ts'));
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

test('shared Drive imports restrict search and Drive-native copy to the shared folder tree', async (t) => {
  const allowed = await emulatorLogin('shared-drive-allowed');
  const denied = await emulatorLogin('shared-drive-denied');
  const root = 'fixture-source-folder';
  const nested = 'fixture-nested-folder';
  const file = 'fixture-source-book';
  const second = 'fixture-second-book';
  const third = 'fixture-third-book';
  const unrelated = 'fixture-unrelated-book';
  const outside = 'fixture-outside-folder';
  const library = 'fixture-private-library';
  const replacement = 'fixture-replacement-library';
  const registryId = 'fixture-library-registry';
  const driveToken = 'fixture-drive-token';
  const endpoint = 'http://localhost/api/shared-drive';
  const env = {
    WEB_READER_SHARED_DRIVE_FOLDER_ID: root,
    WEB_READER_SHARED_DRIVE_ALLOWED_UIDS: allowed.localId,
    WEB_READER_SHARED_DRIVE_PICKER_KEY: 'fixture-picker-key',
    WEB_READER_SHARED_DRIVE_PICKER_APP_ID: '123456',
    VERCEL_ENV: 'preview',
    VERCEL_BRANCH_URL: 'preview.example.test',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const originalFetch = globalThis.fetch;
  const folderMime = 'application/vnd.google-apps.folder';
  const folder = { mimeType: folderMime, trashed: false, capabilities: { canListChildren: true } };
  const nestedBook = { id: file, name: '테스트.epub', mimeType: 'application/epub+zip', size: '1040',
    trashed: false, parents: [nested], capabilities: { canCopy: true } };
  const secondBook = { ...nestedBook, id: second, name: '테스트 외전.epub', parents: [root] };
  const unrelatedBook = { ...nestedBook, id: unrelated, parents: [outside] };
  const copied = [];
  const copiesById = new Map();
  let generatedCount = 0;
  let loseNextCopyResponse = true;
  let allowedByDrive = true;
  let rootThrottled = false;
  let parentThrottled = false;
  let registryThrottled = false;
  let registeredLibrary;
  let sourceMoved = false;
  let canCopy = true;
  let sharedDestination = false;
  const quotaError = () => Response.json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, { status: 403 });
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname !== 'www.googleapis.com') return originalFetch(input, options);
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer ' + driveToken);
    const path = url.pathname.split('/').at(-1);
    if (path === 'about') return Response.json({ user: { permissionId: 'fixture-drive-account' } });
    if (path === root) {
      if (rootThrottled) return quotaError();
      return allowedByDrive ? Response.json(folder) : new Response(null, { status: 404 });
    }
    if (path === nested) return parentThrottled ? quotaError() : Response.json({ ...folder, parents: [sourceMoved ? outside : root] });
    if (path === outside) return Response.json(folder);
    if (path === file) return Response.json({ ...nestedBook, capabilities: { canCopy } });
    if (path === second) return Response.json(secondBook);
    if (path === third) return Response.json({ ...secondBook, id: third });
    if (path === unrelated) return Response.json(unrelatedBook);
    if (copiesById.has(path)) {
      return Response.json({ id: path, parents: [library], trashed: false, ownedByMe: true, shared: false });
    }
    if (path === 'generateIds') return Response.json({
      ids: Array.from({ length: Number(url.searchParams.get('count')) }, () => `fixture-new-copy-${++generatedCount}`),
    });
    if (path === library || path === replacement) return Response.json({ ...folder, id: path, name: 'web viewer', ownedByMe: true,
      shared: sharedDestination, capabilities: { canAddChildren: true } });
    if (url.searchParams.get('spaces') === 'appDataFolder') {
      if (registryThrottled) return quotaError();
      return Response.json({ files: registeredLibrary ? [{ id: registryId }] : [] });
    }
    if (path === registryId) return Response.json({ version: 1, folderId: registeredLibrary });
    if (url.searchParams.get('uploadType') === 'multipart') return Response.json({ id: registryId });
    if (path === 'files' && options.method === 'POST') {
      assert.equal(registeredLibrary, undefined);
      assert.deepEqual(JSON.parse(options.body), { name: 'web viewer', mimeType: folderMime });
      registeredLibrary = library;
      return Response.json({ id: library });
    }
    if (path === 'files') {
      const query = url.searchParams.get('q');
      if (query.startsWith("name = 'web viewer'")) return Response.json({ files: [] });
      assert.ok(query.includes("name contains '테스트'"));
      assert.ok(query.includes('fullText contains'));
      assert.equal(url.searchParams.has('orderBy'), false);
      return url.searchParams.has('pageToken')
        ? Response.json({ files: [secondBook] })
        : Response.json({ files: [unrelatedBook, nestedBook], nextPageToken: 'another-page' });
    }
    if (path === 'copy') {
      assert.equal(url.searchParams.get('ignoreDefaultVisibility'), 'true');
      const { id, parents } = JSON.parse(options.body);
      assert.deepEqual(parents, [library]);
      assert.match(id, /^fixture-new-copy-\d+$/);
      if (copiesById.has(id)) return new Response(null, { status: 409 });
      const source = url.pathname.split('/').at(-2);
      copiesById.set(id, source);
      copied.push(source);
      if (source === file && loseNextCopyResponse) {
        loseNextCopyResponse = false;
        return new Response(null, { status: 503 });
      }
      return Response.json({ id });
    }
    throw new Error('Unexpected Drive operation');
  });

  const request = (body, token = allowed.idToken, origin = 'https://preview.example.test') => new Request(endpoint, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + token, 'x-drive-access-token': driveToken, 'content-type': 'application/json', origin },
    body: body ? JSON.stringify(body) : undefined,
  });
  const privateJson = async (response) => {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const text = await response.text();
    for (const secret of [root, nested, outside, unrelated, library, driveToken, 'fixture-new-copy']) assert.ok(!text.includes(secret));
    return JSON.parse(text);
  };
  assert.deepEqual(await privateJson(await sharedDriveGet(request(undefined, denied.idToken))), { available: false });
  allowedByDrive = false;
  assert.deepEqual(await privateJson(await sharedDriveGet(request())), { available: false });
  assert.equal((await sharedDrivePost(request({ action: 'search', query: '테스트' }))).status, 403);
  allowedByDrive = true;
  assert.deepEqual(await privateJson(await sharedDriveGet(request())), { available: true,
    pickerKey: env.WEB_READER_SHARED_DRIVE_PICKER_KEY, appId: env.WEB_READER_SHARED_DRIVE_PICKER_APP_ID });
  const search = { action: 'search', query: '테스트' };
  assert.equal((await sharedDrivePost(request(search, allowed.idToken, 'https://elsewhere.test'))).status, 403);
  rootThrottled = true;
  assert.equal((await sharedDriveGet(request())).status, 429);
  rootThrottled = false;
  parentThrottled = true;
  assert.equal((await sharedDrivePost(request(search))).status, 429);
  parentThrottled = false;
  assert.deepEqual(await privateJson(await sharedDrivePost(request(search))), { ids: [file, second], limited: false });
  const copy = (ids) => sharedDrivePost(request({ action: 'copy', ids }));
  assert.deepEqual(await privateJson(await copy([unrelated])), { results: [false] });
  sourceMoved = true;
  assert.deepEqual(await privateJson(await copy([file])), { results: [false] });
  sourceMoved = false;
  canCopy = false;
  assert.deepEqual(await privateJson(await copy([file])), { results: [false] });
  canCopy = true;
  const attempts = await Promise.all([copy([file, second]), copy([file, second])]);
  assert.ok(attempts.every((attempt) => attempt.ok || attempt.status === 409));
  const results = await Promise.all(attempts.filter((attempt) => attempt.ok).map(privateJson));
  assert.ok(results.some((item) => item.results[0] === false && item.results[1] === true));
  assert.deepEqual(await privateJson(await copy([second, file])), { results: [true, true] });
  assert.equal(generatedCount, 2);
  parentThrottled = true;
  assert.equal((await copy([file])).status, 429);
  assert.deepEqual(await privateJson(await copy([file, third])), { results: [false, true] });
  assert.equal(copied.filter((source) => source === third).length, 1);
  parentThrottled = false;
  assert.deepEqual(await privateJson(await copy([file, third])), { results: [true, true] });
  assert.equal(generatedCount, 3);
  sharedDestination = true;
  assert.equal((await copy([second])).status, 403);
  sharedDestination = false;
  registryThrottled = true;
  assert.equal((await copy([second])).status, 503);
  registryThrottled = false;
  registeredLibrary = replacement;
  const changedDestination = await copy([second]);
  assert.equal(changedDestination.status, 409);
  assert.equal((await changedDestination.json()).reason, 'destination-changed');
  assert.deepEqual(copied.sort(), [file, second, third].sort());
});

test('calendar endpoints expose only the authenticated owner’s complete publication', async (t) => {
  const flag = 'NEXT_PUBLIC_ENABLE_READING_STATS_ROLLUP_READS';
  const previousFlag = process.env[flag];
  t.after(() => {
    if (previousFlag === undefined) delete process.env[flag]; else process.env[flag] = previousFlag;
  });
  const { idToken, localId: uid } = await emulatorLogin('reading-rollup-owner');
  const { idToken: otherToken } = await emulatorLogin('reading-rollup-other');
  const root = getAdminFirestore().doc(`artifacts/${APP_ID}/readingStatsRollupJobsV1/${uid}`);
  const manifest = root.collection('readingStatsRollupManifestsV1').doc('current');
  const historical = { localDate: '2026-11-16', totalMs: 180_000, screenMs: 180_000, ttsMs: 0 };
  const recent = { localDate: '2026-11-23', totalMs: 120_000, screenMs: 0, ttsMs: 120_000 };
  const week = (weekStart) => ({ view: 'rollup-week', week: weekStart });
  const activity = { localDate: historical.localDate, bookId: 'private-book', bookTitle: '칼바람', mode: 'screen',
    startAt: Date.parse('2026-11-16T12:00:00Z'), durationMs: 180_000, timezoneOffsetMinutes: 0, progressSpanPercent: 1 };
  const detailRef = root.collection('readingStatsRollupWeeksV1').doc('2026-11-16');
  await detailRef.set({ payload: JSON.stringify({ weekStart: '2026-11-16', activities: [activity], files: [{ fileId: 'internal' }] }) });
  const selectedBooks = { view: 'rollup-books', firstDay: historical.localDate, lastDay: historical.localDate };

  process.env[flag] = '0';
  assert.equal((await get(week('2026-11-16'), idToken)).status, 404);
  assert.equal((await get({ view: 'rollup-bootstrap' }, idToken)).status, 404);
  process.env[flag] = '1';
  assert.equal((await get(week('2026-11-16'))).status, 401);
  assert.equal((await get(week('2026-11-17'), idToken)).status, 400);
  assert.deepEqual(await ok(get(week('2026-11-16'), idToken)), { week: null });
  assert.deepEqual(await ok(get(selectedBooks, idToken)), { report: null });

  const weekStarts = Array.from({ length: 10 }, (_, i) => new Date(Date.parse('2026-11-16') - i * 7 * 86_400_000).toISOString().slice(0, 10));
  const calendar = root.collection('readingStatsRollupCalendarsV1').doc('2026-11-16');
  await calendar.set({ payload: JSON.stringify({ weekStarts, days: [historical] }) });
  const published = { schemaVersion: 1, firstWeek: '2026-09-14', publishedThroughWeek: '2026-11-23', lastCalendarWeek: '2026-11-16' };
  await manifest.set({ ...published, calendarTail: [{ weekStart: '2026-11-23', days: [recent] }] });
  const view = { view: 'rollup-calendar' };
  const audit = { view: 'rollup-audit' };
  const bootstrap = { view: 'rollup-bootstrap' };
  const filesView = { view: 'rollup-files' };
  const filesRef = root.collection('readingStatsRollupFilesV1').doc('current');
  const files = [{ fileId: 'private-book', titles: ['칼바람'], lastReadAt: activity.startAt + activity.durationMs,
    filteredMs: 180_000, unfilteredMs: 180_000, progressIntervals: [[1, 2]], absoluteMaxProgressPercent: 2 }];
  const books = [{ bookId: activity.bookId, bookTitle: activity.bookTitle, lastReadAt: activity.startAt, screenMs: 180_000, ttsMs: 0 }];
  const payload = JSON.stringify({ files, books, carry: { sessions: [{ sessionId: 'private-carry' }] } });
  await filesRef.set({ throughWeek: '2026-11-16', payload });
  assert.deepEqual(await ok(get(filesView, idToken)), { history: null });
  await filesRef.update({ throughWeek: '2026-11-23' });
  assert.equal((await get(filesView)).status, 401);
  assert.deepEqual(await ok(get({ ...filesView, uid }, otherToken)), { history: null });
  assert.deepEqual(await ok(get(filesView, idToken)), {
    history: { firstDay: '2026-09-14', lastDay: '2026-11-29', files },
  });
  assert.equal((await get(selectedBooks)).status, 401);
  assert.equal((await get({ ...selectedBooks, firstDay: '2026-09-14' }, idToken)).status, 400);
  assert.equal((await get({ view: 'rollup-books', firstDay: historical.localDate }, idToken)).status, 400);
  assert.deepEqual(await ok(get({ ...selectedBooks, uid }, otherToken)), { report: null });
  assert.deepEqual(await ok(get(selectedBooks, idToken)), {
    report: { firstDay: historical.localDate, lastDay: historical.localDate, books },
  });
  assert.deepEqual(await ok(get({ ...selectedBooks, firstDay: '2026-11-17', lastDay: '2026-11-17' }, idToken)), {
    report: { firstDay: '2026-11-17', lastDay: '2026-11-17', books: [] },
  });
  assert.deepEqual(await ok(get({ view: 'rollup-books' }, idToken)), {
    report: { firstDay: '2026-09-14', lastDay: '2026-11-29', books },
  });
  const full = { calendar: { firstDay: '2026-09-14', lastDay: '2026-11-29', days: [historical, recent] } };
  assert.deepEqual(await ok(get(view, idToken)), full);
  assert.deepEqual(await ok(get(audit, idToken)), { covered: false });
  await manifest.update({ coversHistoryStart: true });
  assert.deepEqual(await ok(get(audit, idToken)), { covered: true });
  assert.equal((await get(bootstrap)).status, 401);
  assert.deepEqual(await ok(get({ ...bootstrap, uid }, otherToken)), { bootstrap: null });
  assert.deepEqual(await ok(get(bootstrap, idToken)), { bootstrap: null });
  const sourceThrough = Timestamp.fromMillis(Date.parse('2026-11-30T00:00:00Z'));
  const carry = { sampleFloor: 0, sessions: [] };
  const completeBooks = [{ ...books[0], ttsMs: 120_000 }];
  await manifest.update({ sourceThrough });
  await filesRef.update({ payload: JSON.stringify({ files, books: completeBooks, carry, evidenceCompatible: false }) });
  assert.deepEqual(await ok(get(bootstrap, idToken)), { bootstrap: { calendar: full.calendar, files, books: completeBooks,
    sourceThrough: { seconds: sourceThrough.seconds, nanoseconds: sourceThrough.nanoseconds }, carry } });
  const known = { ...bootstrap, knownFirstDay: '2026-09-14', knownLastDay: '2026-11-29', knownSeconds: String(sourceThrough.seconds), knownNanos: '0' };
  assert.equal((await get(known)).status, 401);
  assert.deepEqual(await ok(get(known, otherToken)), { bootstrap: null });
  assert.equal((await get({ ...known, knownNanos: '' }, idToken)).status, 400);
  await filesRef.update({ payload });
  assert.deepEqual(await ok(get(known, idToken)), { unchanged: true }, 'unchanged discovery needs only the publication manifest');
  assert.deepEqual(await ok(get({ ...known, knownNanos: '1' }, idToken)), { bootstrap: null });
  assert.deepEqual(await ok(get(bootstrap, idToken)), { bootstrap: null });
  assert.deepEqual(await ok(get({ ...audit, uid }, otherToken)), { covered: false });
  assert.deepEqual(await ok(get({ ...view, uid }, otherToken)), { calendar: null });
  assert.deepEqual(await ok(get({ ...week('2026-11-16'), uid }, otherToken)), { week: null });
  assert.deepEqual(await ok(get(week('2026-11-16'), idToken)), { week: { weekStart: '2026-11-16', activities: [activity] } });
  assert.deepEqual(await ok(get(week('2026-11-30'), idToken)), { week: null });
  assert.deepEqual(await ok(get(week('2026-11-23'), idToken)), { week: null });
  assert.deepEqual(await ok(get({ view: 'rollup-books', firstDay: '2026-11-23', lastDay: '2026-11-23' }, idToken)), { report: null });

  // Publications written before inline tail support remain readable.
  await root.collection('readingStatsRollupWeeksV1').doc('2026-11-23').set({ payload: JSON.stringify({ weekStart: '2026-11-23', days: [recent] }) });
  await manifest.set(published);
  assert.deepEqual(await ok(get(view, idToken)), full);
  await calendar.delete();
  await manifest.update({ sourceThrough, coversHistoryStart: true, calendarTail: [{ weekStart: '2026-11-23', days: [recent] }] });
  await filesRef.update({ payload: JSON.stringify({ files, books: completeBooks, carry }) });
  assert.deepEqual(await ok(get(bootstrap, idToken)), { bootstrap: null });
  assert.equal((await get(view, idToken)).status, 503);
  await manifest.update({ coversHistoryStart: true });
  assert.equal((await get(audit, idToken)).status, 503);
});

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

test('public profile reuses candidate reads until a normal edit or deletion changes the section', async (t) => {
  const logging = process.env.MY_PAGE_PERF_LOG;
  process.env.MY_PAGE_PERF_LOG = '1';
  t.after(() => {
    if (logging === undefined) delete process.env.MY_PAGE_PERF_LOG;
    else process.env.MY_PAGE_PERF_LOG = logging;
  });
  const logs = [];
  t.mock.method(console, 'info', (label, data) => {
    if (label === '[MyPagePerformance]' && data.route === 'profile') logs.push(data);
  });
  const { idToken, localId: uid } = await emulatorLogin('profile-reuses-unchanged-candidates');
  const account = await ok(get({ view: 'account' }, idToken));
  const visible = { reviews: true, wishlist: true };
  const settings = await ok(post('account', idToken, { ...account, visibility: visible }));
  const works = [...new Set((await loadSocialCatalog()).values())].slice(0, 32);
  const db = getAdminFirestore();
  const library = db.doc(`artifacts/${APP_ID}/users/${uid}/libraries/local`);
  const reviews = library.collection('myPageReviewsV1');
  const wishlist = library.collection('myPageWishlistV1');
  const batch = db.batch();
  works.forEach(({ id: workId }, index) => {
    const id = createHash('sha256').update(workId).digest('hex');
    const time = 1000 + index;
    batch.create(wishlist.doc(id), { workId, saved: true, revision: 1, addedAt: time });
    batch.create(reviews.doc(id), {
      workId, revision: 1, rating: 3, comment: '기존 평가', totalMs: null, progressPercent: null,
      deleted: false, updatedAt: Timestamp.fromMillis(time),
    });
  });
  await batch.commit();

  const base = { view: 'profile', code: account.code, pagination: 'cursor' };
  const first = await ok(get(base));
  assert.deepEqual([logs.at(-1).reviewDocumentsRead, logs.at(-1).wishlistDocumentsRead], [32, 32]);
  const next = (section) => ok(get({ ...base, section, cursor: first.next[section] }));
  assert.equal((await next('reviews')).reviews.length, 2);
  assert.equal(logs.at(-1).reviewDocumentsRead, 0);
  assert.equal(logs.at(-1).reviewCacheHit, 1);
  assert.equal((await next('wishlist')).wishlist.length, 2);
  assert.equal(logs.at(-1).wishlistDocumentsRead, 0);
  assert.equal(logs.at(-1).wishlistCacheHit, 1);

  assert.equal(logs.at(-1).wishlistRevisionChecks, 1);
  await ok(post('review', idToken, {
    workId: works[0].id, revision: 1, rating: 4.5, comment: '수정한 평가', fileIds: [],
    readingSnapshot: { totalMs: 2_000, progressPercent: 10 }, readingSnapshotVersion: 1,
  }));
  const edited = await ok(get({ ...base, section: 'reviews' }));
  assert.equal(edited.reviews[0].comment, '수정한 평가');
  assert.equal(logs.at(-1).reviewDocumentsRead, 32);

  await ok(post('review', idToken, { workId: works[0].id, revision: 2, remove: true }));
  assert.deepEqual((await next('reviews')).reviews.map(({ workId }) => workId), [works[1].id]);
  assert.equal(logs.at(-1).reviewDocumentsRead, 31);
  assert.equal((await next('wishlist')).wishlist.length, 2);
  assert.equal(logs.at(-1).wishlistDocumentsRead, 0);
  await ok(post('wishlist', idToken, { workId: works[0].id, revision: 1, saved: false }));
  assert.deepEqual((await next('wishlist')).wishlist.map(({ workId }) => workId), [works[1].id]);
  assert.equal(logs.at(-1).wishlistDocumentsRead, 31);

  await ok(post('account', idToken, { ...settings, visibility: { reviews: false, wishlist: true } }));
  assert.equal((await get({ ...base, section: 'reviews', cursor: first.next.reviews })).status, 409);
  assert.equal((await ok(get(base))).reviews, undefined);
});

test('published review evidence combines closed totals, carry and uploads after the publication cursor', async (t) => {
  const flag = 'NEXT_PUBLIC_ENABLE_READING_STATS_ROLLUP_READS';
  const saved = { [flag]: process.env[flag], MY_PAGE_PERF_LOG: process.env.MY_PAGE_PERF_LOG };
  process.env[flag] = process.env.MY_PAGE_PERF_LOG = '1';
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const logs = [];
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'info', (label, data) => {
    if (label === '[MyPagePerformance]' && data.route === 'reading-evidence-deferred') logs.push(data);
  });
  const db = getAdminFirestore();
  const uid = 'published-review-reading-evidence';
  const workId = (await loadSocialCatalog()).values().next().value.id;
  const root = db.doc(`artifacts/${APP_ID}/readingStatsRollupJobsV1/${uid}`);
  const source = db.collection(`artifacts/${APP_ID}/users/${uid}/libraries/local/readingStatsV1`);
  const fileId = 'fixture-file';
  const session = (sessionId, localDate, progress) => {
    const startedAtClient = Date.parse(localDate + 'T10:00:00Z');
    return { schemaVersion: 1, sessionId, bookId: fileId, bookTitle: workId, deviceId: 'fixture',
      mode: 'screen', startedAtClient, endedAtClient: startedAtClient + 120_000, durationMs: 120_000,
      startProgressPercent: 0, endProgressPercent: progress, timezoneOffsetMinutes: 0, localDate, completed: false };
  };
  const oldStart = Date.parse('2026-11-22T23:57:00Z');
  const old = { ...session('old', '2026-11-22', 10), startedAtClient: oldStart,
    endedAtClient: oldStart + 180_000, durationMs: 180_000 };
  const carried = session('carry', '2026-11-23', 20);
  const newer = session('next', '2026-11-24', 30);
  const sourceThrough = Timestamp.fromMillis(Date.parse('2026-11-24T09:00:00Z'));
  const files = [{ fileId, titles: [workId], lastReadAt: old.endedAtClient,
    filteredMs: old.durationMs, unfilteredMs: old.durationMs, progressIntervals: [[0, 10]], absoluteMaxProgressPercent: 10 }];
  const carry = createReadingRollupCarry([old, carried], '2026-11-23');
  await Promise.all([
    root.collection('readingStatsRollupManifestsV1').doc('current').set({ schemaVersion: 1, firstWeek: '2026-09-14',
      publishedThroughWeek: '2026-11-16', lastCalendarWeek: '2026-11-16', sourceThrough, coversHistoryStart: true }),
    root.collection('readingStatsRollupFilesV1').doc('current').set({
      throughWeek: '2026-11-16', payload: JSON.stringify({ files, carry }),
    }),
    source.doc(old.sessionId).set({ ...old, uploadedAtServer: Timestamp.fromMillis(sourceThrough.toMillis() - 120_000) }),
    source.doc(carried.sessionId).set({ ...carried, uploadedAtServer: sourceThrough }),
    source.doc(newer.sessionId).set({ ...newer, uploadedAtServer: Timestamp.fromMillis(sourceThrough.toMillis() + 120_000) }),
  ]);
  assert.deepEqual(await getSocialReadingEvidence(db, uid, workId, [fileId], 'reading-evidence-deferred'),
    { totalMs: 420_000, progressPercent: 30 });
  assert.equal(logs.at(-1).publishedFiles, 1);
  assert.equal(logs.at(-1).scanDocuments, 1);
  assert.equal(logs.at(-1).markerDocuments, 0);

  const late = session('late', '2026-11-21', 90);
  const shifting = { ...session('late-clock', '2026-11-25', 80),
    clockOffsetMs: 120_000, clockUncertaintyMs: 0, clockMeasuredAtClient: oldStart + 60_000 };
  await Promise.all([
    source.doc(late.sessionId).set({ ...late, uploadedAtServer: Timestamp.fromMillis(sourceThrough.toMillis() + 180_000) }),
    source.doc(shifting.sessionId).set({ ...shifting, uploadedAtServer: Timestamp.fromMillis(sourceThrough.toMillis() + 240_000) }),
    source.doc('malformed').set({ uploadedAtServer: Timestamp.fromMillis(sourceThrough.toMillis() + 260_000) }),
  ]);
  now += 31_000;
  assert.deepEqual(await getSocialReadingEvidence(db, uid, workId, [fileId], 'reading-evidence-deferred'),
    { totalMs: 420_000, progressPercent: 30 });
  assert.equal(logs.at(-1).publishedFiles, 1);
  assert.equal(logs.at(-1).scanDocuments, 4);
  assert.equal(logs.at(-1).markerDocuments, 0);
});

test('review evidence reads only new sessions and includes legacy records after a count mismatch', async (t) => {
  const logging = process.env.MY_PAGE_PERF_LOG;
  process.env.MY_PAGE_PERF_LOG = '1';
  t.after(() => {
    if (logging === undefined) delete process.env.MY_PAGE_PERF_LOG;
    else process.env.MY_PAGE_PERF_LOG = logging;
  });
  const logs = [];
  t.mock.method(console, 'info', (label, data) => {
    if (label === '[MyPagePerformance]' && data.route === 'reading-evidence-deferred') logs.push(data);
  });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const db = getAdminFirestore();
  const uid = 'incremental-review-reading-evidence';
  const workId = (await loadSocialCatalog()).values().next().value.id;
  const collection = db.collection(`artifacts/${APP_ID}/users/${uid}/libraries/local/readingStatsV1`);
  const stamp = new Timestamp(70, 123000);
  const seed = (sessionId, start, end, progress, uploadedAtServer) => collection.doc(sessionId).set({
    schemaVersion: 1, sessionId, bookId: 'fixture-file', bookTitle: workId, deviceId: 'fixture-device',
    mode: 'screen', startedAtClient: start, endedAtClient: end, durationMs: end - start,
    startProgressPercent: 0, endProgressPercent: progress, timezoneOffsetMinutes: 0, localDate: '1970-01-01',
    completed: false, ...(uploadedAtServer === undefined ? {} : { uploadedAtServer }),
  });
  const evidence = () => getSocialReadingEvidence(db, uid, workId, ['fixture-file'], 'reading-evidence-deferred');
  await seed('a-earlier', 1000, 3000, 10, stamp);
  await seed('b-last', 4000, 6000, 20, stamp);
  assert.deepEqual(await evidence(), { totalMs: 4000, progressPercent: 20 });
  assert.equal(logs.at(-1).scanDocuments, 2);

  now += 31_000;
  // A late session overlaps both records and has the same server timestamp.
  await seed('c-late', 2000, 5000, 30, stamp);
  assert.deepEqual(await evidence(), { totalMs: 5000, progressPercent: 30 });
  assert.equal(logs.at(-1).countQueries, 1);
  assert.equal(logs.at(-1).scanDocuments, 1);

  now += 5 * 60_000;
  assert.deepEqual(await evidence(), { totalMs: 5000, progressPercent: 30 });
  assert.equal(logs.at(-1).scanDocuments, 0);

  now += 5 * 60_000;
  await seed('legacy-without-upload-time', 7000, 9000, 40);
  assert.deepEqual(await evidence(), { totalMs: 7000, progressPercent: 40 });
  assert.equal(logs.at(-1).scanDocuments, 4);
  assert.equal(logs.at(-1).fullScanCountMismatch, 1);

  now += 26 * 60_000;
  assert.deepEqual(await evidence(), { totalMs: 7000, progressPercent: 40 });
  assert.equal(logs.at(-1).scanDocuments, 0);

  await collection.doc('a-earlier').delete();
  await seed('replacement-before-cursor', 10_000, 12_000, 50, new Timestamp(65, 0));
  now += 4 * 60_000;
  assert.deepEqual(await evidence(), { totalMs: 8000, progressPercent: 50 });
  assert.equal(logs.at(-1).scanDocuments, 4);
  assert.equal(logs.at(-1).fullScanAudit, 1);
});

test('review evidence reuses unchanged oversized history after a Firestore count check', async (t) => {
  const logging = process.env.MY_PAGE_PERF_LOG;
  process.env.MY_PAGE_PERF_LOG = '1';
  t.after(() => {
    if (logging === undefined) delete process.env.MY_PAGE_PERF_LOG;
    else process.env.MY_PAGE_PERF_LOG = logging;
  });
  const logs = [];
  t.mock.method(console, 'info', (label, data) => {
    if (label === '[MyPagePerformance]' && data.route === 'reading-evidence-deferred') logs.push(data);
  });
  const db = getAdminFirestore();
  const uid = 'oversized-review-reading-evidence';
  const workId = (await loadSocialCatalog()).values().next().value.id;
  const collection = db.collection(`artifacts/${APP_ID}/users/${uid}/libraries/local/readingStatsV1`);
  const stamp = new Timestamp(71, 0);
  let payloadBytes = 0;
  for (let page = 0; page < 5; page++) {
    const batch = db.batch();
    for (let index = page * 28; index < (page + 1) * 28; index++) {
      const start = 1_700_000_000_000 + index * 2048;
      const activeIntervals = Array.from({ length: 512 }, (_, interval) => ({
        startedAtClient: start + interval * 2,
        endedAtClient: start + interval * 2 + 2,
      }));
      const session = {
        schemaVersion: 1, sessionId: String(index).padStart(3, '0'), bookId: 'file', bookTitle: workId, deviceId: 'device',
        mode: 'tts', startedAtClient: start, endedAtClient: start + 1024, durationMs: 1024, activeIntervals,
        startProgressPercent: 0, endProgressPercent: 20, timezoneOffsetMinutes: 0, localDate: '2023-11-14', completed: false,
      };
      payloadBytes += Buffer.byteLength(JSON.stringify(session));
      batch.set(collection.doc(session.sessionId), { ...session, uploadedAtServer: stamp });
    }
    await batch.commit();
  }
  assert.ok(payloadBytes > 4 * 1024 * 1024);

  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const evidence = () => getSocialReadingEvidence(db, uid, workId, ['file'], 'reading-evidence-deferred');
  const expected = { totalMs: 140 * 1024, progressPercent: 20 };
  assert.deepEqual(await evidence(), expected);
  assert.equal(logs.at(-1).scanDocuments, 140);
  assert.equal(logs.at(-1).timelineBuilds, 1);

  now += 5 * 60_000;
  assert.deepEqual(await evidence(), expected);
  assert.equal(logs.at(-1).markerDocuments, 1);
  assert.equal(logs.at(-1).countQueries, 1);
  assert.equal(logs.at(-1).scanQueries, 0);
  assert.equal(logs.at(-1).timelineBuilds, 0);
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

test('on-demand aliases reuse reads and wishlist writes see a remap immediately', async (t) => {
  const db = getAdminFirestore();
  const { idToken } = await emulatorLogin('mypage-on-demand-cache');
  const title = '온디맨드 캐시 확인 전용 작품';
  const { aliasId } = parseBookMetadataRefreshRequest({ fileName: `${title}.txt` });
  const ref = db.collection('publicBookMetadataOnDemandV1').doc(aliasId);
  const catalog = await loadSocialCatalog();
  const [first, second] = [...new Set(catalog.values())].filter(({ platforms }) => platforms.length > 0);
  assert.notEqual(first.id, second.id);
  const seed = ({ platforms: [{ id: platform, url }] }) => ref.set({
    schemaVersion: 1, status: 'ready', aliasId, platforms: [{ platform, url }],
  });
  const prototype = Object.getPrototypeOf(ref);
  const originalGet = prototype.get;
  let reads = 0;
  t.mock.method(prototype, 'get', function (...args) {
    if (this.path === ref.path) reads++;
    return originalGet.apply(this, args);
  });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const resolve = async () => (await resolveSocialWork(db, title))?.book.id ?? null;

  assert.deepEqual(await Promise.all(Array.from({ length: 12 }, resolve)), Array(12).fill(null));
  assert.equal(reads, 1);
  await seed(first);
  assert.equal(await resolve(), null);
  assert.equal(reads, 1);
  now += 15_001;
  assert.equal(await resolve(), first.id);
  assert.equal(await resolve(), first.id);
  assert.equal(reads, 2);

  await seed(second);
  assert.equal(await resolve(), first.id);
  const { item } = await ok(post('wishlist', idToken, { workId: title, saved: true, revision: null }));
  assert.equal(item.workId, second.id);
  now += 60_001;
  assert.equal(await resolve(), second.id);

  now += 60_001;
  await ref.update({ status: 'error' });
  assert.equal(await resolve(), null);
  await seed(first);
  assert.equal(await resolve(), first.id);
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
  assert.deepEqual(await ok(get({ view: 'own-review', workId: work.id }, idToken)), deleted);
  assert.equal((await post('review', idToken, {
    ...input, workId: work.id, revision: deleted.deletions[0].revision, platformWorkKeys: [staleKey],
  })).status, 404);
  const restored = (await ok(post('review', idToken, {
    ...input, workId: work.id, revision: deleted.deletions[0].revision,
  }))).review;
  assert.equal(restored.workId, work.id);
  await ok(post('review', idToken, { workId: work.id, revision: restored.revision, remove: true, platformWorkKeys: [key, unknownKey] }));
});

test('an edit with verified evidence avoids history lookup while a new review tolerates lookup failure', async (t) => {
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
    assert.equal(blocked, false);
    assert.equal(edited.rating, 5);
    assert.equal(edited.totalMs, 60000);
    assert.equal(edited.progressPercent, 55);
    const other = [...(await loadSocialCatalog()).values()].find(({ id }) => id !== workId);
    const { review: created } = await ok(post('review', idToken, { ...input, workId: other.id }));
    assert.equal(blocked, true);
    assert.equal(created.rating, input.rating);
    assert.equal(created.totalMs, null);
  } finally {
    clock.mock.restore();
    collectionMock.mock.restore();
  }
  const own = (await ok(get({ view: 'reviews' }, idToken))).reviews.find((review) => review.workId === workId);
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

  // An older client's edit can reuse evidence without reading the raw history.
  const queriesBeforeLegacyEdit = sessionQueries;
  const { review: legacy } = await save({ ...input, rating: 3, revision: incompleteEdit.revision });
  assert.equal(legacy.totalMs, 180_000);
  assert.equal(sessionQueries, queriesBeforeLegacyEdit);
  assert.equal((await post('review', idToken, { ...input, revision: incompleteEdit.revision })).status, 409);
  assert.equal(sessionQueries, queriesBeforeLegacyEdit);
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

test('a stale partial local snapshot preserves deferred evidence at the same review revision', async () => {
  const { idToken, localId: uid } = await emulatorLogin('mypage-same-revision-evidence');
  const workId = (await loadSocialCatalog()).values().next().value.id;
  const { code } = await ok(get({ view: 'account' }, idToken));
  const db = getAdminFirestore();
  await db.doc(`artifacts/${APP_ID}/users/${uid}/libraries/local/readingStatsV1/deferred-session`).set({
    schemaVersion: 1, sessionId: 'deferred-session', bookId: 'deferred-file', bookTitle: workId, deviceId: 'fixture-device',
    mode: 'screen', startedAtClient: 1000, endedAtClient: 181000, durationMs: 180_000, startProgressPercent: 0, endProgressPercent: 80,
    timezoneOffsetMinutes: 0, localDate: '1970-01-01', completed: false,
  });
  const deferred = [];
  const save = (fields) => workAsyncStorage.run({ afterContext: { after: (task) => deferred.push(task) } }, () =>
    workUnitAsyncStorage.run({ type: 'request' }, () => ok(post('review', idToken, fields))));
  const input = { workId, rating: 4, comment: '', fileIds: ['deferred-file'] };
  const { review: blank } = await save({ ...input, revision: null, readingSnapshot: null });
  assert.equal(blank.totalMs, null);
  assert.equal(blank.progressPercent, null);
  assert.equal(deferred.length, 1);

  const full = { totalMs: 180_000, progressPercent: 80 };
  await deferred.shift()();
  const { reviews: [filled] } = await ok(get({ view: 'reviews' }, idToken));
  assert.equal(filled.revision, blank.revision);
  assert.equal(filled.totalMs, full.totalMs);
  assert.equal(filled.progressPercent, full.progressPercent);

  const smaller = { totalMs: 60_000, progressPercent: 20 };
  const { review: partial } = await save({
    ...input, revision: blank.revision, comment: '부분 기록', readingSnapshot: smaller,
    readingSnapshotVersion: 2, readingHistoryPartial: true,
  });
  const { review: olderClient } = await save({
    ...input, revision: partial.revision, comment: '이전 앱', readingSnapshot: smaller, readingSnapshotVersion: 1,
  });
  const { reviews: [privateReview] } = await ok(get({ view: 'reviews' }, idToken));
  const publicReview = (await workReviews(workId)).reviews.find(({ author }) => author.code === code);
  assert.equal(partial.revision, blank.revision + 1);
  assert.equal(partial.comment, '부분 기록');
  for (const review of [partial, olderClient, privateReview, publicReview]) {
    assert.equal(review.totalMs, full.totalMs);
    assert.equal(review.progressPercent, full.progressPercent);
  }

  const { review: fresh } = await save({
    ...input, revision: olderClient.revision, comment: '전체 기록', readingSnapshot: smaller,
    readingSnapshotVersion: 2, readingHistoryPartial: false,
  });
  const updatedPublic = (await workReviews(workId)).reviews.find(({ author }) => author.code === code);
  for (const review of [fresh, updatedPublic]) {
    assert.equal(review.comment, '전체 기록');
    assert.equal(review.totalMs, smaller.totalMs);
    assert.equal(review.progressPercent, smaller.progressPercent);
  }
  assert.equal(deferred.length, 0);
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
  const detail = await ok(get({ view: 'own-review', workId: oldWork.id }, idToken));
  assert.deepEqual(detail, { reviews: [legacy.review], deletions: [] });
  await ok(post('review', idToken, { workId: oldWork.id, revision: legacy.review.revision, remove: true }));
  const previewParams = { view: 'reviews', preview: '1' };
  assert.equal((await get(previewParams, idToken)).headers.get('server-timing'), null);
  const unauthorized = await get({ ...previewParams, timing: '1' });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('server-timing'), null);
  const measured = await get({ ...previewParams, timing: '1' }, idToken);
  const timings = measured.headers.get('server-timing');
  assert.match(timings, /^auth-admin;dur=[\d.]+, auth-verify;dur=[\d.]+, auth;dur=[\d.]+, query;dur=[\d.]+, rows;desc="records=1", resolve;dur=[\d.]+, total;dur=[\d.]+$/);
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
    const snapshot = doc(firestore, 'artifacts', APP_ID, 'users', uid, 'libraries', 'local', 'myPageWishlistSnapshotV1', 'current');
    await assertFails(getDoc(snapshot));
    await assertFails(setDoc(snapshot, { generation: 'test', payload: null }));
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

test('wishlist writes compare exact historical revisions after confirming the published work', async (t) => {
  const { idToken, localId: uid } = await emulatorLogin('wishlist-historical-revisions');
  const db = getAdminFirestore();
  const catalog = await loadSocialCatalog();
  const work = [...catalog.values()].find(({ platforms }) => platforms.length > 0);
  const other = [...catalog.values()].find(({ id }) => id !== work.id);
  const historical = '게시 인덱스에서 빠진 이전 위시리스트 작품 키';
  assert.equal(catalog.has(historical), false);
  const [candidate] = getPublicBookMetadataAliasCandidates(historical);
  const hash = (id) => createHash('sha256').update(id).digest('hex');
  const metadataId = hash(candidate);
  await db.collection('publicBookMetadataV1').doc(metadataId.slice(0, 2)).set({
    schemaVersion: 1, entries: { [metadataId]: {
      schemaVersion: 1, titleKey: work.id, displayTitle: work.title,
      normalizerVersion: '1.3.3', publishedAt: new Date().toISOString(), platforms: [],
    } },
  }, { merge: true });

  const account = await ok(get({ view: 'account' }, idToken));
  const shared = await ok(post('account', idToken, {
    nickname: account.nickname, visibility: { ...account.visibility, wishlist: true }, revision: account.revision,
  }));
  const list = db.collection(`artifacts/${APP_ID}/users/${uid}/libraries/local/myPageWishlistV1`);
  const ref = (id) => list.doc(hash(id));
  const seed = (workId, revision, addedAt) => ref(workId).set({ workId, revision, addedAt, saved: true });
  await ref(historical).set({ workId: historical, revision: 3, addedAt: 2000, saved: false });
  await ok(post('import-wishlist', idToken, { workIds: [historical], accountRevision: shared.revision }));
  await ok(post('import-wishlist', idToken, { workIds: [work.id], accountRevision: shared.revision }));
  assert.equal((await ref(work.id).get()).exists, false);
  assert.equal((await ref(historical).get()).get('saved'), false);
  await Promise.all([seed(work.id, 2, 3000), seed(historical, 4, 2000), seed(other.id, 1, 1000)]);

  const readWork = async () => (await ok(get({ view: 'wishlist' }, idToken))).entries.find(({ book }) => book.id === work.id);
  const remove = (entry, siblings = entry.siblingRevisions) => post('wishlist', idToken, {
    workId: entry.item.workId, revision: entry.item.revision, saved: false, siblingRevisions: siblings,
  });
  const first = await readWork();
  assert.equal(first.item.workId, work.id);
  assert.deepEqual(first.siblingRevisions, [{ workId: work.id, revision: 2 }, { workId: historical, revision: 4 }]);
  const publicProfile = async () => ok(get({ view: 'profile', code: account.code, section: 'wishlist', pagination: 'cursor' }));
  assert.ok((await publicProfile()).wishlist.some(({ workId }) => workId === work.id));
  assert.ok(!(await publicProfile()).wishlist.some(({ workId }) => workId === historical));

  assert.equal((await remove(first, [...first.siblingRevisions, { workId: other.id, revision: 1 }])).status, 409);
  await seed(historical, 5, 2000);
  assert.equal((await remove(first)).status, 409);
  assert.equal((await ref(work.id).get()).get('revision'), 2);
  assert.equal((await ref(historical).get()).get('saved'), true);
  assert.equal((await ref(other.id).get()).get('saved'), true);

  const latest = await readWork();
  const removed = await ok(remove(latest));
  assert.deepEqual(removed.siblingRevisions, [{ workId: work.id, revision: 3 }, { workId: historical, revision: 6 }]);
  assert.equal((await ref(historical).get()).get('saved'), false);
  assert.deepEqual((await publicProfile()).wishlist.map(({ workId }) => workId), [other.id]);

  await seed(historical, 7, 4000);
  const historicalFirst = await readWork();
  assert.equal(historicalFirst.item.workId, historical);
  const removedHistorical = await ok(remove(historicalFirst));
  assert.equal(removedHistorical.item.workId, historical);
  assert.deepEqual(removedHistorical.siblingRevisions, [{ workId: historical, revision: 8 }, { workId: work.id, revision: 3 }]);
  assert.equal((await ref(historical).get()).get('saved'), false);

  const flag = 'MY_PAGE_WISHLIST_SNAPSHOT_GENERATION';
  const previous = process.env[flag];
  process.env[flag] = 'test-route';
  t.after(() => {
    if (previous === undefined) delete process.env[flag]; else process.env[flag] = previous;
  });
  const snapshot = list.parent.collection('myPageWishlistSnapshotV1').doc('current');
  assert.deepEqual((await publicProfile()).wishlist.map(({ workId }) => workId), [other.id]);
  assert.equal((await snapshot.get()).exists, false);

  const removedState = await readWork();
  assert.equal(removedState.item.saved, false);
  assert.equal((await snapshot.get()).get('generation'), 'test-route');
  const restored = await ok(post('wishlist', idToken, {
    workId: removedState.item.workId, revision: removedState.item.revision, saved: true,
    siblingRevisions: removedState.siblingRevisions,
  }));
  const current = await readWork();
  assert.equal(current.item.workId, restored.item.workId);
  assert.equal(current.item.saved, true);
  await ok(remove(current));
  assert.equal((await readWork()).item.saved, false);
  assert.deepEqual((await publicProfile()).wishlist.map(({ workId }) => workId), [other.id]);
});
