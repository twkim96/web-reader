import type { Bookmark, UserProgress } from '../types';
import { initDB } from './localDB';
import {
  V5_OUTBOX_STORE,
  V5_PROGRESS_STORE,
  V5_REMOTE_HEADS_STORE,
  V5_SYNC_CONFLICTS_STORE,
  V5_SYNC_META_STORE,
} from './localDBSchema';
import type { OwnerKey } from './ownerIdentity';
import {
  bookmarkTargetKeyV2,
  type BookmarkHeadV2,
  type ManualBookmarkPayloadV2,
} from './progressV2Schema';
import type {
  RemoteHeadCacheV5,
  SyncConflictV5,
  SyncMetaV5,
  SyncOutboxEventV5,
} from './syncOutboxV5';

const activeStatuses = new Set([
  'pending',
  'in_flight',
  'blocked',
  'conflict',
  'paused',
]);

const fromRemotePayload = (payload: ManualBookmarkPayloadV2): Bookmark => ({
  id: payload.bookmarkId,
  type: 'manual',
  name: payload.name,
  cfi: payload.cfi,
  progressPercent: payload.progressPercent ?? undefined,
  createdAt: payload.createdAtClient,
  color: payload.color,
});

const sameBookmark = (left: Bookmark | undefined, right: Bookmark) => Boolean(
  left
  && left.type === 'manual'
  && left.cfi === right.cfi
  && left.name === right.name
  && left.color === right.color
  && (left.progressPercent ?? null) === (right.progressPercent ?? null)
  && left.createdAt === right.createdAt
);

const withoutOwnerKey = (
  progress: (UserProgress & { ownerKey?: OwnerKey }) | undefined,
): UserProgress | undefined => {
  if (!progress) return undefined;
  const value = { ...progress };
  delete value.ownerKey;
  return value;
};

export const hydrateRemoteBookmarkHeadsV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
  heads: ReadonlyArray<BookmarkHeadV2>,
  currentSessionId: string,
  now = Date.now(),
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
) => {
  if (heads.some((head) => head.bookId !== bookId)) {
    throw new Error('원격 bookmark book 경계가 올바르지 않습니다.');
  }
  if (!isCurrent()) {
    return { changed: false, progress: null, applied: 0, skipped: 0, stale: true };
  }

  const db = await initDB();
  const tx = db.transaction([
    V5_PROGRESS_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_CONFLICTS_STORE,
    V5_REMOTE_HEADS_STORE,
    V5_SYNC_META_STORE,
  ], 'readwrite');
  void tx.done.catch(() => undefined);
  const abortTransaction = () => {
    try {
      tx.abort();
    } catch {
      // Transaction may already be committed or aborted.
    }
  };
  signal?.addEventListener('abort', abortTransaction, { once: true });

  try {
    const progressStore = tx.objectStore(V5_PROGRESS_STORE);
    const outboxStore = tx.objectStore(V5_OUTBOX_STORE);
    const conflictStore = tx.objectStore(V5_SYNC_CONFLICTS_STORE);
    const remoteStore = tx.objectStore(V5_REMOTE_HEADS_STORE);
    const metaStore = tx.objectStore(V5_SYNC_META_STORE);
    const storedProgress = await progressStore.get([ownerKey, bookId]) as
      (UserProgress & { ownerKey?: OwnerKey }) | undefined;
    const localProgress = withoutOwnerKey(storedProgress);
    const manualById = new Map(
      (localProgress?.bookmarks ?? [])
        .filter((bookmark) => bookmark.type === 'manual')
        .map((bookmark) => [bookmark.id, bookmark]),
    );
    const localAuto = (localProgress?.bookmarks ?? [])
      .filter((bookmark) => bookmark.type === 'auto');
    let applied = 0;
    let skipped = 0;

    for (const head of heads) {
      const targetKey = bookmarkTargetKeyV2(bookId, head.bookmarkId);
      const [targetEvents, openConflicts, deferredConflicts, meta, existingRemote] = await Promise.all([
        outboxStore.index('by-owner-target-sequence').getAll(IDBKeyRange.bound(
          [ownerKey, targetKey, 0],
          [ownerKey, targetKey, Number.MAX_SAFE_INTEGER],
        )) as Promise<SyncOutboxEventV5[]>,
        conflictStore.index('by-owner-target-state').getAll([
          ownerKey,
          targetKey,
          'open',
        ]) as Promise<SyncConflictV5[]>,
        conflictStore.index('by-owner-target-state').getAll([
          ownerKey,
          targetKey,
          'deferred',
        ]) as Promise<SyncConflictV5[]>,
        metaStore.get([ownerKey, targetKey]) as Promise<SyncMetaV5 | undefined>,
        remoteStore.get([ownerKey, targetKey]) as Promise<RemoteHeadCacheV5 | undefined>,
      ]);

      if (existingRemote && head.revision < existingRemote.revision) {
        skipped += 1;
        continue;
      }
      if (
        existingRemote
        && head.revision === existingRemote.revision
        && head.acceptedEventId !== existingRemote.head.acceptedEventId
      ) {
        throw Object.assign(
          new Error('같은 bookmark revision에 서로 다른 acceptedEventId가 있습니다.'),
          { code: 'invalid-argument' },
        );
      }
      if (!existingRemote || head.revision > existingRemote.revision) {
        await remoteStore.put({
          ownerKey,
          targetKey,
          revision: head.revision,
          head,
          updatedAt: now,
        } satisfies RemoteHeadCacheV5);
      }

      const hasLocalWork = targetEvents.some((event) => activeStatuses.has(event.status))
        || openConflicts.length > 0
        || deferredConflicts.length > 0;
      if (!hasLocalWork) {
        await metaStore.put({
          ownerKey,
          targetKey,
          knownRevision: Math.max(
            meta?.knownRevision ?? 0,
            existingRemote?.revision ?? 0,
            head.revision,
          ),
          nextSequence: meta?.nextSequence ?? 1,
          updatedAt: now,
        } satisfies SyncMetaV5);
      }
      if (hasLocalWork) {
        skipped += 1;
        continue;
      }

      const existing = manualById.get(head.bookmarkId);
      if (head.operation === 'delete') {
        if (existing) {
          manualById.delete(head.bookmarkId);
          applied += 1;
        }
        continue;
      }

      const nextBookmark = fromRemotePayload(head.bookmark!);
      if (
        head.acceptedSessionId === currentSessionId
        && sameBookmark(existing, nextBookmark)
      ) continue;
      if (sameBookmark(existing, nextBookmark)) continue;
      manualById.set(head.bookmarkId, nextBookmark);
      applied += 1;
    }

    if (!isCurrent() || signal?.aborted) {
      abortTransaction();
      await tx.done.catch(() => undefined);
      return { changed: false, progress: null, applied: 0, skipped: 0, stale: true };
    }

    const changed = applied > 0;
    let nextProgress = localProgress;
    if (changed) {
      const manual = [...manualById.values()]
        .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
      nextProgress = {
        bookId,
        cfi: localProgress?.cfi ?? '',
        anchorCfi: localProgress?.anchorCfi ?? '',
        progressPercent: localProgress?.progressPercent ?? 0,
        lastRead: localProgress?.lastRead ?? 0,
        bookmarks: [...manual, ...localAuto],
        syncRevision: localProgress?.syncRevision,
        acceptedEventId: localProgress?.acceptedEventId,
        ignoredRemoteRevision: localProgress?.ignoredRemoteRevision,
      };
      await progressStore.put({ ...nextProgress, ownerKey });
    }

    await tx.done;
    return {
      changed,
      progress: nextProgress ?? null,
      applied,
      skipped,
      stale: false,
    };
  } catch (error) {
    abortTransaction();
    await tx.done.catch(() => undefined);
    if (signal?.aborted || !isCurrent()) {
      return { changed: false, progress: null, applied: 0, skipped: 0, stale: true };
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortTransaction);
  }
};
