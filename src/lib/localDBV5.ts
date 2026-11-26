import { prepareSyncEventWriter } from './writeLeaseTransport';
import { Book, UserProgress } from '../types';
import type { IDBPTransaction } from 'idb';
import type { StoredBookContent } from './bookContent';
import { initDB, LocalStorageCapacityError } from './localDB';
import {
  V5_ARCHIVE_INSPECTIONS_STORE,
  V5_BOOKS_STORE,
  V5_METADATA_STORE,
  V5_PROGRESS_STORE,
  V5_REMOTE_HEADS_STORE,
  V5_SYNC_CONFLICTS_STORE,
  V5_SYNC_LEASES_STORE,
  V5_SYNC_META_STORE,
  V5_OUTBOX_STORE,
  V8_ANNOTATIONS_STORE,
  V9_ANNOTATION_SETTINGS_STORE,
  V10_ANNOTATION_BOOK_DELETIONS_STORE,
  V11_READING_SESSIONS_STORE,
  V12_READING_STATISTICS_SYNC_STORE,
  readingStatisticsArchiveKey,
  readingStatisticsRecentKey,
  V14_BOOK_COVERS_STORE,
} from './localDBSchema';
import type { ArchiveImageIndex } from './archiveImageBook';
import { DEVICE_CONTENT_OWNER_KEY, isGuestOwner, type OwnerKey } from './ownerIdentity';
import { hasEnoughStorageForWrite } from './storageCapacity';
import { trackLocalCommit } from './localCommitTracker';
import { ANNOTATION_BOOK_DELETE_MARKER_ID } from './annotationPolicy';
import { annotationTargetKeyV1 } from './annotationSyncSchema';
import {
  appendAnnotationEventsToTransactionV5,
  enqueueProgressMutationBatchV5,
  supersedeAnnotationBookWorkForDeletionV5,
  type AnnotationSyncContextV5,
  type SyncOutboxEventV5,
} from './syncOutboxV5';
import { isProgressPositionV2 } from './progressV2Schema';
import { notifyProgressSyncWork } from './progressSyncWake';
import { broadcastAnnotationSyncChange } from './annotationSyncWake';
import { isPendingAnnotationBookDeletionMarkerV5, type AnnotationBookDeletionIntentV10, type ObservedAnnotationBookDeletionV5 } from './annotationBookDeletion';
import { notifyBookCoverCacheChanged } from './bookCoverCache';
import { pendingGuestReadingEdit, type GuestReadingHandoff, type GuestReadingBasis, type GuestReadingPosition } from './guestReadingHandoff';

export type StoredBookMetadataV5 = Book & {
  ownerKey: OwnerKey;
  cachedSize?: number;
};

export type StoredProgressV5 = UserProgress & { ownerKey: OwnerKey };


const getContentSize = (content: StoredBookContent) =>
  content instanceof Blob ? content.size : content.byteLength;

const isQuotaExceededError = (error: unknown) => (
  error instanceof DOMException && error.name === 'QuotaExceededError'
  || (
    typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'QuotaExceededError'
  )
);

const ensureCapacity = async (additionalBytes: number) => {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate && !hasEnoughStorageForWrite(estimate, additionalBytes)) {
      throw new LocalStorageCapacityError();
    }
  } catch (error) {
    if (error instanceof LocalStorageCapacityError) throw error;
    console.warn('[StorageV5] Capacity estimate unavailable:', error);
  }
};

export const saveBookToLocalV5 = async (
  ownerKey: OwnerKey,
  book: Book,
  content: StoredBookContent,
) => {
  const db = await initDB();
  const size = getContentSize(content);
  const existing = await db.get(V5_METADATA_STORE, [ownerKey, book.id]) as
    StoredBookMetadataV5 | undefined;
  const existingSize = existing?.cachedSize ?? 0;
  await ensureCapacity(Math.max(0, size - existingSize));

  const tx = db.transaction([V5_BOOKS_STORE, V5_METADATA_STORE], 'readwrite');
  try {
    await tx.objectStore(V5_BOOKS_STORE).put(content, [ownerKey, book.id]);
    await tx.objectStore(V5_METADATA_STORE).put({
      ...book,
      ownerKey,
      size: book.size ?? size,
      cachedSize: size,
    });
    await tx.done;
  } catch (error) {
    if (isQuotaExceededError(error)) throw new LocalStorageCapacityError();
    throw error;
  }
};

export const loadBookFromLocalV5 = async (ownerKey: OwnerKey, bookId: string) => {
  const db = await initDB();
  return db.get(V5_BOOKS_STORE, [ownerKey, bookId]) as Promise<StoredBookContent | undefined>;
};

export const loadBookMetadataFromLocalV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
) => {
  const db = await initDB();
  return db.get(V5_METADATA_STORE, [ownerKey, bookId]) as
    Promise<StoredBookMetadataV5 | undefined>;
};

export const saveBookMetadataToLocalV5 = async (
  ownerKey: OwnerKey,
  book: Book,
  content: StoredBookContent,
) => {
  const db = await initDB();
  const size = getContentSize(content);
  await db.put(V5_METADATA_STORE, {
    ...book,
    ownerKey,
    size: book.size ?? size,
    cachedSize: size,
  });
};

export const getOfflineBookIdsV5 = async (ownerKey: OwnerKey) => {
  const db = await initDB();
  const keys = await db.getAllKeysFromIndex(V5_METADATA_STORE, 'by-owner', ownerKey) as [OwnerKey, string][];
  return new Set(keys.map(([, id]) => id));
};

export const getAllOfflineBooksV5 = async (ownerKey: OwnerKey) => {
  const db = await initDB();
  return db.getAllFromIndex(V5_METADATA_STORE, 'by-owner', ownerKey) as
    Promise<StoredBookMetadataV5[]>;
};

export const saveProgressToLocalV5 = async (
  ownerKey: OwnerKey,
  progress: UserProgress,
  readingPosition = true,
) => {
  const db = await initDB();
  if (!isGuestOwner(ownerKey)) {
    await db.put(V5_PROGRESS_STORE, { ...progress, ownerKey });
    return;
  }
  const tx = db.transaction([V5_PROGRESS_STORE, V5_SYNC_META_STORE], 'readwrite');
  void tx.done.catch(() => undefined);
  const positions = tx.objectStore(V5_PROGRESS_STORE);
  const [current, handoff] = await Promise.all([
    positions.get([ownerKey, progress.bookId]) as Promise<GuestReadingPosition | undefined>,
    tx.objectStore(V5_SYNC_META_STORE).get([ownerKey, 'guest-reading-handoff']) as Promise<GuestReadingHandoff | undefined>,
  ]);
  const guestReadingEdit = readingPosition && handoff?.confirmed
    ? { generation: handoff.editGeneration ?? handoff.attemptId, id: crypto.randomUUID() }
    : current?.guestReadingEdit;
  await positions.put({ ...progress, ownerKey, guestReadingEdit });
  await tx.done;
};

export const getAllLocalProgressV5 = async (ownerKey: OwnerKey) => {
  const db = await initDB();
  return db.getAllFromIndex(V5_PROGRESS_STORE, 'by-owner', ownerKey) as
    Promise<StoredProgressV5[]>;
};

const guestReadingBasis = ({ syncRevision, acceptedEventId, ignoredRemoteRevision, localPositionToken }: UserProgress): GuestReadingBasis => (
  { syncRevision, acceptedEventId, ignoredRemoteRevision, localPositionToken }
);

export const beginGuestReadingHandoff = async (account: OwnerKey, guest: OwnerKey) => {
  const db = await initDB();
  const tx = db.transaction([V5_SYNC_META_STORE, V5_PROGRESS_STORE], 'readwrite');
  void tx.done.catch(() => undefined);
  const meta = tx.objectStore(V5_SYNC_META_STORE);
  const positions = tx.objectStore(V5_PROGRESS_STORE);
  const prior = await meta.get([guest, 'guest-reading-handoff']) as GuestReadingHandoff | undefined;
  const continuing = prior?.account === account && (prior.confirmed || prior.restoreConfirmedOnCancel);
  const accountRows = await positions.index('by-owner').getAll(account) as StoredProgressV5[];
  const bases = new Map(accountRows.map(row => [row.bookId, guestReadingBasis(row)]));
  if (continuing) {
    const guestRows = await positions.index('by-owner').getAll(guest) as GuestReadingPosition[];
    for (const row of guestRows) {
      if (!pendingGuestReadingEdit(prior, row)) continue;
      // A pending edit still refers to the position from its original logout.
      bases.set(row.bookId, prior.bases?.[row.bookId] ?? {});
    }
  }
  const attemptId = crypto.randomUUID();
  const handoff: GuestReadingHandoff = {
    ownerKey: guest, targetKey: 'guest-reading-handoff', account,
    attemptId, startedAt: continuing ? prior.startedAt : Date.now(), confirmed: false,
    editGeneration: continuing ? prior.editGeneration ?? prior.attemptId : attemptId,
    legacyStartedAt: continuing ? prior.editGeneration ? prior.legacyStartedAt : prior.startedAt : undefined,
    bases: Object.fromEntries(bases),
    importedEditIds: continuing ? prior.importedEditIds : undefined,
    importedThrough: continuing ? prior.importedThrough : undefined,
    restoreConfirmedOnCancel: continuing || undefined,
  };
  await meta.put(handoff);
  await tx.done;
  return handoff;
};

export const readGuestReadingHandoff = async (guest: OwnerKey) => {
  const db = await initDB();
  return db.get(V5_SYNC_META_STORE, [guest, 'guest-reading-handoff']) as Promise<GuestReadingHandoff | undefined>;
};

export const clearGuestReadingHandoff = async (handoff: GuestReadingHandoff, pendingOnly = false) => {
  const db = await initDB();
  const tx = db.transaction(V5_SYNC_META_STORE, 'readwrite');
  void tx.done.catch(() => undefined);
  const key = [handoff.ownerKey, handoff.targetKey];
  const latest = await tx.store.get(key) as GuestReadingHandoff | undefined;
  if (latest?.attemptId === handoff.attemptId && (!pendingOnly || !latest.confirmed)) {
    if (pendingOnly && latest.restoreConfirmedOnCancel) {
      await tx.store.put({ ...latest, confirmed: true, restoreConfirmedOnCancel: undefined });
    } else await tx.store.delete(key);
  }
  await tx.done;
};

export const retainReadingPositionsOnDeviceV5 = async (
  account: OwnerKey, guest: OwnerKey, handoff?: GuestReadingHandoff, refreshConfirmed = false,
) => {
  if (isGuestOwner(account) || !isGuestOwner(guest) || guest === DEVICE_CONTENT_OWNER_KEY) return;
  const db = await initDB();
  const tx = db.transaction([V5_BOOKS_STORE, V5_PROGRESS_STORE, V5_SYNC_META_STORE], 'readwrite');
  void tx.done.catch(() => undefined);
  const meta = tx.objectStore(V5_SYNC_META_STORE);
  let currentHandoff: GuestReadingHandoff | undefined;
  if (handoff) {
    currentHandoff = await meta.get([guest, handoff.targetKey]) as GuestReadingHandoff | undefined;
    if (currentHandoff?.attemptId !== handoff.attemptId || (currentHandoff.confirmed && !refreshConfirmed)) {
      await tx.done;
      return;
    }
  }
  const store = tx.objectStore(V5_PROGRESS_STORE);
  const [accountRows, guestRows] = await Promise.all([
    store.index('by-owner').getAll(account) as Promise<StoredProgressV5[]>,
    store.index('by-owner').getAll(guest) as Promise<Array<StoredProgressV5 & GuestReadingPosition>>,
  ]);
  const guestPositions = new Map(guestRows.map((item) => [item.bookId, item]));
  const books = tx.objectStore(V5_BOOKS_STORE);
  const copiedAfterLogout = new Map<string, number>();
  const copiedBases = new Map<string, GuestReadingBasis>();
  for (const row of accountRows) {
    const { bookId, cfi, anchorCfi, progressPercent, lastRead } = row;
    const current = guestPositions.get(bookId);
    if (currentHandoff && current && pendingGuestReadingEdit(currentHandoff, current)) continue;
    if (!Number.isFinite(lastRead) || lastRead <= (current?.lastRead ?? 0)) continue;
    if (!await books.getKey([DEVICE_CONTENT_OWNER_KEY, bookId])) continue;
    await store.put({ ownerKey: guest, bookId, cfi, anchorCfi, progressPercent, lastRead, bookmarks: current?.bookmarks });
    copiedBases.set(bookId, guestReadingBasis(row));
    if (currentHandoff && lastRead > currentHandoff.startedAt) copiedAfterLogout.set(bookId, lastRead);
  }
  if (currentHandoff) await meta.put({
    ...currentHandoff, confirmed: true, restoreConfirmedOnCancel: undefined,
    bases: { ...currentHandoff.bases, ...Object.fromEntries(copiedBases) },
    importedThrough: { ...currentHandoff.importedThrough, ...Object.fromEntries(copiedAfterLogout) },
  });
  await tx.done;
};

export const restoreGuestReadingToAccountV5 = async (
  account: OwnerKey,
  guest: OwnerKey,
  deviceId: string,
  sessionId: string,
  isCurrent: () => boolean,
  targetBookId?: string,
) => {
  const handoff = await readGuestReadingHandoff(guest);
  if (!handoff || !isCurrent()) return;
  if (handoff.account !== account) {
    await clearGuestReadingHandoff(handoff);
    return;
  }
  if (!handoff.confirmed) return;
  const db = await initDB();
  const rows = targetBookId
    ? [await db.get(V5_PROGRESS_STORE, [guest, targetBookId]) as GuestReadingPosition | undefined].filter(row => row !== undefined)
    : await db.getAllFromIndex(V5_PROGRESS_STORE, 'by-owner', guest) as GuestReadingPosition[];
  let imported: UserProgress | undefined;
  for (const row of rows) {
    if (!isCurrent()) return;
    const edit = pendingGuestReadingEdit(handoff, row);
    if (!edit) continue;
    const { bookId, cfi, anchorCfi, progressPercent, lastRead } = row;
    const position = cfi ? { cfi, anchorCfi: anchorCfi || null, progressPercent } : null;
    if (position ? !isProgressPositionV2(position) : progressPercent !== 0) continue;
    try {
      imported = await enqueueProgressMutationBatchV5(account, {
        progress: { bookId, cfi, anchorCfi, progressPercent, lastRead },
        progressEvent: {
          bookId, operation: position ? 'progress.set' : 'progress.reset', position,
          deviceId, sessionId, localBookmarks: [], occurredAtClient: lastRead,
          causalViewportId: handoff.attemptId,
        },
        bookmarkEvents: [],
      }, { handoff, edit, isCurrent });
    } catch (error) {
      // The recovery worker retries this row after it has the server head.
      if ((error as { code?: string } | null)?.code !== 'sync/resync-required') throw error;
    }
  }
  return imported;
};

export const loadProgressFromLocalV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
): Promise<UserProgress | undefined> => {
  const db = await initDB();
  const stored = await db.get(V5_PROGRESS_STORE, [ownerKey, bookId]) as StoredProgressV5 | undefined;
  if (!stored) return undefined;
  return {
    bookId: stored.bookId,
    cfi: stored.cfi,
    anchorCfi: stored.anchorCfi,
    progressPercent: stored.progressPercent,
    lastRead: stored.lastRead,
    bookmarks: stored.bookmarks,
    syncRevision: stored.syncRevision,
    acceptedEventId: stored.acceptedEventId,
    localPositionToken: stored.localPositionToken,
    ignoredRemoteRevision: stored.ignoredRemoteRevision,
  };
};

export const removeProgressFromLocalV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
) => {
  const db = await initDB();
  await db.delete(V5_PROGRESS_STORE, [ownerKey, bookId]);
};

export const saveArchiveInspectionToLocalV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
  fingerprint: string,
  index: ArchiveImageIndex,
) => {
  const db = await initDB();
  await db.put(V5_ARCHIVE_INSPECTIONS_STORE, {
    ownerKey, bookId, fingerprint, index,
  });
};

export const loadArchiveInspectionFromLocalV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
  fingerprint: string,
) => {
  const db = await initDB();
  const record = await db.get(V5_ARCHIVE_INSPECTIONS_STORE, [ownerKey, bookId]) as
    { fingerprint?: string; index?: ArchiveImageIndex } | undefined;
  return record?.fingerprint === fingerprint ? record.index : undefined;
};

export const removeBookFromLocalV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
) => {
  const db = await initDB();
  const tx = db.transaction([
    V5_BOOKS_STORE,
    V5_METADATA_STORE,
    V5_PROGRESS_STORE,
    V5_ARCHIVE_INSPECTIONS_STORE,
    V14_BOOK_COVERS_STORE,
  ], 'readwrite');
  await Promise.all([
    tx.objectStore(V5_BOOKS_STORE).delete([ownerKey, bookId]),
    tx.objectStore(V5_METADATA_STORE).delete([ownerKey, bookId]),
    tx.objectStore(V5_PROGRESS_STORE).delete([ownerKey, bookId]),
    tx.objectStore(V5_ARCHIVE_INSPECTIONS_STORE).delete([ownerKey, bookId]),
    tx.objectStore(V14_BOOK_COVERS_STORE).delete([ownerKey, bookId]),
  ]);
  await tx.done;
  notifyBookCoverCacheChanged(bookId);
};

export const removeBookAndAnnotationsV8 = (
  annotationOwnerKey: OwnerKey,
  contentOwnerKey: OwnerKey,
  bookId: string,
  syncContext?: AnnotationSyncContextV5,
  observedDeletion?: ObservedAnnotationBookDeletionV5,
) => trackLocalCommit((async () => {
  if (syncContext) await prepareSyncEventWriter(annotationOwnerKey, syncContext.deviceId);
  const db = await initDB();
  const tx = db.transaction([
    V5_BOOKS_STORE,
    V5_METADATA_STORE,
    V5_PROGRESS_STORE,
    V5_ARCHIVE_INSPECTIONS_STORE,
    V14_BOOK_COVERS_STORE,
    V8_ANNOTATIONS_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_META_STORE,
    V5_SYNC_CONFLICTS_STORE,
    V5_REMOTE_HEADS_STORE,
    V10_ANNOTATION_BOOK_DELETIONS_STORE,
  ], 'readwrite');
  void tx.done.catch(() => undefined);
  try {
    const deletionAt = Date.now();
    const annotationStore = tx.objectStore(V8_ANNOTATIONS_STORE);
    let tombstonesQueued = 0;
    let awaitingExistingMarker = observedDeletion?.awaitingMarker === true;
    if (syncContext && !awaitingExistingMarker) {
      const intents = tx.objectStore(V10_ANNOTATION_BOOK_DELETIONS_STORE);
      const [intent, markerMeta] = await Promise.all([
        intents.get([annotationOwnerKey, bookId]) as Promise<AnnotationBookDeletionIntentV10 | undefined>,
        tx.objectStore(V5_SYNC_META_STORE).get([
          annotationOwnerKey, annotationTargetKeyV1(bookId, ANNOTATION_BOOK_DELETE_MARKER_ID),
        ]),
      ]);
      const previousMarker = intent?.markerEventId && !intent.expired && !intent.markerSuperseded
        ? await tx.objectStore(V5_OUTBOX_STORE).get([annotationOwnerKey, intent.markerEventId]) as SyncOutboxEventV5 | undefined
        : undefined;
      const markerQueuedAfterConfirmation = observedDeletion?.nextMarkerSequence !== undefined
        && (markerMeta?.nextSequence ?? 1) > observedDeletion.nextMarkerSequence;
      awaitingExistingMarker = markerQueuedAfterConfirmation
        || (intent?.markerRevision === undefined && isPendingAnnotationBookDeletionMarkerV5(previousMarker));
      // Keep the first request even if it has already acknowledged and finished cleanup.
      if (!awaitingExistingMarker) {
        await supersedeAnnotationBookWorkForDeletionV5(tx, annotationOwnerKey, bookId, deletionAt);
        const [marker] = await appendAnnotationEventsToTransactionV5(tx, annotationOwnerKey, [{
          bookId,
          annotationId: ANNOTATION_BOOK_DELETE_MARKER_ID,
          operation: 'annotation.delete',
          payload: null,
          baseRevision: observedDeletion?.markerRevision,
          bookGeneration: observedDeletion?.markerRevision,
          occurredAtClient: deletionAt,
        }], syncContext);
        if (!marker) throw new Error('도서 주석 삭제 marker를 저장하지 못했습니다.');
        await intents.put({
          ownerKey: annotationOwnerKey,
          bookId,
          createdAt: deletionAt,
          markerEventId: marker.eventId,
          writeLeaseEventId: marker.eventId,
          writeLeaseDeviceId: marker.deviceId,
          lastCheckedAt: null,
        } satisfies AnnotationBookDeletionIntentV10);
        tombstonesQueued = 1;
      }
    }
    const annotationKeys = awaitingExistingMarker ? [] : await annotationStore.index('by-owner-book').getAllKeys([
      annotationOwnerKey,
      bookId,
    ]);
    await Promise.all([
      ...annotationKeys.map((key) => annotationStore.delete(key)),
      tx.objectStore(V5_BOOKS_STORE).delete([contentOwnerKey, bookId]),
      tx.objectStore(V5_METADATA_STORE).delete([contentOwnerKey, bookId]),
      tx.objectStore(V5_PROGRESS_STORE).delete([contentOwnerKey, bookId]),
      tx.objectStore(V5_ARCHIVE_INSPECTIONS_STORE).delete([contentOwnerKey, bookId]),
      tx.objectStore(V14_BOOK_COVERS_STORE).delete([contentOwnerKey, bookId]),
    ]);
    await tx.done;
    notifyBookCoverCacheChanged(bookId);
    if (tombstonesQueued || awaitingExistingMarker) notifyProgressSyncWork(annotationOwnerKey);
    if (annotationKeys.length || tombstonesQueued) {
      broadcastAnnotationSyncChange({ ownerKey: annotationOwnerKey, bookId });
    }
    return {
      annotationsDeleted: annotationKeys.length,
      tombstonesQueued,
    };
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // A failed request may already have aborted the transaction.
    }
    try {
      await tx.done;
    } catch {
      // Preserve the original operation error below.
    }
    throw error;
  }
})());

const deleteByOwnerIndex = async (
  transaction: IDBPTransaction<unknown, [string], 'readwrite'>,
  storeName: string,
  ownerKey: OwnerKey,
) => {
  const store = transaction.objectStore(storeName);
  if (!store.indexNames.contains('by-owner')) return;
  const keys = await store.index('by-owner').getAllKeys(ownerKey);
  await Promise.all(keys.map((key) => store.delete(key)));
};

const deleteByCompoundOwnerKey = async (
  transaction: IDBPTransaction<unknown, [string], 'readwrite'>,
  storeName: string,
  ownerKey: string,
) => {
  const store = transaction.objectStore(storeName);
  const keys = await store.getAllKeys();
  await Promise.all(keys
    .filter((key) => Array.isArray(key) && key[0] === ownerKey)
    .map((key) => store.delete(key)));
};

export const deleteOwnerLocalDataV5 = async (ownerKey: OwnerKey) => {
  const db = await initDB();
  const indexedStores = [
    V5_METADATA_STORE,
    V5_PROGRESS_STORE,
    V5_ARCHIVE_INSPECTIONS_STORE,
    V5_REMOTE_HEADS_STORE,
    V5_SYNC_META_STORE,
    V8_ANNOTATIONS_STORE,
    V10_ANNOTATION_BOOK_DELETIONS_STORE,
    V11_READING_SESSIONS_STORE,
    V14_BOOK_COVERS_STORE,
  ];
  for (const storeName of indexedStores) {
    const tx = db.transaction(storeName, 'readwrite');
    await deleteByOwnerIndex(tx, storeName, ownerKey);
    await tx.done;
  }
  for (const storeName of [
    V5_BOOKS_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_CONFLICTS_STORE,
  ]) {
    const tx = db.transaction(storeName, 'readwrite');
    await deleteByCompoundOwnerKey(tx, storeName, ownerKey);
    await tx.done;
  }
  const tx = db.transaction(V5_SYNC_LEASES_STORE, 'readwrite');
  await tx.objectStore(V5_SYNC_LEASES_STORE).delete(ownerKey);
  await tx.done;
  const settingsTx = db.transaction(V9_ANNOTATION_SETTINGS_STORE, 'readwrite');
  await settingsTx.objectStore(V9_ANNOTATION_SETTINGS_STORE).delete(ownerKey);
  await settingsTx.done;
  const statisticsSyncTx = db.transaction(V12_READING_STATISTICS_SYNC_STORE, 'readwrite');
  await statisticsSyncTx.objectStore(V12_READING_STATISTICS_SYNC_STORE).delete(ownerKey);
  await statisticsSyncTx.objectStore(V12_READING_STATISTICS_SYNC_STORE).delete(readingStatisticsArchiveKey(ownerKey));
  await statisticsSyncTx.objectStore(V12_READING_STATISTICS_SYNC_STORE).delete(readingStatisticsRecentKey(ownerKey));
  await statisticsSyncTx.done;
};
