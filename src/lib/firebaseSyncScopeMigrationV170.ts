import { diffManualBookmarks } from './bookmarkSyncPolicy';
import {
  getAllLocalProgressV5,
  getMigrationMetaV5,
  putMigrationMetaV5,
} from './localDBV5';
import { getSyncOwnerKey, splitOwnerKey, type OwnerKey } from './ownerIdentity';
import {
  enqueueBookmarkEventV5,
  enqueueProgressEventV5,
  getOutboxEventsV5,
} from './syncOutboxV5';

const MIGRATION_PREFIX = 'v1.7.0-firebase-sync-scope';
export const FIREBASE_SYNC_SCOPE_MIGRATED_EVENT_V170 = 'web-reader:firebase-sync-scope-migrated-v170';

const digest = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

export const firebaseSyncScopeMigrationIdV170 = async (sourceOwnerKey: OwnerKey) => (
  `${MIGRATION_PREFIX}:${(await digest(sourceOwnerKey)).slice(0, 32)}`
);

export const migrateDriveProgressToFirebaseScopeV170 = async ({
  sourceOwnerKey,
  deviceId,
}: {
  sourceOwnerKey: OwnerKey;
  deviceId: string;
}) => {
  const { libraryScopeKey } = splitOwnerKey(sourceOwnerKey);
  const targetOwnerKey = getSyncOwnerKey(sourceOwnerKey);
  if (libraryScopeKey === 'library:local' || sourceOwnerKey === targetOwnerKey) {
    return { migrated: 0, skipped: true } as const;
  }

  const migrationId = await firebaseSyncScopeMigrationIdV170(sourceOwnerKey);
  const previous = await getMigrationMetaV5(migrationId);
  if (previous?.status === 'completed') {
    return { migrated: previous.copiedCounts.progress ?? 0, skipped: true } as const;
  }

  const startedAt = Date.now();
  const [sourceProgress, targetProgress] = await Promise.all([
    getAllLocalProgressV5(sourceOwnerKey),
    getAllLocalProgressV5(targetOwnerKey),
  ]);
  const resuming = previous?.status === 'copying';
  const targetByBook = new Map(targetProgress.map((progress) => [progress.bookId, progress]));
  const candidates = sourceProgress.filter((source) => (
    !targetByBook.has(source.bookId)
    || source.lastRead > (targetByBook.get(source.bookId)?.lastRead ?? 0)
    || (resuming && source.lastRead === targetByBook.get(source.bookId)?.lastRead)
  ));
  const pendingEventIds = new Set(
    (await getOutboxEventsV5(targetOwnerKey)).map((event) => event.eventId),
  );

  await putMigrationMetaV5({
    migrationId,
    ownerKey: targetOwnerKey,
    status: 'copying',
    sourceCounts: { progress: sourceProgress.length },
    copiedCounts: { progress: 0 },
    sourceContentBytes: 0,
    copiedContentBytes: 0,
    startedAt,
  });

  const sessionId = migrationId;
  for (const progress of candidates) {
    const eventBase = `${migrationId}:${progress.bookId}`;
    const eventDigest = (await digest(eventBase)).slice(0, 48);
    const progressEventId = `v170-progress-${eventDigest}`;
    if (!pendingEventIds.has(progressEventId)) {
      await enqueueProgressEventV5(targetOwnerKey, {
        bookId: progress.bookId,
        operation: progress.cfi ? 'progress.set' : 'progress.reset',
        position: progress.cfi
          ? {
            cfi: progress.cfi,
            anchorCfi: progress.anchorCfi ?? null,
            progressPercent: progress.progressPercent,
          }
          : null,
        localBookmarks: progress.bookmarks ?? [],
        deviceId,
        sessionId,
        eventId: progressEventId,
        occurredAtClient: progress.lastRead,
      });
      pendingEventIds.add(progressEventId);
    }

    const previousBookmarks = targetByBook.get(progress.bookId)?.bookmarks ?? [];
    const bookmarkChanges = diffManualBookmarks(
      previousBookmarks,
      progress.bookmarks,
      progress.lastRead,
    );
    for (const change of bookmarkChanges) {
      const bookmarkDigest = (await digest(`${eventBase}:${change.bookmarkId}`)).slice(0, 48);
      const bookmarkEventId = `v170-bookmark-${bookmarkDigest}`;
      if (pendingEventIds.has(bookmarkEventId)) continue;
      await enqueueBookmarkEventV5(targetOwnerKey, {
        bookId: progress.bookId,
        bookmarkId: change.bookmarkId,
        operation: change.operation,
        payload: change.payload,
        localBookmarks: progress.bookmarks ?? [],
        deviceId,
        sessionId,
        eventId: bookmarkEventId,
        occurredAtClient: progress.lastRead,
      });
      pendingEventIds.add(bookmarkEventId);
    }
  }

  await putMigrationMetaV5({
    migrationId,
    ownerKey: targetOwnerKey,
    status: 'completed',
    sourceCounts: { progress: sourceProgress.length },
    copiedCounts: { progress: candidates.length },
    sourceContentBytes: 0,
    copiedContentBytes: 0,
    startedAt,
    completedAt: Date.now(),
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(FIREBASE_SYNC_SCOPE_MIGRATED_EVENT_V170, {
      detail: { targetOwnerKey, progress: candidates },
    }));
  }
  return { migrated: candidates.length, skipped: false } as const;
};
