import type { UserProgress } from '../types';
import { APP_ID } from './appIdentity';
import { initDB } from './localDB';
import {
  V5_OUTBOX_STORE, V5_PROGRESS_STORE, V5_REMOTE_HEADS_STORE,
  V5_SYNC_CONFLICTS_STORE, V5_SYNC_META_STORE, V9_ANNOTATION_SETTINGS_STORE, V8_ANNOTATIONS_STORE,
  V10_ANNOTATION_BOOK_DELETIONS_STORE,
} from './localDBSchema';
import { annotationBookDeletionNeedsRecovery, type AnnotationBookDeletionIntentV10 } from './annotationBookDeletion';
import type { OwnerKey } from './ownerIdentity';
import {
  getFirebaseSyncHistoryPath, parseProgressHeadV2, parseBookmarkHeadV2, progressTargetKeyV2, bookmarkTargetKeyV2,
  type ProgressHeadV2,
} from './progressV2Schema';
import type { SyncOutboxEventV5, RemoteHeadCacheV5, SyncConflictV5, SyncMetaV5 } from './syncOutboxV5';
import { getPendingSyncAuthorityId } from './syncOutboxV5';
import { annotationTargetKeyV1, annotationPaletteTargetKeyV1, getFirebaseAnnotationPalettePath, parseAnnotationPaletteHeadV1, parseAnnotationHeadV1, fromAnnotationSyncPayloadV1, type AnnotationHeadV1 } from './annotationSyncSchema';
import { ANNOTATION_BOOK_DELETE_MARKER_ID } from './annotationPolicy';
import { validateHydratedAnnotations } from './annotationSyncLocal';
import type { Annotation } from '../types';
import { normalizeAnnotationPalette } from './annotationPalette';
import { notifyAnnotationSyncChange } from './annotationSyncWake';
import { notifyProgressSyncWork } from './progressSyncWake';
import { getEventLeaseStatus, parseLeasedEventId } from './writeLeasePolicy';
import { getTrustedWriteLeaseTime, readRecoverableSyncEventIds } from './writeLeaseTransport';
import type { IDBPTransaction } from 'idb';
import type { SyncHeadV2 } from './syncOutboxV5';

type RecoveryEvent = Omit<SyncOutboxEventV5, 'status' | 'target'> & {
  target: SyncOutboxEventV5['target'];
  status: SyncOutboxEventV5['status'] | 'expired';
  recoveryPending?: boolean;
};
const active = new Set(['pending', 'in_flight', 'blocked', 'conflict', 'paused']);
const recoveryTime = (ownerKey: OwnerKey, options: { serverTrustedNow?: number | null }) =>
  options.serverTrustedNow !== undefined ? options.serverTrustedNow : getTrustedWriteLeaseTime(ownerKey);
const requiresRecovery = (event: RecoveryEvent, trustedNow: number | null, recoverablePendingIds: ReadonlySet<string>) => {
  if (trustedNow === null) return false;
  const status = getEventLeaseStatus(event.eventId, trustedNow, true);
  const authorityId = getPendingSyncAuthorityId(event);
  if (status === 'expired') return authorityId === event.eventId || recoverablePendingIds.has(authorityId);
  return status === 'unleased' && !parseLeasedEventId(event.eventId) && recoverablePendingIds.has(authorityId);
};
const targetRange = (ownerKey: OwnerKey, targetKey: string) => IDBKeyRange.bound(
  [ownerKey, targetKey, 0], [ownerKey, targetKey, Number.MAX_SAFE_INTEGER],
);

// Called inside the same transaction that accepts the canonical server snapshot.
// Unknown authority remains blocked; it is never converted into a new lease.
const preserveSuccessorConflict = async (
  tx: IDBPTransaction<unknown, string[], 'readwrite'>, ownerKey: OwnerKey,
  events: RecoveryEvent[], oldConflicts: SyncConflictV5[], head: SyncHeadV2 | null,
  trustedNow: number | null, meta: SyncMetaV5 | undefined, remoteBookGeneration?: number,
): Promise<boolean> => {
  const candidates = events.filter((event) => active.has(event.status)).sort((a, b) => a.sequence - b.sequence);
  if (!candidates.length) return false;
  if (trustedNow === null || candidates.some((event) => getEventLeaseStatus(event.eventId, trustedNow, true) !== 'valid')) return false;
  const first = candidates[0] as SyncOutboxEventV5;
  const latest = candidates[candidates.length - 1] as SyncOutboxEventV5;
  const now = Date.now();
  const conflict: SyncConflictV5 = {
    ownerKey, conflictId: first.eventId, targetKey: first.targetKey, state: 'open',
    event: { ...first, status: 'conflict', claimedByTabId: null, claimedLeaseEpoch: null, claimToken: null },
    remoteHead: head, latestLocalPosition: latest.payload,
    blockedEventIds: candidates.slice(1).map((event) => event.eventId), createdAt: now,
    ...(remoteBookGeneration !== undefined ? { remoteBookGeneration } : {}),
  };
  const outbox = tx.objectStore(V5_OUTBOX_STORE);
  const conflicts = tx.objectStore(V5_SYNC_CONFLICTS_STORE);
  const remotes = tx.objectStore(V5_REMOTE_HEADS_STORE);
  await Promise.all([
    ...candidates.map((event, index) => outbox.put({ ...event, status: index ? 'blocked' : 'conflict',
      claimedByTabId: null, claimedLeaseEpoch: null, claimToken: null, nextAttemptAt: null })),
    ...events.filter((event) => event.status === 'expired' && event.recoveryPending !== false)
      .map((event) => outbox.put({ ...event, recoveryPending: false })),
    ...oldConflicts.filter((old) => old.conflictId !== conflict.conflictId)
      .map((old) => conflicts.put({ ...old, state: 'resolved_remote', resolvedAt: now })),
    conflicts.put(conflict),
    head ? remotes.put({ ownerKey, targetKey: first.targetKey, revision: head.revision, head, updatedAt: now })
      : remotes.delete([ownerKey, first.targetKey]),
    tx.objectStore(V5_SYNC_META_STORE).put({ ownerKey, targetKey: first.targetKey, knownRevision: head?.revision ?? 0,
      nextSequence: meta?.nextSequence ?? 1, updatedAt: now }),
  ]);
  return true;
};

const readTargetRecoveryRows = (
  tx: IDBPTransaction<unknown, string[], 'readonly' | 'readwrite'>,
  ownerKey: OwnerKey,
  targetKey: string,
) => Promise.all([
  tx.objectStore(V5_OUTBOX_STORE).index('by-owner-target-sequence').getAll(targetRange(ownerKey, targetKey)) as Promise<RecoveryEvent[]>,
  tx.objectStore(V5_SYNC_CONFLICTS_STORE).index('by-owner-target-state').getAll([ownerKey, targetKey, 'open']) as Promise<SyncConflictV5[]>,
  tx.objectStore(V5_SYNC_CONFLICTS_STORE).index('by-owner-target-state').getAll([ownerKey, targetKey, 'deferred']) as Promise<SyncConflictV5[]>,
]);

const readRecoverableIds = (ownerKey: OwnerKey, ids: string[], trustedNow: number | null) => trustedNow === null
  ? Promise.resolve(new Set<string>())
  : readRecoverableSyncEventIds(ownerKey, ids);

export const quarantineExpiredSyncWork = async (ownerKey: OwnerKey, targetKey: string, now: number | null = getTrustedWriteLeaseTime(ownerKey), isCurrent: () => boolean = () => true) => {
  if (!isCurrent()) return 0;
  const db = await initDB();
  const stores = [V5_OUTBOX_STORE, V5_SYNC_CONFLICTS_STORE];
  const snapshot = db.transaction(stores);
  const [before, ...beforeConflicts] = await readTargetRecoveryRows(snapshot, ownerKey, targetKey);
  await snapshot.done;
  const recoverablePendingIds = await readRecoverableIds(ownerKey, [
    ...before.map(getPendingSyncAuthorityId),
    ...beforeConflicts.flat().flatMap(({ event }) => event ? [getPendingSyncAuthorityId(event)] : []),
  ], now);
  if (!isCurrent()) return 0;
  const tx = db.transaction(stores, 'readwrite');
  const outbox = tx.objectStore(V5_OUTBOX_STORE);
  const conflicts = tx.objectStore(V5_SYNC_CONFLICTS_STORE);
  const [events, open, deferred] = await readTargetRecoveryRows(tx, ownerKey, targetKey);
  const selected = events.filter((event) => active.has(event.status) && requiresRecovery(event, now, recoverablePendingIds));
  const eventIds = new Set(events.map((event) => event.eventId));
  const orphaned = [...open, ...deferred].flatMap((conflict) => conflict.event && !eventIds.has(conflict.event.eventId)
    && requiresRecovery(conflict.event, now, recoverablePendingIds) ? [conflict.event] : []);
  selected.push(...orphaned);
  const selectedIds = new Set(selected.map((event) => event.eventId));
  const freeze = selected.length > 0 || events.some((event) => event.status === 'expired' && event.recoveryPending !== false);
  if (!isCurrent()) { await tx.done; return 0; }
  await Promise.all([
    ...selected.map((event) => outbox.put({ ...event, status: 'expired', recoveryPending: true,
      lastErrorCode: 'sync/write-lease-expired', nextAttemptAt: null,
      claimedByTabId: null, claimedLeaseEpoch: null, claimToken: null })),
    ...(freeze ? events.filter((event) => active.has(event.status) && !selectedIds.has(event.eventId) && parseLeasedEventId(event.eventId)) : [])
      .map((event) => outbox.put({ ...event, status: 'blocked', nextAttemptAt: null,
        claimedByTabId: null, claimedLeaseEpoch: null, claimToken: null })),
    ...[...open, ...deferred].filter((conflict) => conflict.event && selectedIds.has(conflict.event.eventId)
      && !conflict.blockedEventIds.some((id) => !selectedIds.has(id)))
      .map((conflict) => conflicts.put({ ...conflict, state: 'resolved_remote', resolvedAt: now ?? Date.now() })),
  ]);
  await tx.done;
  return selected.length;
};

export const quarantineExpiredProgressWork = (ownerKey: OwnerKey, bookId: string, now: number | null = getTrustedWriteLeaseTime(ownerKey)) =>
  quarantineExpiredSyncWork(ownerKey, progressTargetKeyV2(bookId), now);

export const hasExpiredSyncRecoveryPending = async (ownerKey: OwnerKey, targetKey: string) => {
  const db = await initDB();
  const events = await db.getAllFromIndex(V5_OUTBOX_STORE, 'by-owner-target-sequence',
    targetRange(ownerKey, targetKey)) as RecoveryEvent[];
  return events.some((event) => event.status === 'expired' && event.recoveryPending !== false);
};

export const hasExpiredProgressRecoveryPending = (ownerKey: OwnerKey, bookId: string) =>
  hasExpiredSyncRecoveryPending(ownerKey, progressTargetKeyV2(bookId));

export const listExpiredSyncRecoveryTargets = async (ownerKey: OwnerKey, trustedNow: number | null = getTrustedWriteLeaseTime(ownerKey)) => {
  const db = await initDB();
  const events = (await Promise.all([...active, 'expired', 'superseded'].map((status) =>
    db.getAllFromIndex(V5_OUTBOX_STORE, 'by-owner-status', [ownerKey, status]) as Promise<RecoveryEvent[]>))).flat();
  const [conflicts, intents] = await Promise.all([
    Promise.all(['open', 'deferred'].map((state) => db.getAllFromIndex(V5_SYNC_CONFLICTS_STORE, 'by-owner-state-created-at',
      IDBKeyRange.bound([ownerKey, state, 0], [ownerKey, state, Number.MAX_SAFE_INTEGER])) as Promise<SyncConflictV5[]>))
      .then((rows) => rows.flat()),
    db.getAllFromIndex(V10_ANNOTATION_BOOK_DELETIONS_STORE, 'by-owner', ownerKey) as Promise<AnnotationBookDeletionIntentV10[]>,
  ]);
  const recoverablePendingIds = await readRecoverableIds(ownerKey, [
    ...events.filter((event) => active.has(event.status)).map(getPendingSyncAuthorityId),
    ...conflicts.flatMap(({ event }) => event ? [getPendingSyncAuthorityId(event)] : []),
    ...intents.flatMap(({ markerEventId }) => markerEventId ? [markerEventId] : []),
  ], trustedNow);
  const targets = new Map<string, SyncOutboxEventV5['target']>();
  for (const event of events) {
    if (((event.status === 'expired' && event.recoveryPending !== false)
      || (active.has(event.status) && requiresRecovery(event, trustedNow, recoverablePendingIds)))
      && !targets.has(event.targetKey)) targets.set(event.targetKey, event.target);
  }
  for (const conflict of conflicts) {
    if (conflict.event && requiresRecovery(conflict.event, trustedNow, recoverablePendingIds) && !targets.has(conflict.targetKey)) {
      targets.set(conflict.targetKey, conflict.event.target);
    }
  }
  if (intents.length) {
    const eventsById = new Map(events.map(event => [event.eventId, event]));
    for (const intent of intents) {
      const marker = intent.markerEventId ? eventsById.get(intent.markerEventId) : undefined;
      if (annotationBookDeletionNeedsRecovery(intent, trustedNow, recoverablePendingIds, marker)) {
        const target = { kind: 'annotation' as const, bookId: intent.bookId, annotationId: ANNOTATION_BOOK_DELETE_MARKER_ID };
        targets.set(annotationTargetKeyV1(intent.bookId, target.annotationId), target);
      }
    }
  }
  return [...targets.values()];
};

export const listExpiredProgressRecoveryBooks = async (ownerKey: OwnerKey) => {
  const db = await initDB();
  const events = await db.getAllFromIndex(V5_OUTBOX_STORE, 'by-owner-status', [ownerKey, 'expired']) as RecoveryEvent[];
  return [...new Set(events.flatMap((event) => event.target.kind === 'progress' && event.recoveryPending !== false
    ? [event.target.bookId] : []))];
};

const fetchServerHead = async (uid: string, bookId: string): Promise<unknown | null> => {
  const [{ doc, getDocFromServer }, { db }] = await Promise.all([
    import('firebase/firestore'), import('./firebase'),
  ]);
  const snapshot = await getDocFromServer(doc(db, getFirebaseSyncHistoryPath(APP_ID, uid), bookId));
  if (snapshot.metadata.hasPendingWrites) throw new Error('Server progress head has pending writes');
  return snapshot.exists() ? snapshot.data() : null;
};

export const recoverExpiredProgressFromServer = async (
  uid: string, ownerKey: OwnerKey, bookId: string,
  options: { fetchHead?: (uid: string, bookId: string) => Promise<unknown | null>; isCurrent?: () => boolean; serverTrustedNow?: number | null } = {},
): Promise<{ status: 'resynced'; progress: UserProgress } | { status: 'conflict' } | { status: 'blocked' }> => {
  if (options.isCurrent && !options.isCurrent()) return { status: 'blocked' };
  await quarantineExpiredSyncWork(ownerKey, progressTargetKeyV2(bookId), recoveryTime(ownerKey, options), options.isCurrent);
  if (options.isCurrent && !options.isCurrent()) return { status: 'blocked' };
  const rawHead = await (options.fetchHead ?? fetchServerHead)(uid, bookId);
  if (options.isCurrent && !options.isCurrent()) return { status: 'blocked' };
  const head: ProgressHeadV2 | null = rawHead === null ? null : parseProgressHeadV2(rawHead);
  if (head && head.bookId !== bookId) throw new Error('Server progress head bookId mismatch');
  const targetKey = progressTargetKeyV2(bookId);
  const db = await initDB();
  const tx = db.transaction([V5_PROGRESS_STORE, V5_REMOTE_HEADS_STORE, V5_SYNC_META_STORE,
    V5_OUTBOX_STORE, V5_SYNC_CONFLICTS_STORE], 'readwrite');
  const outbox = tx.objectStore(V5_OUTBOX_STORE);
  const conflictStore = tx.objectStore(V5_SYNC_CONFLICTS_STORE);
  const remoteStore = tx.objectStore(V5_REMOTE_HEADS_STORE);
  const metaStore = tx.objectStore(V5_SYNC_META_STORE);
  const progressStore = tx.objectStore(V5_PROGRESS_STORE);
  const [events, open, deferred, existing, remote, meta] = await Promise.all([
    outbox.index('by-owner-target-sequence').getAll(targetRange(ownerKey, targetKey)) as Promise<RecoveryEvent[]>,
    conflictStore.index('by-owner-target-state').getAll([ownerKey, targetKey, 'open']) as Promise<SyncConflictV5[]>,
    conflictStore.index('by-owner-target-state').getAll([ownerKey, targetKey, 'deferred']) as Promise<SyncConflictV5[]>,
    progressStore.get([ownerKey, bookId]) as Promise<UserProgress | undefined>,
    remoteStore.get([ownerKey, targetKey]) as Promise<RemoteHeadCacheV5 | undefined>,
    metaStore.get([ownerKey, targetKey]) as Promise<SyncMetaV5 | undefined>,
  ]);
  const pending = events.filter((event) => event.status === 'expired' && event.recoveryPending !== false);
  if ((options.isCurrent && !options.isCurrent()) || !pending.length
    || (!head && remote)
    || (head && remote && (remote.revision > head.revision
      || (remote.revision === head.revision && remote.head.acceptedEventId !== head.acceptedEventId)))) {
    await tx.done;
    return { status: 'blocked' };
  }
  if (events.some((event) => active.has(event.status))) {
    const preserved = await preserveSuccessorConflict(tx, ownerKey, events, [...open, ...deferred], head,
      recoveryTime(ownerKey, options), meta);
    await tx.done;
    if (preserved) notifyProgressSyncWork(ownerKey);
    return preserved ? { status: 'conflict' } : { status: 'blocked' };
  }
  if (open.length || deferred.length) { await tx.done; return { status: 'blocked' }; }
  const revision = head?.revision ?? 0;
  const time = head?.updatedAtServer as { toDate?: () => Date } | undefined;
  const position = head?.operation === 'set' ? head.position : null;
  const progress: UserProgress = {
    bookId, cfi: position?.cfi ?? '', anchorCfi: position?.anchorCfi ?? position?.cfi ?? '',
    progressPercent: position?.progressPercent ?? 0,
    lastRead: time?.toDate ? time.toDate().getTime() : 0,
    bookmarks: existing?.bookmarks ?? [], syncRevision: revision,
    ...(head ? { acceptedEventId: head.acceptedEventId } : {}),
    ...(existing?.ignoredRemoteRevision && existing.ignoredRemoteRevision > revision
      ? { ignoredRemoteRevision: existing.ignoredRemoteRevision } : {}),
  };
  const now = Date.now();
  if (options.isCurrent && !options.isCurrent()) { await tx.done; return { status: 'blocked' }; }
  await Promise.all([
    progressStore.put({ ...progress, ownerKey }),
    head ? remoteStore.put({ ownerKey, targetKey, revision, head, updatedAt: now }) : remoteStore.delete([ownerKey, targetKey]),
    metaStore.put({ ownerKey, targetKey, nextSequence: meta?.nextSequence ?? 1, knownRevision: revision, updatedAt: now }),
    ...pending.map((event) => outbox.put({ ...event, recoveryPending: false })),
  ]);
  await tx.done;
  return { status: 'resynced', progress };
};

type SyncTarget = SyncOutboxEventV5['target'];
export type ExpiredSyncProgressUpdate = {
  ownerKey: OwnerKey;
  progress: UserProgress;
} & ({ kind: 'progress' } | { kind: 'bookmark'; bookmarkId: string });

type RecoveryOptions = {
  serverTrustedNow?: number | null;
  fetchHead?: (uid: string, target: SyncTarget) => Promise<unknown | null>;
  isCurrent?: () => boolean;
  fetchAnnotationBook?: (uid: string, bookId: string, annotationId: string) => Promise<{ heads: unknown[]; marker: unknown | null; targetHead?: unknown | null }>;
};

const getTargetKey = (target: SyncTarget) => {
  switch (target.kind) {
    case 'progress': return progressTargetKeyV2(target.bookId);
    case 'bookmark': return bookmarkTargetKeyV2(target.bookId, target.bookmarkId);
    case 'annotation': return annotationTargetKeyV1(target.bookId, target.annotationId);
    case 'palette': return annotationPaletteTargetKeyV1();
  }
};

const fetchOtherHead = async (uid: string, target: Extract<SyncTarget, { kind: 'bookmark' | 'palette' }>) => {
  const [{ doc, getDocFromServer }, { db }] = await Promise.all([
    import('firebase/firestore'), import('./firebase'),
  ]);
  const path = target.kind === 'bookmark'
    ? `${getFirebaseSyncHistoryPath(APP_ID, uid)}/${target.bookId}/bookmarks/${target.bookmarkId}`
    : getFirebaseAnnotationPalettePath(APP_ID, uid);
  const snapshot = await getDocFromServer(doc(db, path));
  if (snapshot.metadata.hasPendingWrites) throw new Error('Server sync head has pending writes');
  return snapshot.exists() ? snapshot.data() : null;
};

export const recoverExpiredSyncTargetFromServer = async (
  uid: string, ownerKey: OwnerKey, target: SyncTarget, options: RecoveryOptions = {},
): Promise<{ status: 'resynced'; progress?: UserProgress } | { status: 'conflict' } | { status: 'blocked' }> => {
  if (target.kind === 'progress') {
    return recoverExpiredProgressFromServer(uid, ownerKey, target.bookId, {
      isCurrent: options.isCurrent,
      serverTrustedNow: options.serverTrustedNow,
      fetchHead: options.fetchHead ? (id) => options.fetchHead!(id, target) : undefined,
    });
  }
  if (options.isCurrent && !options.isCurrent()) return { status: 'blocked' };
  if (target.kind === 'annotation' && target.annotationId === ANNOTATION_BOOK_DELETE_MARKER_ID) {
    return recoverAnnotationBookDeletion(uid, ownerKey, target, options);
  }
  const targetKey = getTargetKey(target);
  await quarantineExpiredSyncWork(ownerKey, targetKey, recoveryTime(ownerKey, options), options.isCurrent);
  if (options.isCurrent && !options.isCurrent()) return { status: 'blocked' };
  if (target.kind === 'annotation') return recoverAnnotation(uid, ownerKey, target, options);
  const raw = await (options.fetchHead ? options.fetchHead(uid, target) : fetchOtherHead(uid, target));
  if (options.isCurrent && !options.isCurrent()) return { status: 'blocked' };
  const head = raw === null ? null : target.kind === 'bookmark'
    ? parseBookmarkHeadV2(raw) : parseAnnotationPaletteHeadV1(raw);
  if (head && target.kind === 'bookmark'
    && (!('bookmarkId' in head) || head.bookId !== target.bookId || head.bookmarkId !== target.bookmarkId)) {
    throw new Error('Server bookmark head identity mismatch');
  }
  const db = await initDB();
  const tx = db.transaction([V5_OUTBOX_STORE, V5_SYNC_CONFLICTS_STORE, V5_REMOTE_HEADS_STORE,
    V5_SYNC_META_STORE, V5_PROGRESS_STORE, V9_ANNOTATION_SETTINGS_STORE], 'readwrite');
  const outbox = tx.objectStore(V5_OUTBOX_STORE);
  const conflicts = tx.objectStore(V5_SYNC_CONFLICTS_STORE).index('by-owner-target-state');
  const remotes = tx.objectStore(V5_REMOTE_HEADS_STORE);
  const metas = tx.objectStore(V5_SYNC_META_STORE);
  const [events, open, deferred, remote, meta, existing] = await Promise.all([
    outbox.index('by-owner-target-sequence').getAll(targetRange(ownerKey, targetKey)) as Promise<RecoveryEvent[]>,
    conflicts.getAll([ownerKey, targetKey, 'open']), conflicts.getAll([ownerKey, targetKey, 'deferred']),
    remotes.get([ownerKey, targetKey]) as Promise<RemoteHeadCacheV5 | undefined>,
    metas.get([ownerKey, targetKey]) as Promise<SyncMetaV5 | undefined>,
    target.kind === 'bookmark' ? tx.objectStore(V5_PROGRESS_STORE).get([ownerKey, target.bookId]) as Promise<UserProgress | undefined> : Promise.resolve(undefined),
  ]);
  const pending = events.filter((event) => event.status === 'expired' && event.recoveryPending !== false);
  if ((options.isCurrent && !options.isCurrent()) || !pending.length
    || (!head && remote) || (head && remote && (remote.revision > head.revision
      || (remote.revision === head.revision && remote.head.acceptedEventId !== head.acceptedEventId)))) {
    await tx.done;
    return { status: 'blocked' };
  }
  if (events.some((event) => active.has(event.status))) {
    const preserved = await preserveSuccessorConflict(tx, ownerKey, events, [...open, ...deferred] as SyncConflictV5[], head,
      recoveryTime(ownerKey, options), meta);
    await tx.done;
    if (preserved) notifyProgressSyncWork(ownerKey);
    return preserved ? { status: 'conflict' } : { status: 'blocked' };
  }
  if (open.length || deferred.length) { await tx.done; return { status: 'blocked' }; }
  const now = Date.now();
  let progress: UserProgress | undefined;
  if (target.kind === 'bookmark') {
    const bookmarks = (existing?.bookmarks ?? []).filter((bookmark) => !(bookmark.type === 'manual' && bookmark.id === target.bookmarkId));
    if (head && 'bookmark' in head && head.operation === 'upsert' && head.bookmark) {
      const bookmark = head.bookmark;
      bookmarks.push({ id: bookmark.bookmarkId, type: 'manual', cfi: bookmark.cfi, name: bookmark.name,
        color: bookmark.color, progressPercent: bookmark.progressPercent ?? undefined, createdAt: bookmark.createdAtClient });
    }
    progress = { ...existing, bookId: target.bookId, cfi: existing?.cfi ?? '', anchorCfi: existing?.anchorCfi ?? '',
      progressPercent: existing?.progressPercent ?? 0, lastRead: existing?.lastRead ?? 0, bookmarks };
  }
  if (options.isCurrent && !options.isCurrent()) { await tx.done; return { status: 'blocked' }; }
  const revision = head?.revision ?? 0;
  await Promise.all([
    progress ? tx.objectStore(V5_PROGRESS_STORE).put({ ...progress, ownerKey }) : Promise.resolve(),
    target.kind === 'palette' ? tx.objectStore(V9_ANNOTATION_SETTINGS_STORE).put({
      ownerKey, palette: normalizeAnnotationPalette(head && 'palette' in head ? head.palette.items : undefined),
      updatedAt: now, syncRevision: revision, ...(head ? { acceptedEventId: head.acceptedEventId } : {}),
    }) : Promise.resolve(),
    head ? remotes.put({ ownerKey, targetKey, revision, head, updatedAt: now }) : remotes.delete([ownerKey, targetKey]),
    metas.put({ ownerKey, targetKey, knownRevision: revision, nextSequence: meta?.nextSequence ?? 1, updatedAt: now }),
    ...pending.map((event) => outbox.put({ ...event, recoveryPending: false })),
  ]);
  await tx.done;
  if (target.kind === 'palette') notifyAnnotationSyncChange({ ownerKey, palette: normalizeAnnotationPalette(head && 'palette' in head ? head.palette.items : undefined) });
  return progress ? { status: 'resynced', progress } : { status: 'resynced' };
};

// Read twice to detect an aggregate, target, or deletion marker changing during
// the multi-document server read. A later remote change remains a normal sync update.
const fetchAnnotationBook = async (uid: string, bookId: string, annotationId: string) => {
  const { getAuthoritativeRemoteAnnotationHeadsV1, getAuthoritativeRemoteAnnotationHeadV1 } = await import('./annotationSyncRemote');
  const read = async () => {
    const [heads, marker, targetHead] = await Promise.all([
      getAuthoritativeRemoteAnnotationHeadsV1(uid, bookId),
      getAuthoritativeRemoteAnnotationHeadV1(uid, bookId, ANNOTATION_BOOK_DELETE_MARKER_ID),
      getAuthoritativeRemoteAnnotationHeadV1(uid, bookId, annotationId),
    ]);
    return { heads, marker, targetHead };
  };
  const first = await read();
  const second = await read();
  const signature = (value: typeof first) => JSON.stringify({
    heads: value.heads.map((head) => [head.annotationId, head.revision, head.acceptedEventId]).sort(),
    marker: value.marker && [value.marker.revision, value.marker.acceptedEventId],
    target: value.targetHead && [value.targetHead.revision, value.targetHead.acceptedEventId],
  });
  if (signature(first) !== signature(second)) throw new Error('Annotation book changed during recovery');
  return second;
};

const recoverAnnotationBookDeletion = async (
  uid: string, ownerKey: OwnerKey, target: Extract<SyncTarget, { kind: 'annotation' }>, options: RecoveryOptions,
): Promise<{ status: 'resynced' } | { status: 'conflict' } | { status: 'blocked' }> => {
  const db = await initDB();
  const prefix = `annotation:${target.bookId}:`;
  const trustedNow = recoveryTime(ownerKey, options);
  const [beforeIntent, beforeEvents] = await Promise.all([
    db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerKey, target.bookId]) as Promise<AnnotationBookDeletionIntentV10 | undefined>,
    Promise.all([...active].map((status) => db.getAllFromIndex(V5_OUTBOX_STORE, 'by-owner-status', [ownerKey, status]) as Promise<RecoveryEvent[]>)),
  ]);
  const isBookAnnotation = (event: RecoveryEvent) => event.target.kind === 'annotation' && event.target.bookId === target.bookId;
  const recoverablePendingIds = await readRecoverableIds(ownerKey, [
    ...(beforeIntent?.markerEventId ? [beforeIntent.markerEventId] : []),
    ...beforeEvents.flat().filter(isBookAnnotation).map(getPendingSyncAuthorityId),
  ], trustedNow);
  // Freeze the old book work and intent together before making any network request.
  const freeze = db.transaction([V10_ANNOTATION_BOOK_DELETIONS_STORE, V5_OUTBOX_STORE, V5_SYNC_CONFLICTS_STORE, V5_REMOTE_HEADS_STORE], 'readwrite');
  const intents = freeze.objectStore(V10_ANNOTATION_BOOK_DELETIONS_STORE);
  const outbox = freeze.objectStore(V5_OUTBOX_STORE);
  const conflicts = freeze.objectStore(V5_SYNC_CONFLICTS_STORE);
  const [intent, baselineRemotes, oldConflicts, statusEvents] = await Promise.all([
    intents.get([ownerKey, target.bookId]) as Promise<AnnotationBookDeletionIntentV10 | undefined>,
    freeze.objectStore(V5_REMOTE_HEADS_STORE).index('by-owner').getAll(ownerKey) as Promise<RemoteHeadCacheV5[]>,
    Promise.all(['open', 'deferred'].map((state) => conflicts.index('by-owner-state-created-at').getAll(
      IDBKeyRange.bound([ownerKey, state, 0], [ownerKey, state, Number.MAX_SAFE_INTEGER])) as Promise<SyncConflictV5[]>)),
    Promise.all([...active, 'expired', 'superseded'].map((status) => outbox.index('by-owner-status').getAll([ownerKey, status]) as Promise<RecoveryEvent[]>)),
  ]);
  const pendingMarker = intent?.markerEventId
    ? await outbox.get([ownerKey, intent.markerEventId]) as SyncOutboxEventV5 | undefined : undefined;
  if (!intent || !annotationBookDeletionNeedsRecovery(intent, trustedNow, recoverablePendingIds, pendingMarker)
    || (options.isCurrent && !options.isCurrent())) {
    await freeze.done; return { status: 'blocked' };
  }
  const frozenIntent = { ...intent, expired: true, recoveryPending: true };
  const events = statusEvents.flat().filter((event) => active.has(event.status) && isBookAnnotation(event));
  const unresolved = oldConflicts.flat().filter((conflict) => conflict.targetKey.startsWith(prefix));
  const isUnprovenDelete = (event: RecoveryEvent) => 'forceDelete' in event && event.forceDelete === true;
  const expiredEvents = events.filter((event) => isUnprovenDelete(event) || requiresRecovery(event, trustedNow, recoverablePendingIds));
  if (events.some((event) => {
    const authorityId = getPendingSyncAuthorityId(event);
    if (recoverablePendingIds.has(authorityId)) return false;
    if (authorityId === event.eventId) return !parseLeasedEventId(event.eventId);
    return trustedNow === null || getEventLeaseStatus(event.eventId, trustedNow, true) !== 'valid';
  })) {
    await freeze.done; return { status: 'blocked' };
  }
  const expiredIds = new Set(expiredEvents.map((event) => event.eventId));
  if (options.isCurrent && !options.isCurrent()) { await freeze.done; return { status: 'blocked' }; }
  const now = Date.now();
  await Promise.all([
    intents.put(frozenIntent),
    ...expiredEvents.map((event) => outbox.put({ ...event, status: 'expired', recoveryPending: true,
      lastErrorCode: isUnprovenDelete(event) ? 'sync/annotation-delete-unproven' : 'sync/write-lease-expired', nextAttemptAt: null, claimedByTabId: null, claimedLeaseEpoch: null, claimToken: null })),
    ...events.filter((event) => !expiredIds.has(event.eventId)).map((event) => outbox.put({ ...event,
      status: 'blocked', nextAttemptAt: null, claimedByTabId: null, claimedLeaseEpoch: null, claimToken: null })),
    ...unresolved.filter((conflict) => conflict.event && expiredIds.has(conflict.event.eventId)
      && !conflict.blockedEventIds.some((id) => !expiredIds.has(id)))
      .map((conflict) => conflicts.put({ ...conflict, state: 'resolved_remote', resolvedAt: now })),
  ]);
  await freeze.done;

  const raw = await (options.fetchAnnotationBook ?? fetchAnnotationBook)(uid, target.bookId, target.annotationId);
  if (options.isCurrent && !options.isCurrent()) return { status: 'blocked' };
  const heads = raw.heads.map(parseAnnotationHeadV1);
  const marker = raw.marker === null ? null : parseAnnotationHeadV1(raw.marker);
  const targetHead = raw.targetHead == null ? null : parseAnnotationHeadV1(raw.targetHead);
  if (heads.some((head) => head.bookId !== target.bookId || head.operation !== 'upsert' || head.annotationId === ANNOTATION_BOOK_DELETE_MARKER_ID)
    || new Set(heads.map((head) => head.annotationId)).size !== heads.length
    || (marker && (marker.bookId !== target.bookId || marker.annotationId !== ANNOTATION_BOOK_DELETE_MARKER_ID || marker.operation !== 'delete'))
    || (raw.targetHead !== undefined && ((targetHead?.revision ?? 0) !== (marker?.revision ?? 0)
      || (targetHead?.acceptedEventId ?? null) !== (marker?.acceptedEventId ?? null)))) {
    throw new Error('Invalid annotation recovery book identity');
  }
  const positions = heads.filter((head) => (head.bookGeneration ?? 0) >= (marker?.revision ?? 0))
    .map((head) => fromAnnotationSyncPayloadV1(head.annotation!));
  try { validateHydratedAnnotations(positions); } catch { return { status: 'blocked' }; }
  const tx = db.transaction([V10_ANNOTATION_BOOK_DELETIONS_STORE, V8_ANNOTATIONS_STORE, V5_OUTBOX_STORE,
    V5_SYNC_CONFLICTS_STORE, V5_REMOTE_HEADS_STORE, V5_SYNC_META_STORE], 'readwrite');
  const store = tx.objectStore(V5_OUTBOX_STORE);
  const remoteStore = tx.objectStore(V5_REMOTE_HEADS_STORE);
  const metaStore = tx.objectStore(V5_SYNC_META_STORE);
  const annotations = tx.objectStore(V8_ANNOTATIONS_STORE);
  const conflictIndex = tx.objectStore(V5_SYNC_CONFLICTS_STORE).index('by-owner-state-created-at');
  const [currentIntent, ...rest] = await Promise.all([
    tx.objectStore(V10_ANNOTATION_BOOK_DELETIONS_STORE).get([ownerKey, target.bookId]) as Promise<AnnotationBookDeletionIntentV10 | undefined>,
    ...[...active, 'expired'].map((status) => store.index('by-owner-status').getAll([ownerKey, status])),
    remoteStore.index('by-owner').getAll(ownerKey), metaStore.index('by-owner').getAll(ownerKey),
    annotations.index('by-owner-book').getAll([ownerKey, target.bookId]),
    ...['open', 'deferred'].map((state) => conflictIndex.getAll(IDBKeyRange.bound([ownerKey, state, 0], [ownerKey, state, Number.MAX_SAFE_INTEGER]))),
  ]);
  const count = active.size + 1;
  const allEvents = (rest.slice(0, count) as RecoveryEvent[][]).flat().filter((event) => event.target.kind === 'annotation' && event.target.bookId === target.bookId);
  const remotes = (rest[count] as RemoteHeadCacheV5[]).filter((item) => item.targetKey.startsWith(prefix));
  const metas = (rest[count + 1] as SyncMetaV5[]).filter((item) => item.targetKey.startsWith(prefix));
  const stored = rest[count + 2] as Annotation[];
  const open = (rest.slice(count + 3) as SyncConflictV5[][]).flat().filter((item) => item.targetKey.startsWith(prefix));
  const incoming = new Map(heads.map((head) => [annotationTargetKeyV1(target.bookId, head.annotationId), head]));
  const markerKey = annotationTargetKeyV1(target.bookId, ANNOTATION_BOOK_DELETE_MARKER_ID);
  if (marker) incoming.set(markerKey, marker);
  const before = new Map(baselineRemotes.filter((item) => item.targetKey.startsWith(prefix)).map((item) => [item.targetKey, item]));
  const stale = remotes.some((cached) => { const head = incoming.get(cached.targetKey); const previous = before.get(cached.targetKey);
    return head ? cached.revision > head.revision || (cached.revision === head.revision && cached.head.acceptedEventId !== head.acceptedEventId)
      : !previous || cached.revision !== previous.revision || cached.head.acceptedEventId !== previous.head.acceptedEventId; });
  const successors = allEvents.filter((event) => active.has(event.status));
  if ((options.isCurrent && !options.isCurrent()) || JSON.stringify(currentIntent) !== JSON.stringify(frozenIntent)
    || stale || (successors.length > 0 && (trustedNow === null || successors.some((event) => getEventLeaseStatus(event.eventId, trustedNow, true) !== 'valid')))
    || open.some((conflict) => !successors.some((event) => event.targetKey === conflict.targetKey))) {
    await tx.done; return { status: 'blocked' };
  }
  const updatedAt = Date.now();
  const metaByKey = new Map(metas.map((meta) => [meta.targetKey, meta]));
  const relevantKeys = new Set([...metas.map((meta) => meta.targetKey), ...incoming.keys(), ...allEvents.map((event) => event.targetKey), markerKey]);
  const preservedKeys = new Set(successors.map((event) => event.targetKey));
  for (const key of preservedKeys) {
    const group = allEvents.filter((event) => event.targetKey === key);
    const preserved = await preserveSuccessorConflict(tx, ownerKey, group, open.filter((conflict) => conflict.targetKey === key),
      incoming.get(key) ?? null, trustedNow, metaByKey.get(key), marker?.revision ?? 0);
    if (!preserved) { tx.abort(); await tx.done.catch(() => undefined); return { status: 'blocked' }; }
  }
  await Promise.all([
    ...stored.filter((item) => !preservedKeys.has(annotationTargetKeyV1(target.bookId, item.id))).map((item) => annotations.delete([ownerKey, target.bookId, item.id])),
    ...positions.filter((item) => !preservedKeys.has(annotationTargetKeyV1(target.bookId, item.id))).map((item) => annotations.put({ ...item, ownerKey })),
    ...[...incoming].map(([targetKey, head]) => remoteStore.put({ ownerKey, targetKey, revision: head.revision, head, updatedAt })),
    ...[...relevantKeys].filter((key) => !preservedKeys.has(key)).map((targetKey) => metaStore.put({ ownerKey, targetKey, knownRevision: incoming.get(targetKey)?.revision ?? before.get(targetKey)?.revision ?? 0,
      nextSequence: metaByKey.get(targetKey)?.nextSequence ?? 1, updatedAt })),
    ...allEvents.filter((event) => event.status === 'expired' && event.recoveryPending !== false).map((event) => store.put({ ...event, recoveryPending: false })),
    tx.objectStore(V10_ANNOTATION_BOOK_DELETIONS_STORE).put({ ...currentIntent, recoveryPending: false }),
  ]);
  await tx.done;
  notifyAnnotationSyncChange({ ownerKey, bookId: target.bookId });
  if (successors.length) notifyProgressSyncWork(ownerKey);
  return successors.length ? { status: 'conflict' } : { status: 'resynced' };
};

const recoverAnnotation = async (
  uid: string, ownerKey: OwnerKey, target: Extract<SyncTarget, { kind: 'annotation' }>, options: RecoveryOptions,
): Promise<{ status: 'resynced' } | { status: 'conflict' } | { status: 'blocked' }> => {
  const raw = await (options.fetchAnnotationBook ?? fetchAnnotationBook)(uid, target.bookId, target.annotationId);
  if (options.isCurrent && !options.isCurrent()) return { status: 'blocked' };
  const heads = raw.heads.map(parseAnnotationHeadV1);
  const marker = raw.marker === null ? null : parseAnnotationHeadV1(raw.marker);
  const suppliedTarget = raw.targetHead == null ? null : parseAnnotationHeadV1(raw.targetHead);
  if (heads.some((head) => head.bookId !== target.bookId || head.operation !== 'upsert')
    || new Set(heads.map((head) => head.annotationId)).size !== heads.length
    || (marker && (marker.bookId !== target.bookId || marker.annotationId !== ANNOTATION_BOOK_DELETE_MARKER_ID || marker.operation !== 'delete'))
    || (suppliedTarget && (suppliedTarget.bookId !== target.bookId || suppliedTarget.annotationId !== target.annotationId))) {
    throw new Error('Invalid annotation recovery book identity');
  }
  const aggregateHead = heads.find((head) => head.annotationId === target.annotationId) ?? null;
  if ((raw.targetHead === null && aggregateHead) || (suppliedTarget && ((suppliedTarget.operation === 'upsert') !== Boolean(aggregateHead)
    || (aggregateHead && (aggregateHead.revision !== suppliedTarget.revision || aggregateHead.acceptedEventId !== suppliedTarget.acceptedEventId))))) {
    throw new Error('Annotation target disagrees with book aggregate');
  }
  const head = suppliedTarget ?? aggregateHead;
  const generation = marker?.revision ?? 0;
  const position = aggregateHead && (aggregateHead.bookGeneration ?? 0) >= generation
    ? fromAnnotationSyncPayloadV1(aggregateHead.annotation!) : null;
  const key = annotationTargetKeyV1(target.bookId, target.annotationId);
  const markerKey = annotationTargetKeyV1(target.bookId, ANNOTATION_BOOK_DELETE_MARKER_ID);
  const db = await initDB();
  const tx = db.transaction([V8_ANNOTATIONS_STORE, V5_OUTBOX_STORE, V5_SYNC_CONFLICTS_STORE,
    V5_REMOTE_HEADS_STORE, V5_SYNC_META_STORE, V10_ANNOTATION_BOOK_DELETIONS_STORE], 'readwrite');
  const outbox = tx.objectStore(V5_OUTBOX_STORE);
  const conflicts = tx.objectStore(V5_SYNC_CONFLICTS_STORE).index('by-owner-target-state');
  const remotes = tx.objectStore(V5_REMOTE_HEADS_STORE);
  const metas = tx.objectStore(V5_SYNC_META_STORE);
  const annotations = tx.objectStore(V8_ANNOTATIONS_STORE);
  const [events, open, deferred, markerEvents, markerOpen, markerDeferred, remote, markerRemote, meta, stored, intent] = await Promise.all([
    outbox.index('by-owner-target-sequence').getAll(targetRange(ownerKey, key)) as Promise<RecoveryEvent[]>,
    conflicts.getAll([ownerKey, key, 'open']), conflicts.getAll([ownerKey, key, 'deferred']),
    outbox.index('by-owner-target-sequence').getAll(targetRange(ownerKey, markerKey)) as Promise<RecoveryEvent[]>,
    conflicts.getAll([ownerKey, markerKey, 'open']), conflicts.getAll([ownerKey, markerKey, 'deferred']),
    remotes.get([ownerKey, key]) as Promise<RemoteHeadCacheV5 | undefined>,
    remotes.get([ownerKey, markerKey]) as Promise<RemoteHeadCacheV5 | undefined>,
    metas.get([ownerKey, key]) as Promise<SyncMetaV5 | undefined>,
    annotations.index('by-owner-book').getAll([ownerKey, target.bookId]) as Promise<Annotation[]>,
    tx.objectStore(V10_ANNOTATION_BOOK_DELETIONS_STORE).get([ownerKey, target.bookId]) as Promise<AnnotationBookDeletionIntentV10 | undefined>,
  ]);
  const pending = events.filter((event) => event.status === 'expired' && event.recoveryPending !== false);
  const stale = (cached: RemoteHeadCacheV5 | undefined, incoming: AnnotationHeadV1 | null) => Boolean(cached && (
    !incoming || cached.revision > incoming.revision
    || (cached.revision === incoming.revision && cached.head.acceptedEventId !== incoming.acceptedEventId)
  ));
  if ((options.isCurrent && !options.isCurrent()) || (intent?.expired && intent.recoveryPending !== false) || !pending.length
    || markerEvents.some((event) => active.has(event.status) || (event.status === 'expired' && event.recoveryPending !== false))
    || markerOpen.length || markerDeferred.length || stale(remote, head) || stale(markerRemote, marker)) {
    await tx.done;
    return { status: 'blocked' };
  }
  if (events.some((event) => active.has(event.status))) {
    const preserved = await preserveSuccessorConflict(tx, ownerKey, events, [...open, ...deferred] as SyncConflictV5[], head,
      recoveryTime(ownerKey, options), meta, generation);
    if (preserved && marker) await remotes.put({ ownerKey, targetKey: markerKey, revision: marker.revision, head: marker, updatedAt: Date.now() });
    await tx.done;
    if (preserved) { notifyProgressSyncWork(ownerKey); notifyAnnotationSyncChange({ ownerKey, bookId: target.bookId }); }
    return preserved ? { status: 'conflict' } : { status: 'blocked' };
  }
  if (open.length || deferred.length) { await tx.done; return { status: 'blocked' }; }
  try {
    validateHydratedAnnotations([...stored.filter((item) => item.id !== target.annotationId), ...(position ? [position] : [])]);
  } catch {
    await tx.done;
    return { status: 'blocked' };
  }
  if (options.isCurrent && !options.isCurrent()) { await tx.done; return { status: 'blocked' }; }
  const now = Date.now();
  await Promise.all([
    position ? annotations.put({ ...position, ownerKey }) : annotations.delete([ownerKey, target.bookId, target.annotationId]),
    head ? remotes.put({ ownerKey, targetKey: key, revision: head.revision, head, updatedAt: now }) : remotes.delete([ownerKey, key]),
    marker ? remotes.put({ ownerKey, targetKey: markerKey, revision: marker.revision, head: marker, updatedAt: now }) : Promise.resolve(),
    metas.put({ ownerKey, targetKey: key, knownRevision: head?.revision ?? 0, nextSequence: meta?.nextSequence ?? 1, updatedAt: now }),
    ...pending.map((event) => outbox.put({ ...event, recoveryPending: false })),
  ]);
  await tx.done;
  notifyAnnotationSyncChange({ ownerKey, bookId: target.bookId });
  return { status: 'resynced' };
};
