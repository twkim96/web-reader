import { after } from 'next/server';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { getAdminAuth, getAdminFirestore } from '../../../server/firebaseAdmin';
import { resolveLegacyReviewWork, resolveSocialWork, resolveWishlistWork } from '../../../server/mypage/catalog';
import { getSocialReadingEvidence } from '../../../server/mypage/reading';
import { reportMyPageApiTiming, type ReadingEvidenceRoute } from '../../../server/mypage/performance';
import { legacyProfilePage, parseProfileCursor, profileCursorPage } from '../../../server/mypage/profilePagination';
import {
  currentBrowseReaders, ensureAccount, fillReviewReading, importReview, listBrowseReaders, listPublicProfileReviews, listPublicProfileWishlist,
  listReviewDeletions, listReviews, listWishlist, lookupPublicAccount, readOwnReviewWork,
  updateAccount, updateReview, updateReviewWithStatus, updateWishlist,
} from '../../../server/mypage/store';
import { isBookDetailId } from '../../../lib/bookDetail';
import { BOOK_REVIEW_TEXT_LIMIT, REVIEW_READING_SNAPSHOT_VERSION, isBookRating, parsePublicBookReview } from '../../../lib/publicBookReviews';
import { platformWorkKey } from '../../../lib/readBooks';
import {
  MY_PAGE_CODE, MY_PAGE_DASHBOARD_BOOK_LIMIT, REVIEW_LIST_SORTS, parseMyPageNickname, parseMyPageVisibility, sortReviewList,
  type MyPageOwnReviews, type MyPageSavedBook, type MyPageWishlistRevision, type PublicBrowseGroup, type PublicBrowsePage, type PublicMyPage, type PublicProfileBook,
} from '../../../lib/myPageSocial';

const MAX_BODY_BYTES = 64_000;
const REVIEW_SAVE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const publicSections = ['reviews', 'wishlist'] as const;
const epoch = Timestamp.fromMillis(0);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (status: number) => json({ error: 'request-failed' }, status);
const evidenceFor = (db: Firestore, uid: string, workId: string, fileIds: readonly string[], route: ReadingEvidenceRoute) => (
  getSocialReadingEvidence(db, uid, workId, fileIds, route).catch(() => undefined)
);
const reviewWorkDetails = (work: Awaited<ReturnType<typeof resolveSocialWork>>) => ({
  aliases: work?.equivalentWorkIds ?? [],
  platformWorkKeys: work?.book.platforms.map(({ id, url }) => platformWorkKey(id, url)) ?? [],
  title: work?.book.title,
  coverUrl: work?.book.coverUrl,
});

async function authenticatedUid(
  request: Request,
  report?: (phase: 'auth-admin' | 'auth-verify', elapsed: number) => void,
) {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!token) return null;
  try {
    const started = report ? performance.now() : 0;
    const auth = getAdminAuth();
    const verifyStarted = report ? performance.now() : 0;
    report?.('auth-admin', verifyStarted - started);
    const user = await auth.verifyIdToken(token, true);
    report?.('auth-verify', performance.now() - verifyStarted);
    return user.firebase.sign_in_provider === 'anonymous' ? null : user.uid;
  } catch { return null; }
}

type ListTiming = (phase: 'auth' | 'query' | 'resolve', counts?: { records: number; saved?: number }) => void;

async function wishlistBookStates(db: Firestore, uid: string, timing?: ListTiming): Promise<MyPageSavedBook[]> {
  const entries = await listWishlist(db, uid, true);
  timing?.('query', { records: entries.length, saved: entries.filter(({ saved }) => saved).length });
  // Prefer an active entry if previously distinct keys now identify one work.
  entries.sort((a, b) => Number(b.saved) - Number(a.saved));
  const books = new Map<string, MyPageSavedBook & { siblingRevisions: MyPageWishlistRevision[] }>();
  for (let start = 0; start < entries.length; start += 20) {
    const batch = await Promise.all(entries.slice(start, start + 20).map(async (item) => {
      const resolved = await resolveWishlistWork(db, item.workId);
      if (!resolved) return null;
      return { item, book: resolved.book, aliases: resolved.equivalentWorkIds };
    }));
    for (const entry of batch) {
      if (!entry) continue;
      const { workId, revision } = entry.item;
      const existing = books.get(entry.book.id);
      if (existing) existing.siblingRevisions.push({ workId, revision });
      else books.set(entry.book.id, { ...entry, siblingRevisions: [{ workId, revision }] });
    }
  }
  timing?.('resolve');
  return [...books.values()];
}

async function ownReviews(db: Firestore, uid: string, preview: boolean, timing?: ListTiming): Promise<MyPageOwnReviews> {
  const [reviews, deletions] = await Promise.all([
    listReviews(db, uid, preview ? MY_PAGE_DASHBOARD_BOOK_LIMIT : undefined),
    preview ? [] : listReviewDeletions(db, uid),
  ]);
  timing?.('query', { records: reviews.length + deletions.length });
  const describe = async <T extends { workId: string }>(records: T[]) => {
    const enriched: Array<T & ReturnType<typeof reviewWorkDetails>> = [];
    for (let offset = 0; offset < records.length; offset += 20) {
      enriched.push(...await Promise.all(records.slice(offset, offset + 20).map(async (record) => {
        const work = await resolveSocialWork(db, record.workId).catch(() => null);
        return { ...record, ...reviewWorkDetails(work) };
      })));
    }
    return enriched;
  };
  const [active, removed] = await Promise.all([describe(reviews), describe(deletions)]);
  timing?.('resolve');
  return { reviews: active, deletions: removed };
}

type PublicBookResolver = (db: Firestore, workId: string) => ReturnType<typeof resolveSocialWork>;

async function publicBooks<T extends { workId: string }>(
  db: Firestore, records: T[], resolveWork: PublicBookResolver = resolveSocialWork,
) {
  return (await Promise.all(records.map(async (record) => {
    const match = await resolveWork(db, record.workId);
    if (!match) return null;
    const { id: workId, title, coverUrl } = match.book;
    return { record, book: { workId, title, coverUrl } satisfies PublicProfileBook };
  }))).flatMap((result) => result ? [result] : []);
}

async function uniquePublicProfileBooks<T extends { workId: string; time: string }>(
  db: Firestore, records: T[], resolveWork: PublicBookResolver = resolveSocialWork,
) {
  const unique = new Map<string, { record: T; book: PublicProfileBook }>();
  for (let start = 0; start < records.length; start += 20) {
    for (const entry of await publicBooks(db, records.slice(start, start + 20), resolveWork)) {
      const id = entry.book.workId;
      const previous = unique.get(id);
      // Keep the newest record regardless of the incoming order. At equal times, prefer the canonical record.
      if (!previous || entry.record.time > previous.record.time
        || (entry.record.time === previous.record.time && entry.record.workId === id)) {
        unique.set(id, entry);
      }
    }
  }
  return [...unique.values()];
}

async function publicProfile(db: Firestore, params: URLSearchParams) {
  const started = performance.now();
  const code = params.get('code')?.toUpperCase() ?? '';
  const section = params.get('section');
  const offset = Number(params.get('offset') ?? 0);
  const useCursor = params.get('pagination') === 'cursor';
  const cursorValue = params.get('cursor');
  const reviewSort = REVIEW_LIST_SORTS.find(([id]) => id === (params.get('reviewSort') ?? 'recent'))?.[0];
  if (!reviewSort || !MY_PAGE_CODE.test(code) || !Number.isSafeInteger(offset) || offset < 0
    || (useCursor && params.has('offset'))
    || (cursorValue !== null && (!useCursor || section === null))
    || (section !== null && !publicSections.some((candidate) => candidate === section))) return fail(400);

  const cursor = cursorValue === null ? null : await parseProfileCursor(db, cursorValue);
  if (cursorValue !== null && (!cursor || cursor.code !== code || cursor.section !== section
    || cursor.sort !== (section === 'wishlist' ? 'recent' : reviewSort))) return fail(400);

  const initial = await lookupPublicAccount(db, code);
  if (!initial) return fail(404);
  const { uid, account: { visibility, nickname, revision } } = initial;
  if (cursor && cursor.revision !== revision) return fail(409);
  const ratingDirection = reviewSort === 'rating-desc' ? -1 : reviewSort === 'rating-asc' ? 1 : 0;
  let wishlistCandidates = 0;
  let reviewCandidates = 0;
  let wishlistDocumentsRead = 0;
  let reviewDocumentsRead = 0;
  let wishlistCacheHit = false;
  let reviewCacheHit = false;
  let wishlistRevisionChecks = 0;
  let reviewRevisionChecks = 0;
  const wishlistWindow = async () => {
    if (!useCursor) {
      const records = await listWishlist(db, uid);
      wishlistCandidates = wishlistDocumentsRead = records.length;
      const page = legacyProfilePage(records, offset);
      return { ...page, entries: await publicBooks(db, page.entries, resolveWishlistWork) };
    }
    const result = await listPublicProfileWishlist(db, uid);
    wishlistDocumentsRead = result.documentsRead;
    wishlistCacheHit = result.cacheHit;
    wishlistRevisionChecks = result.revisionChecks;
    const records = result.records.map(({ workId, addedAt }) => ({
      workId, time: Number.isFinite(addedAt) ? Timestamp.fromMillis(addedAt).valueOf() : epoch.valueOf(),
    }));
    wishlistCandidates = records.length;
    const entries = await uniquePublicProfileBooks(db, records, resolveWishlistWork);
    return profileCursorPage(db, entries, ({ record, book }) => [0, record.time, book.workId],
      { code, section: 'wishlist', sort: 'recent', revision }, cursor?.key);
  };
  const reviewWindow = async () => {
    if (!useCursor) {
      const records = await listReviews(db, uid);
      reviewCandidates = reviewDocumentsRead = records.length;
      const page = legacyProfilePage(sortReviewList(records, reviewSort), offset);
      return { ...page, entries: await publicBooks(db, page.entries) };
    }
    // Timestamp.valueOf() produces a sortable string without the precision loss of toMillis().
    const result = await listPublicProfileReviews(db, uid);
    reviewDocumentsRead = result.documentsRead;
    reviewCacheHit = result.cacheHit;
    reviewRevisionChecks = result.revisionChecks;
    const records = result.records.map(({ updatedAt, ...review }) => ({
      ...review, time: (updatedAt ?? epoch).valueOf(),
    }));
    reviewCandidates = records.length;
    const entries = await uniquePublicProfileBooks(db, records);
    return profileCursorPage(db, entries, ({ record, book }) => [ratingDirection * record.rating, record.time, book.workId],
      { code, section: 'reviews', sort: reviewSort, revision }, cursor?.key);
  };
  const [wishlistPage, reviewsPage] = await Promise.all([
    visibility.wishlist && (!section || section === 'wishlist') ? wishlistWindow() : null,
    visibility.reviews && (!section || section === 'reviews') ? reviewWindow() : null,
  ]);
  const current = await lookupPublicAccount(db, code);
  if (!current) return fail(404);
  if (current.account.revision !== revision) return fail(409);
  reportMyPageApiTiming('profile', started, {
    wishlistCandidates, reviewCandidates, wishlistDocumentsRead, reviewDocumentsRead,
    wishlistCacheHit: Number(wishlistCacheHit), reviewCacheHit: Number(reviewCacheHit),
    wishlistRevisionChecks, reviewRevisionChecks,
    wishlistReturned: wishlistPage?.entries.length ?? 0,
    reviewsReturned: reviewsPage?.entries.length ?? 0,
    wishlistHasNext: Number(wishlistPage?.next != null), reviewsHasNext: Number(reviewsPage?.next != null),
  });

  return json({
    identity: { code, nickname }, visibility,
    wishlist: wishlistPage?.entries.map(({ book }) => book),
    reviews: reviewsPage?.entries.map(({ record, book }) => ({ ...book, rating: record.rating, comment: record.comment })),
    next: { wishlist: wishlistPage?.next, reviews: reviewsPage?.next },
  } satisfies PublicMyPage);
}

async function publicBrowse(request: Request, params: URLSearchParams) {
  const section = params.get('section') ?? 'reviews';
  const cursor = params.get('cursor');
  if ((section !== 'reviews' && section !== 'wishlist') || (cursor !== null && !MY_PAGE_CODE.test(cursor))) return fail(400);
  const signedIn = request.headers.has('authorization');
  const viewerUid = signedIn ? await authenticatedUid(request) : null;
  if (signedIn && !viewerUid) return fail(401);

  const db = getAdminFirestore();
  // Look beyond a fully empty page without letting a sparse feed scan the entire profiles collection.
  let next = cursor;
  for (let scanned = 0; scanned < 4; scanned++) {
    const page = await listBrowseReaders(db, section, next, viewerUid);
    next = page.next;
    const enriched = await Promise.all(page.readers.map(async ({ uid, account }) => {
      const books = section === 'wishlist'
        ? (await publicBooks(db, await listWishlist(db, uid, false, MY_PAGE_DASHBOARD_BOOK_LIMIT), resolveWishlistWork)).map(({ book }) => book)
        : (await publicBooks(db, await listReviews(db, uid, MY_PAGE_DASHBOARD_BOOK_LIMIT))).map(({ book, record }) => (
          { ...book, rating: record.rating, comment: record.comment }
        ));
      const unique = new Map<string, PublicBrowseGroup['books'][number]>();
      for (const book of books) if (!unique.has(book.workId)) unique.set(book.workId, book);
      return {
        revision: account.revision,
        group: { reader: { code: account.code, nickname: account.nickname }, books: [...unique.values()] },
      };
    }));
    const populated = enriched.filter(({ group }) => group.books.length > 0);
    // Recheck the selected setting after loading books and metadata.
    const revisions = await currentBrowseReaders(db, populated.map(({ group }) => group.reader.code), section);
    const groups = populated.filter(({ group, revision }) => revisions.get(group.reader.code) === revision).map(({ group }) => group);
    if (groups.length || next === null) return json({ groups, next } satisfies PublicBrowsePage);
  }
  return json({ groups: [], next } satisfies PublicBrowsePage);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const view = params.get('view');
  const timings = params.get('timing') === '1' && (view === 'wishlist' || view === 'reviews') ? [] as string[] : undefined;
  const started = timings ? performance.now() : 0;
  let previous = started;
  const timing: ListTiming | undefined = timings && ((phase, counts) => {
    const now = performance.now();
    timings.push(`${phase};dur=${(now - previous).toFixed(1)}`);
    if (counts) {
      const label = counts.saved === undefined ? `records=${counts.records}` : `records=${counts.records} saved=${counts.saved}`;
      timings.push(`rows;desc="${label}"`);
    }
    previous = now;
  });
  const respond = (data: unknown) => {
    const response = json(data);
    if (timings) {
      timings.push(`total;dur=${(performance.now() - started).toFixed(1)}`);
      response.headers.set('Server-Timing', timings.join(', '));
    }
    return response;
  };
  try {
    if (view === 'people') return fail(404);
    if (view === 'browse') return await publicBrowse(request, params);
    if (view === 'profile') return await publicProfile(getAdminFirestore(), params);
    const uid = await authenticatedUid(request, timings && ((phase, elapsed) => {
      timings.push(`${phase};dur=${elapsed.toFixed(1)}`);
    }));
    if (!uid) return fail(401);
    timing?.('auth');
    const db = getAdminFirestore();
    if (view === 'account') return json(await ensureAccount(db, uid));
    if (view === 'wishlist') return respond({ entries: await wishlistBookStates(db, uid, timing) });
    if (view === 'reviews') return respond(await ownReviews(db, uid, params.get('preview') === '1', timing));
    if (view === 'own-review') {
      const workId = params.get('workId');
      if (!isBookDetailId(workId)) return fail(400);
      const work = await resolveSocialWork(db, workId);
      if (!work) return fail(404);
      const { reviews, deletions } = await readOwnReviewWork(db, uid, [work.book.id, ...work.equivalentWorkIds]);
      const details = reviewWorkDetails(work);
      return json({
        reviews: reviews.map((review) => ({ ...review, ...details })),
        deletions: deletions.map((deletion) => ({ ...deletion, ...details })),
      });
    }
    return fail(400);
  } catch {
    return fail(503);
  }
}

const validRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const isReviewInput = (rating: unknown, comment: unknown) => (
  isBookRating(rating)
  && typeof comment === 'string' && comment.length <= BOOK_REVIEW_TEXT_LIMIT && !/[\r\n]/.test(comment)
);

export async function POST(request: Request) {
  const uid = await authenticatedUid(request);
  if (!uid) return fail(401);
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return fail(413);
  let input: Record<string, unknown>;
  try {
    const reader = request.body?.getReader();
    if (!reader) return fail(400);
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BODY_BYTES) { await reader.cancel(); return fail(413); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400);
    input = raw as Record<string, unknown>;
  } catch { return fail(400); }
  const action = new URL(request.url).searchParams.get('action');
  try {
    const db = getAdminFirestore();
    const { revision } = input;
    if (action === 'account') {
      const nickname = parseMyPageNickname(input.nickname);
      const visibility = parseMyPageVisibility(input.visibility);
      if (!nickname || !visibility || !validRevision(revision)) return fail(400);
      return json(await updateAccount(db, uid, { nickname, visibility, revision }));
    }
    if (action === 'import-wishlist' || action === 'import-reviews') {
      if (!validRevision(input.accountRevision)) return fail(400);
      let current = 0;
      let unavailable = 0;
      let kept = 0;
      if (action === 'import-wishlist') {
        const ids = input.workIds;
        if (!Array.isArray(ids) || ids.length > 20 || !ids.every(isBookDetailId)) return fail(400);
        for (const id of new Set(ids)) {
          const work = await resolveWishlistWork(db, id, 'fresh');
          if (!work) { unavailable++; continue; }
          await updateWishlist(db, uid, work.book.id, true, null, true, input.accountRevision, [...work.equivalentWorkIds, id]);
          current++;
        }
      } else {
        const reviews = input.reviews;
        if (!Array.isArray(reviews) || reviews.length > 20 || !reviews.every((entry) => (
          entry && Array.isArray(entry.workIds) && entry.workIds.every(isBookDetailId)
          && (entry.platformWorkKeys === undefined || (Array.isArray(entry.platformWorkKeys)
            && entry.platformWorkKeys.every((key: unknown) => typeof key === 'string')))
          && (entry.workIds.length > 0 || entry.platformWorkKeys?.length > 0)
          && isReviewInput(entry.rating, entry.comment)
        ))) return fail(400);
        for (const { workIds, platformWorkKeys = [], rating, comment } of reviews) {
          // Bound Firestore lookups for title-only imports without dropping any
          // recorded identity that could change the resolution.
          const work = !platformWorkKeys.length && new Set(workIds).size > 16
            ? null : await resolveLegacyReviewWork(db, workIds, platformWorkKeys);
          if (!work) { unavailable++; continue; }
          const workId = work.book.id;
          const imported = await importReview(
            db, uid, workId, { rating, comment: comment.trim() }, input.accountRevision, work.equivalentWorkIds,
            () => evidenceFor(db, uid, workId, [], 'reading-evidence-import'),
          );
          if (imported) current++;
          else kept++;
        }
      }
      return json({ current, unavailable, kept });
    }

    if (!isBookDetailId(input.workId) || (revision !== null && !validRevision(revision))) return fail(400);
    const importOnly = input.importOnly === true;
    const accountRevision = validRevision(input.accountRevision) ? input.accountRevision : undefined;
    if (importOnly && accountRevision === undefined) return fail(400);
    const detailWorkId = action === 'review' ? input.detailWorkId : undefined;
    if (detailWorkId !== undefined && !isBookDetailId(detailWorkId)) return fail(400);
    const platformWorkKeys = action === 'review' ? input.platformWorkKeys ?? [] : [];
    if (!Array.isArray(platformWorkKeys)
      || !platformWorkKeys.every((key) => typeof key === 'string' && key.length > 0 && key.length <= 1200)) return fail(400);
    if (detailWorkId !== undefined && !platformWorkKeys.length) return fail(400);
    // A saved review remains withdrawable even if its work left the catalog.
    if (action === 'review' && input.remove === true) {
      if (importOnly || !validRevision(revision)) return fail(400);
      if (platformWorkKeys.length) {
        const resolved = await resolveSocialWork(db, input.workId, platformWorkKeys, 'fresh');
        if (!resolved || !resolved.equivalentWorkIds.includes(input.workId)
          || (detailWorkId !== undefined && !resolved.equivalentWorkIds.includes(detailWorkId))) return fail(404);
      }
      return json({ review: await updateReview(db, uid, input.workId, null, revision) });
    }
    const resolved = action === 'wishlist'
      ? await resolveWishlistWork(db, input.workId, 'fresh')
      : await resolveSocialWork(db, input.workId, platformWorkKeys, 'fresh');
    if (!resolved || (revision !== null && platformWorkKeys.length && !resolved.equivalentWorkIds.includes(input.workId))
      || (detailWorkId !== undefined && !resolved.equivalentWorkIds.includes(detailWorkId))) return fail(404);

    if (action === 'wishlist' && typeof input.saved === 'boolean') {
      if (importOnly && !input.saved) return fail(400);
      const expected: unknown = input.siblingRevisions;
      if (expected !== undefined && (importOnly || !Array.isArray(expected)
        || !expected.every((entry) => entry && isBookDetailId(entry.workId) && validRevision(entry.revision))
        || new Set(expected.map(({ workId }) => workId)).size !== expected.length)) return fail(400);
      const expectedSiblings = expected as MyPageWishlistRevision[] | undefined;
      const equivalentIds = new Set([...resolved.equivalentWorkIds, input.workId]);
      const historicalIds = expectedSiblings?.map(({ workId }) => workId).filter((id) => !equivalentIds.has(id)) ?? [];
      // Every supplied historical key must independently resolve to this work.
      for (let start = 0; start < historicalIds.length; start += 20) {
        const matches = await Promise.all(historicalIds.slice(start, start + 20).map((id) => resolveWishlistWork(db, id, 'fresh')));
        if (matches.some((match) => match?.book.id !== resolved.book.id)) return fail(409);
      }
      const targetId = revision === null ? resolved.book.id : input.workId;
      const { siblingRevisions, ...item } = await updateWishlist(
        db, uid, targetId, input.saved, revision, importOnly, accountRevision,
        [...equivalentIds, ...historicalIds], expectedSiblings,
      );
      return json({ item, book: resolved.book, aliases: resolved.equivalentWorkIds, siblingRevisions });
    }
    if (action === 'review') {
      const workId = revision !== null && resolved.equivalentWorkIds.includes(input.workId)
        ? input.workId : resolved.book.id;
      const { rating, comment, fileIds, readingSnapshot, readingSnapshotVersion, saveId } = input;
      if (!isBookRating(rating)
        || typeof comment !== 'string' || comment.length > BOOK_REVIEW_TEXT_LIMIT || /[\r\n]/.test(comment)
        || !Array.isArray(fileIds) || fileIds.length > 32
        || !fileIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 512)
        || (saveId !== undefined && (importOnly || typeof saveId !== 'string' || !REVIEW_SAVE_ID.test(saveId)))) return fail(400);
      const local = readingSnapshot && typeof readingSnapshot === 'object'
        ? parsePublicBookReview({ ...readingSnapshot, rating, comment }) : null;
      if (readingSnapshot != null && !local) return fail(400);
      // v1 validated file identity but did not report whether all history was linked.
      // Unversioned snapshots could include evidence based on the entry screen alone.
      const hasCoverage = readingSnapshotVersion === REVIEW_READING_SNAPSHOT_VERSION;
      if (hasCoverage && typeof input.readingHistoryPartial !== 'boolean') return fail(400);
      const verified = hasCoverage || readingSnapshotVersion === 1 ? local : null;
      // Clients that omitted the snapshot expect server evidence in this response.
      const loadFallback = readingSnapshot === undefined
        ? () => evidenceFor(db, uid, resolved.book.id, fileIds, 'reading-evidence-legacy') : undefined;
      const { review, applied } = await updateReviewWithStatus(
        db, uid, workId, {
          ...verified, rating, comment: comment.trim(),
          readingHistoryPartial: Boolean(verified && (!hasCoverage || input.readingHistoryPartial)),
        }, revision, importOnly, accountRevision,
        resolved.equivalentWorkIds, saveId, loadFallback,
      );
      if (applied && review && review.totalMs == null && review.progressPercent == null && !verified && readingSnapshot !== undefined && !importOnly) {
        after(async () => {
          const snapshot = await evidenceFor(db, uid, resolved.book.id, fileIds, 'reading-evidence-deferred');
          if (snapshot?.totalMs == null || snapshot.progressPercent == null) return;
          await fillReviewReading(db, uid, review, snapshot);
        });
      }
      return json({ review: review && { ...review, ...reviewWorkDetails(resolved) } });
    }
    return fail(400);
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    return fail(status === 409 ? 409 : 503);
  }
}
