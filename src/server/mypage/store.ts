import { createHash, randomBytes, randomInt } from 'node:crypto';
import { AggregateField, FieldPath, FieldValue, GrpcStatus, Timestamp, type DocumentData, type Firestore, type Query, type QuerySnapshot, type Transaction } from 'firebase-admin/firestore';
import { APP_ID } from '../../lib/appIdentity.ts';
import { reportMyPageApiTiming } from './performance.ts';
import { PROFILE_PAGE_SIZE } from './profilePagination.ts';
import { BOOK_REVIEW_TEXT_LIMIT, isBookRating } from '../../lib/publicBookReviews.ts';
import {
  hasPublicMyPage, MY_PAGE_CODE, parseMyPageVisibility, type MyPageAccount, type MyPageBrowseSection, type MyPageIdentity, type MyPageReview,
  type MyPageVisibility, type MyPageWishlistItem, type MyPageWishlistRevision, type PublicWorkReview, type PublicWorkReviews,
} from '../../lib/myPageSocial.ts';

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DEFAULT_NICKNAMES = ['행복한사자', '느긋한고양이', '다정한수달', '호기심많은여우', '책읽는토끼'];
const DEFAULT_VISIBILITY: MyPageVisibility = { reviews: true, wishlist: false };
const BROWSE_READER_PAGE_SIZE = 6;
const REVIEW_LIMIT = 20;
const REVIEW_PAGE_SIZE = 100;
const PROFILE_CACHE_MS = 2 * 60_000;
const MAX_CACHED_PROFILE_SECTIONS = 24;
const MAX_CACHED_PROFILE_ROWS = 1_000;
const MAX_PROFILE_REVISION_ROWS = 4_000;

type ReviewFields = Pick<MyPageReview, 'rating' | 'comment' | 'totalMs' | 'progressPercent'>;
type ReviewReading = Pick<ReviewFields, 'totalMs' | 'progressPercent'>;
type ReviewUpdate = Pick<ReviewFields, 'rating' | 'comment'> & Partial<ReviewReading> & { readingHistoryPartial?: boolean };
const hasReviewReading = (review: ReviewReading | null) => review?.totalMs != null || review?.progressPercent != null;

export class ConflictError extends Error {
  readonly status = 409;

  constructor() {
    super('MyPage revision conflict');
    this.name = 'ConflictError';
  }
}

const library = (db: Firestore, uid: string) => db.doc(`artifacts/${APP_ID}/users/${uid}/libraries/local`);
const ownerRef = (db: Firestore, uid: string) => library(db, uid).collection('myPageSharingV1').doc('settings');
const profiles = (db: Firestore) => db.collection('publicReaderProfilesV1');
const wishlist = (db: Firestore, uid: string) => library(db, uid).collection('myPageWishlistV1');
const reviews = (db: Firestore, uid: string) => library(db, uid).collection('myPageReviewsV1');
const workKey = (workId: string) => createHash('sha256').update(workId).digest('hex');
const workEntries = (db: Firestore, workId: string) => db.collection('publicBookReviewsV1')
  .doc(workKey(workId)).collection('entries');

type ProfileListRevision = { rows: number; sum: number };
type ProfileListCacheEntry = { revision: ProfileListRevision; expires: number; snapshot: QuerySnapshot };
const profileListCaches = new WeakMap<Firestore, Map<string, ProfileListCacheEntry>>();

function validProfileListRevision(revision: ProfileListRevision) {
  return revision.rows <= MAX_PROFILE_REVISION_ROWS
    && Number.isSafeInteger(revision.sum) && revision.sum >= revision.rows;
}

async function readPublicProfileList(
  db: Firestore, uid: string, section: MyPageBrowseSection, collection: Query, source: Query,
) {
  // Both current and older app servers retain deletion records and advance
  // each changed record's revision. Evidence-only writes leave the rows we
  // publish untouched. Counting only visible rows would miss some changes.
  const revisions = collection.orderBy('revision').limit(MAX_PROFILE_REVISION_ROWS + 1).aggregate({
    rows: AggregateField.count(), sum: AggregateField.sum('revision'),
  });
  let cache = profileListCaches.get(db);
  if (!cache) { cache = new Map(); profileListCaches.set(db, cache); }
  const key = JSON.stringify([uid, section]);
  const cached = cache.get(key);
  let revisionChecks = 0;
  if (cached && cached.expires > Date.now()) {
    revisionChecks++;
    const current = await revisions.get().then((result) => result.data()).catch(() => null);
    if (current && current.rows === cached.revision.rows && current.sum === cached.revision.sum) {
      cache.delete(key);
      cache.set(key, cached);
      return { snapshot: cached.snapshot, documentsRead: 0, cacheHit: true, revisionChecks };
    }
  }
  if (cache.get(key) === cached) cache.delete(key);

  const snapshot = await source.get();
  if (snapshot.size > PROFILE_PAGE_SIZE && snapshot.size <= MAX_CACHED_PROFILE_ROWS
    && snapshot.docs.every((document) => {
      const revision = document.get('revision');
      return Number.isSafeInteger(revision) && revision > 0;
    })) {
    revisionChecks++;
    // Pin the version check to the list snapshot so a concurrent edit can't
    // associate old rows with a newer set of revisions.
    const result = await db.runTransaction((transaction) => transaction.get(revisions), {
      readOnly: true, readTime: snapshot.readTime,
    }).catch(() => null);
    const revision = result?.data();
    if (revision && revision.rows >= snapshot.size && validProfileListRevision(revision)) {
      cache.set(key, { revision, expires: Date.now() + PROFILE_CACHE_MS, snapshot });
      while (cache.size > MAX_CACHED_PROFILE_SECTIONS) cache.delete(cache.keys().next().value!);
    }
  }
  return { snapshot, documentsRead: snapshot.size, cacheHit: false, revisionChecks };
}

function publicCode(value: string): string | null {
  const code = value.trim().split('#').at(-1)!.toUpperCase();
  return MY_PAGE_CODE.test(code) ? code : null;
}

function makeCode() {
  return Array.from(randomBytes(8), (byte) => CODE_ALPHABET[byte & 31]).join('');
}

function accountFrom(code: string, data: DocumentData): MyPageAccount {
  const { nickname, revision, visibility } = data;
  return { code, nickname, revision, visibility: parseMyPageVisibility(visibility) ?? { reviews: false, wishlist: false } };
}

function ownedAccount(code: string, data: DocumentData | undefined, uid: string): MyPageAccount {
  if (!data || data.uid !== uid) throw new Error('MyPage account profile is missing or mismatched');
  return accountFrom(code, data);
}

function profileFields(uid: string, account: MyPageAccount) {
  const { nickname, visibility, revision } = account;
  return { uid, nickname, visibility, revision };
}

export async function ensureAccount(db: Firestore, uid: string): Promise<MyPageAccount> {
  const owner = ownerRef(db, uid);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const linked = (await owner.get()).get('code') as string | undefined;
    if (linked) return ownedAccount(linked, (await profiles(db).doc(linked).get()).data(), uid);

    const code = makeCode();
    const nickname = DEFAULT_NICKNAMES[randomInt(DEFAULT_NICKNAMES.length)];
    const account = { code, nickname, visibility: { ...DEFAULT_VISIBILITY }, revision: 1 };
    const batch = db.batch();
    batch.create(profiles(db).doc(code), profileFields(uid, account));
    batch.create(owner, { code });
    try {
      await batch.commit();
      return account;
    } catch (error) {
      if ((error as { code?: number }).code !== GrpcStatus.ALREADY_EXISTS) throw error;
      // A concurrent first request can reserve the owner or the candidate code.
    }
  }
  throw new Error('Unable to allocate a MyPage public code');
}

export async function updateAccount(
  db: Firestore, uid: string, update: Pick<MyPageAccount, 'nickname' | 'visibility' | 'revision'>,
): Promise<MyPageAccount> {
  const linked = (await ownerRef(db, uid).get()).get('code') as string | undefined;
  const code = linked || (await ensureAccount(db, uid)).code;
  const profile = profiles(db).doc(code);
  return db.runTransaction(async (transaction) => {
    const data = (await transaction.get(profile)).data();
    const current = ownedAccount(code, data, uid);
    if (current.revision !== update.revision) throw new ConflictError();
    const visibility = parseMyPageVisibility(data?.visibility);
    if (current.nickname === update.nickname && visibility?.reviews === update.visibility.reviews
      && visibility.wishlist === update.visibility.wishlist) return current;
    const account = { code, nickname: update.nickname, visibility: update.visibility, revision: current.revision + 1 };
    transaction.set(profile, profileFields(uid, account));
    return account;
  });
}

function publicAccount(code: string, data: DocumentData | undefined) {
  if (!data) return null;
  const account = accountFrom(code, data);
  return hasPublicMyPage(account.visibility) ? { uid: data.uid as string, account } : null;
}

export async function lookupPublicAccount(
  db: Firestore, code: string,
): Promise<{ uid: string; account: MyPageAccount } | null> {
  const normalized = publicCode(code);
  if (!normalized) return null;
  return publicAccount(normalized, (await profiles(db).doc(normalized).get()).data());
}

export async function listBrowseReaders(db: Firestore, section: MyPageBrowseSection, cursor: string | null, viewerUid: string | null) {
  const query = profiles(db).where(`visibility.${section}`, '==', true).orderBy(FieldPath.documentId());
  const snapshot = await (cursor ? query.startAfter(cursor) : query).limit(BROWSE_READER_PAGE_SIZE + 1).get();
  const page = snapshot.docs.slice(0, BROWSE_READER_PAGE_SIZE);
  const readers = page.flatMap((document) => {
    const reader = publicAccount(document.id, document.data());
    return reader && reader.uid !== viewerUid && reader.account.visibility[section] ? [reader] : [];
  });
  return { readers, next: snapshot.size > page.length ? page.at(-1)!.id : null };
}

export async function currentBrowseReaders(db: Firestore, codes: readonly string[], section: MyPageBrowseSection) {
  if (codes.length === 0) return new Map<string, number>();
  const snapshots = await db.getAll(...codes.map((code) => profiles(db).doc(code)));
  return new Map(snapshots.flatMap((snapshot) => {
    const reader = publicAccount(snapshot.id, snapshot.data());
    return reader?.account.visibility[section] ? [[snapshot.id, reader.account.revision] as const] : [];
  }));
}

function wishlistItem(data: DocumentData): MyPageWishlistItem {
  const { workId, addedAt, revision, saved } = data;
  return { workId, addedAt, revision, saved };
}

export async function listWishlist(db: Firestore, uid: string, includeRemoved = false, limit?: number): Promise<MyPageWishlistItem[]> {
  const collection = wishlist(db, uid);
  const query = includeRemoved ? collection : collection.where('saved', '==', true);
  if (limit !== undefined) {
    try {
      const snapshot = await query.orderBy('addedAt', 'desc').orderBy('workId', 'asc').limit(limit).get();
      return snapshot.docs.map((document) => wishlistItem(document.data()));
    } catch (error) {
      // Preview and older environments may use the feed while the index builds.
      const failure = error as { code?: number; message?: string };
      if (failure.code !== GrpcStatus.FAILED_PRECONDITION || !/index/i.test(failure.message ?? '')) throw error;
    }
  }
  const snapshot = await query.get();
  const items = snapshot.docs.map((document) => wishlistItem(document.data()))
    .sort((a, b) => b.addedAt - a.addedAt || (limit === undefined
      ? a.workId.localeCompare(b.workId) : Buffer.compare(Buffer.from(a.workId), Buffer.from(b.workId))));
  return limit === undefined ? items : items.slice(0, limit);
}

export async function listPublicProfileWishlist(db: Firestore, uid: string) {
  const collection = wishlist(db, uid);
  const query = collection.where('saved', '==', true).select('workId', 'addedAt', 'revision');
  const { snapshot, ...metrics } = await readPublicProfileList(db, uid, 'wishlist', collection, query);
  const records = snapshot.docs.map((document) => {
    const { workId, addedAt } = document.data() as MyPageWishlistItem;
    return { workId, addedAt };
  });
  return { records, ...metrics };
}

async function verifyImportAccount(
  db: Firestore, transaction: Transaction, uid: string, expectedRevision: number | undefined,
): Promise<string> {
  if (expectedRevision === undefined) throw new ConflictError();
  const code = (await transaction.get(ownerRef(db, uid))).get('code') as string | undefined;
  if (!code) throw new ConflictError();
  const account = ownedAccount(code, (await transaction.get(profiles(db).doc(code))).data(), uid);
  // The confirmed revision binds every visibility flag to the import.
  if (account.revision !== expectedRevision) throw new ConflictError();
  return code;
}

export async function updateWishlist(
  db: Firestore, uid: string, workId: string, saved: boolean, expectedRevision: number | null,
  importOnly = false, importAccountRevision?: number, equivalentWorkIds: readonly string[] = [],
  expectedSiblings?: readonly MyPageWishlistRevision[],
): Promise<MyPageWishlistItem & { siblingRevisions?: MyPageWishlistRevision[] }> {
  const collection = wishlist(db, uid);
  const ref = collection.doc(workKey(workId));
  const alternatives = [...new Set(equivalentWorkIds)].filter((id) => id !== workId);
  return db.runTransaction(async (transaction) => {
    if (importOnly) await verifyImportAccount(db, transaction, uid, importAccountRevision);
    const data = (await transaction.get(ref)).data();
    const current = data ? wishlistItem(data) : null;
    const siblings = alternatives.length && (expectedSiblings || (expectedRevision === null && !current))
      ? (await transaction.getAll(...alternatives.map((id) => collection.doc(workKey(id)))))
        .flatMap((doc) => {
          const data = doc.data();
          return data ? [{ ref: doc.ref, item: wishlistItem(data) }] : [];
        })
      : [];
    if (expectedSiblings) {
      const expected = new Map(expectedSiblings.map(({ workId, revision }) => [workId, revision]));
      const seen = current ? [current, ...siblings.map(({ item }) => item)] : siblings.map(({ item }) => item);
      if (expected.size !== seen.length || seen.some(({ workId, revision }) => expected.get(workId) !== revision)) {
        throw new ConflictError();
      }
    }
    if (expectedRevision === null && !current && siblings.length) {
      if (importOnly) return siblings[0].item;
      throw new ConflictError();
    }
    if (importOnly && current) return current;
    if (!importOnly && expectedRevision !== (current?.revision ?? null)) throw new ConflictError();

    const item = {
      workId,
      addedAt: current?.saved ? current.addedAt : Date.now(),
      revision: (current?.revision ?? 0) + 1,
      saved,
    };
    transaction.set(ref, item);
    if (!expectedSiblings) return item;
    const siblingRevisions = [{ workId: item.workId, revision: item.revision }];
    for (const sibling of siblings) {
      const change = !saved && sibling.item.saved;
      const revision = sibling.item.revision + Number(change);
      if (change) transaction.set(sibling.ref, { ...sibling.item, revision, saved: false });
      siblingRevisions.push({ workId: sibling.item.workId, revision });
    }
    return { ...item, siblingRevisions };
  });
}

function reviewFields(data: DocumentData): ReviewFields {
  const { rating, comment, totalMs, progressPercent } = data;
  return { rating, comment, totalMs, progressPercent };
}

function reviewFrom(data: DocumentData | undefined): MyPageReview | null {
  if (!data || data.deleted) return null;
  return { workId: data.workId, revision: data.revision, ...reviewFields(data) };
}

const validReviewFields = ({ rating, comment, totalMs, progressPercent }: ReviewFields) => (
  isBookRating(rating)
  && typeof comment === 'string' && comment.length <= BOOK_REVIEW_TEXT_LIMIT && !/[\r\n]/.test(comment)
  && (totalMs === null || (Number.isSafeInteger(totalMs) && totalMs >= 0))
  && (progressPercent === null || (Number.isFinite(progressPercent) && progressPercent >= 0 && progressPercent <= 100))
);

export async function readReview(db: Firestore, uid: string, workId: string): Promise<MyPageReview | null> {
  return reviewFrom((await reviews(db, uid).doc(workKey(workId)).get()).data());
}

async function listDatedReviews(db: Firestore, uid: string) {
  const snapshot = await reviews(db, uid).where('deleted', '==', false).get();
  return snapshot.docs.flatMap((document) => {
    const data = document.data();
    const review = reviewFrom(data);
    return review ? [{ review, updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt : null }] : [];
  });
}

export async function listPublicProfileReviews(db: Firestore, uid: string) {
  const collection = reviews(db, uid);
  const query = collection.where('deleted', '==', false).select('workId', 'rating', 'comment', 'updatedAt', 'revision');
  const { snapshot, ...metrics } = await readPublicProfileList(db, uid, 'reviews', collection, query);
  const records = snapshot.docs.map((document) => {
    const { workId, rating, comment, updatedAt } = document.data();
    return { workId, rating, comment, updatedAt: updatedAt instanceof Timestamp ? updatedAt : null } as
      Pick<MyPageReview, 'workId' | 'rating' | 'comment'> & { updatedAt: Timestamp | null };
  });
  return { records, ...metrics };
}

export async function listReviews(db: Firestore, uid: string, latestLimit?: number): Promise<MyPageReview[]> {
  if (latestLimit === undefined) {
    return (await listDatedReviews(db, uid))
      .sort((a, b) => (b.updatedAt?.toMillis() ?? 0) - (a.updatedAt?.toMillis() ?? 0))
      .map(({ review }) => review);
  }
  // Review deletions replace the document without updatedAt.
  const snapshot = await reviews(db, uid).orderBy('updatedAt', 'desc').limit(latestLimit).get();
  return snapshot.docs.map((document) => reviewFrom(document.data())).filter((review) => review !== null);
}

export async function listReviewDeletions(db: Firestore, uid: string) {
  const snapshot = await reviews(db, uid).where('deleted', '==', true).get();
  return snapshot.docs.map((doc) => ({
    workId: doc.get('workId') as string, revision: doc.get('revision') as number,
  }));
}

async function mutateReview(
  db: Firestore, uid: string, workId: string, fields: ReviewUpdate | null, expectedRevision: number | null,
  importOnly = false, importAccountRevision?: number, equivalentWorkIds: readonly string[] = [], saveId?: string,
  fallbackReading?: ReviewReading,
): Promise<{ review: MyPageReview | null; applied: boolean }> {
  const account = importOnly ? null : await ensureAccount(db, uid);
  const ref = reviews(db, uid).doc(workKey(workId));
  return db.runTransaction(async (transaction) => {
    const code = account?.code ?? await verifyImportAccount(db, transaction, uid, importAccountRevision);
    const entry = workEntries(db, workId).doc(code);
    const current = (await transaction.get(ref)).data();
    if (fields && saveId && current?.lastSaveId === saveId && current.revision === (expectedRevision ?? 0) + 1) {
      return { review: reviewFrom(current), applied: false };
    }
    if (expectedRevision === null && !current) {
      const alternatives = [...new Set(equivalentWorkIds)].filter((id) => id !== workId);
      if (alternatives.length) {
        const siblings = await transaction.getAll(...alternatives.map((id) => reviews(db, uid).doc(workKey(id))));
        const previous = siblings.find((doc) => doc.exists)?.data();
        if (previous) {
          if (importOnly) return { review: reviewFrom(previous), applied: false };
          throw new ConflictError();
        }
      }
    }
    if (importOnly && current) return { review: reviewFrom(current), applied: false };
    if (!importOnly && expectedRevision !== (current?.revision ?? null)) throw new ConflictError();

    const revision = (current?.revision ?? 0) + 1;
    if (!fields) {
      transaction.set(ref, { workId, deleted: true, revision });
      transaction.delete(entry);
      return { review: null, applied: true };
    }
    const previous = reviewFrom(current);
    const retained = hasReviewReading(previous) ? previous : fallbackReading;
    const { rating, comment, totalMs = retained?.totalMs ?? null, progressPercent = retained?.progressPercent ?? null } = fields;
    // Deferred server evidence can arrive without advancing the edit revision.
    const losesEvidence = fields.readingHistoryPartial && retained
      && ((retained.totalMs != null && (totalMs == null || totalMs < retained.totalMs))
        || (retained.progressPercent != null && (progressPercent == null || progressPercent < retained.progressPercent)));
    const reading = losesEvidence ? { totalMs: retained.totalMs, progressPercent: retained.progressPercent }
      : { totalMs, progressPercent };
    const review = { workId, revision, rating, comment, ...reading };
    const publishedAt = FieldValue.serverTimestamp();
    transaction.set(ref, { ...review, deleted: false, updatedAt: publishedAt, ...(saveId ? { lastSaveId: saveId } : {}) });
    transaction.set(entry, { workId, code, ...reviewFields(review), publishedAt });
    return { review, applied: true };
  });
}

export async function updateReview(...args: Parameters<typeof mutateReview>) {
  return (await mutateReview(...args)).review;
}

export const updateReviewWithStatus = mutateReview;

export async function fillReviewReading(
  db: Firestore, uid: string, saved: Pick<MyPageReview, 'workId' | 'revision'>,
  snapshot: ReviewReading,
) {
  const code = (await ownerRef(db, uid).get()).get('code') as string | undefined;
  if (!code) return;
  const ref = reviews(db, uid).doc(workKey(saved.workId));
  await db.runTransaction(async (transaction) => {
    const current = reviewFrom((await transaction.get(ref)).data());
    if (current?.revision !== saved.revision || hasReviewReading(current)) return;
    transaction.update(ref, snapshot);
    transaction.update(workEntries(db, saved.workId).doc(code), snapshot);
  });
}

export async function importReview(
  db: Firestore, uid: string, workId: string, fields: ReviewUpdate, accountRevision: number,
  equivalentWorkIds: readonly string[],
) {
  return (await mutateReview(db, uid, workId, fields, null, true, accountRevision, equivalentWorkIds)).applied;
}

type DatedReview = { review: PublicWorkReview; publishedAt: Timestamp };

const newestFirst = (a: DatedReview, b: DatedReview) => (
  b.publishedAt.seconds - a.publishedAt.seconds || b.publishedAt.nanoseconds - a.publishedAt.nanoseconds
);

export async function workPublicReviews(
  db: Firestore, canonicalWorkId: string, equivalentWorkIds: readonly string[] = [],
): Promise<PublicWorkReviews> {
  const started = performance.now();
  const workIds = [...new Set([canonicalWorkId, ...equivalentWorkIds])];
  const firstPage = await workEntries(db, canonicalWorkId).orderBy('publishedAt', 'desc').limit(REVIEW_PAGE_SIZE).get();
  if (workIds.length === 1 && firstPage.empty) {
    reportMyPageApiTiming('book-reviews', started, { reviewRows: 0, authorReads: 0, reviewQueries: 1, returned: 0 });
    return { reviews: [], average: null, ratingCount: 0 };
  }

  const { result, scans } = await db.runTransaction(async (transaction) => {
    const scans = { reviewRows: 0, authorReads: 0, reviewQueries: 0 };
    const byAuthor = workIds.length > 1 ? new Map<string, DatedReview>() : null;
    const publicAuthors = new Map<string, MyPageIdentity | null>();
    const latest: PublicWorkReview[] = [];
    let ratingCount = 0;
    let ratingSum = 0;
    const count = (review: PublicWorkReview) => {
      ratingCount += 1;
      ratingSum += review.rating;
      if (latest.length < REVIEW_LIMIT) latest.push(review);
    };

    for (const workId of workIds) {
      const query = workEntries(db, workId).orderBy('publishedAt', 'desc').limit(REVIEW_PAGE_SIZE);
      let page = workId === canonicalWorkId ? firstPage : await transaction.get(query);
      scans.reviewQueries++;
      while (!page.empty) {
        scans.reviewRows += page.size;
        const entries = page.docs.filter((document) => {
          const { code, workId: storedWorkId, publishedAt } = document.data();
          // Legacy anonymous entries lack the public identity and canonical write shape.
          return code === document.id && publicCode(code) === code
            && storedWorkId === workId && publishedAt instanceof Timestamp && validReviewFields(reviewFields(document.data()));
        });
        if (entries.length > 0) {
          const unknown = entries.filter(({ id }) => !publicAuthors.has(id));
          if (unknown.length) {
            scans.authorReads += unknown.length;
            const authors = await transaction.getAll(...unknown.map(({ id }) => profiles(db).doc(id)),
              { fieldMask: ['nickname', 'visibility'] });
            for (const author of authors) {
              const nickname = author.get('nickname');
              const visibility = parseMyPageVisibility(author.get('visibility'));
              publicAuthors.set(author.id, visibility?.reviews && typeof nickname === 'string'
                ? { code: author.id, nickname } : null);
            }
          }
          for (const entry of entries) {
            const author = publicAuthors.get(entry.id);
            if (!author) continue;
            const data = entry.data();
            const review = { author, ...reviewFields(data) };
            if (!byAuthor) {
              count(review);
              continue;
            }
            const dated = { review, publishedAt: data.publishedAt };
            const previous = byAuthor.get(author.code);
            if (!previous || newestFirst(dated, previous) < 0) byAuthor.set(author.code, dated);
          }
          if (!byAuthor) publicAuthors.clear();
        }
        if (page.size < REVIEW_PAGE_SIZE) break;
        page = await transaction.get(query.startAfter(page.docs[page.docs.length - 1]));
        scans.reviewQueries++;
      }
    }

    if (byAuthor) [...byAuthor.values()].sort(newestFirst).forEach(({ review }) => count(review));
    return { result: { reviews: latest, average: ratingCount > 0 ? ratingSum / ratingCount : null, ratingCount }, scans };
  }, { readOnly: true, readTime: firstPage.readTime });
  reportMyPageApiTiming('book-reviews', started, { ...scans, returned: result.reviews.length });
  return result;
}
