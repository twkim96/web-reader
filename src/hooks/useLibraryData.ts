import { Dispatch, MutableRefObject, SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchDriveFiles,
  getDriveLibraryFolderId,
  getDriveUserPermissionId,
  GoogleDriveFolderConflictError,
  invalidateDriveCache,
  invalidateDriveCachesForOwner,
  isGoogleDriveAuthError,
} from '../lib/googleDrive';
import {
  getAllLocalProgressV5,
  getAllOfflineBooksV5,
  getOwnerBindingsV5,
  putOwnerBindingV5,
  putOwnerSessionV5,
} from '../lib/localDBV5';
import { getAllLocalProgress, getAllOfflineBooks } from '../lib/localDB';
import {
  inspectLegacyInventory,
  migrateLegacyDataToOwnerV5,
  migrationIdFor,
  recordLegacyMigrationDecision,
  type LegacyInventory,
} from '../lib/localDBMigration';
import { getMigrationMetaV5 } from '../lib/localDBV5';
import { ownerRuntime, type OwnerSnapshot } from '../lib/ownerRuntime';
import {
  makeDriveScopeKey,
  makeOwnerKey,
  getSyncOwnerKey,
  splitOwnerKey,
} from '../lib/ownerIdentity';
import { Book, UserProgress, ViewState } from '../types';
import { FIREBASE_SYNC_SCOPE_MIGRATED_EVENT_V170 } from '../lib/firebaseSyncScopeMigrationV170';

interface UseLibraryDataOptions {
  clearToken: () => void;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<ViewState>>;
  onLibraryError?: (message: string) => void;
  requestLegacyMigration: (
    owner: OwnerSnapshot,
    inventory: LegacyInventory,
    previousError?: string,
  ) => Promise<'migrate' | 'legacy-readonly' | 'empty'>;
  driveSessionId: string | null;
}

export type RestoreLocalDataOptions = {
  preventRedirect?: boolean;
  replaceBooks?: boolean;
};

interface UseLibraryDataResult {
  books: Book[];
  setBooks: Dispatch<SetStateAction<Book[]>>;
  progress: Record<string, UserProgress>;
  setProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  remoteProgress: Record<string, UserProgress>;
  setRemoteProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
  restoreLocalData: (options?: boolean | RestoreLocalDataOptions) => Promise<boolean>;
  loadLibraryFromDrive: (token: string, driveSessionId?: string) => Promise<boolean>;
  resetLibraryState: () => void;
}

const normalizeRestoreOptions = (options?: boolean | RestoreLocalDataOptions): Required<RestoreLocalDataOptions> => {
  if (typeof options === 'boolean') {
    return { preventRedirect: options, replaceBooks: false };
  }

  return {
    preventRedirect: options?.preventRedirect ?? false,
    replaceBooks: options?.replaceBooks ?? false,
  };
};

export const useLibraryData = ({
  clearToken,
  setIsOfflineMode,
  setView,
  onLibraryError,
  requestLegacyMigration,
  driveSessionId,
}: UseLibraryDataOptions): UseLibraryDataResult => {
  const [books, setBooks] = useState<Book[]>([]);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  const [remoteProgress, setRemoteProgress] = useState<Record<string, UserProgress>>({});
  const progressRef = useRef<Record<string, UserProgress>>({});

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    const handleMigration = (event: Event) => {
      const detail = (event as CustomEvent<{
        targetOwnerKey?: string;
        progress?: UserProgress[];
      }>).detail;
      const owner = ownerRuntime.capture();
      if (!owner || detail?.targetOwnerKey !== getSyncOwnerKey(owner.ownerKey)) return;
      const migrated = detail.progress ?? [];
      if (migrated.length === 0) return;
      setProgress((previous) => {
        const next = { ...previous };
        for (const item of migrated) {
          if (!next[item.bookId] || item.lastRead > next[item.bookId].lastRead) {
            next[item.bookId] = item;
          }
        }
        progressRef.current = next;
        return next;
      });
    };
    window.addEventListener(FIREBASE_SYNC_SCOPE_MIGRATED_EVENT_V170, handleMigration);
    return () => window.removeEventListener(FIREBASE_SYNC_SCOPE_MIGRATED_EVENT_V170, handleMigration);
  }, []);

  const resetLibraryState = useCallback(() => {
    progressRef.current = {};
    setBooks([]);
    setProgress({});
    setRemoteProgress({});
  }, []);

  const prepareOwnerStorage = useCallback(async (owner: OwnerSnapshot) => {
    if (owner.storageMode === 'legacy-readonly') return owner;
    const inventory = await inspectLegacyInventory();
    if (!ownerRuntime.isCurrent(owner)) return null;
    const totalLegacyRecords = Object.values(inventory.counts)
      .reduce((total, count) => total + count, 0);
    if (totalLegacyRecords === 0) return owner;

    const migration = await getMigrationMetaV5(migrationIdFor(owner.ownerKey));
    if (!ownerRuntime.isCurrent(owner)) return null;
    if (migration?.status === 'completed' || migration?.status === 'declined_empty') {
      return owner;
    }
    if (migration?.status === 'legacy_read_only') {
      return ownerRuntime.useLegacyReadOnly(owner);
    }

    const choice = await requestLegacyMigration(
      owner,
      inventory,
      migration?.status === 'failed' ? migration.errorMessage : undefined,
    );
    if (!ownerRuntime.isCurrent(owner)) return null;

    if (choice === 'migrate') {
      await migrateLegacyDataToOwnerV5(owner.ownerKey, {
        leaseHolder: crypto.randomUUID(),
      });
      return ownerRuntime.isCurrent(owner) ? owner : null;
    }

    await recordLegacyMigrationDecision(
      owner.ownerKey,
      choice === 'legacy-readonly' ? 'legacy_read_only' : 'declined_empty',
    );
    if (!ownerRuntime.isCurrent(owner)) return null;
    return choice === 'legacy-readonly'
      ? ownerRuntime.useLegacyReadOnly(owner)
      : owner;
  }, [requestLegacyMigration]);

  const restoreLocalData = useCallback(async (options?: boolean | RestoreLocalDataOptions) => {
    const { preventRedirect, replaceBooks } = normalizeRestoreOptions(options);
    const capturedOwner = ownerRuntime.capture();
    if (!capturedOwner) return false;

    try {
      const owner = await prepareOwnerStorage(capturedOwner);
      if (!owner) return false;
      if (!preventRedirect) setIsOfflineMode(true);

      const [localBooks, localProgress] = await Promise.all([
        owner.storageMode === 'legacy-readonly'
          ? getAllOfflineBooks()
          : getAllOfflineBooksV5(owner.ownerKey),
        owner.storageMode === 'legacy-readonly'
          ? getAllLocalProgress()
          : getAllLocalProgressV5(getSyncOwnerKey(owner.ownerKey)),
      ]);
      if (!ownerRuntime.isCurrent(owner)) return false;

      const localProgressByBook: Record<string, UserProgress> = {};
      localProgress.forEach((item) => {
        localProgressByBook[item.bookId] = item;
      });

      setProgress((prev) => {
        if (!ownerRuntime.isCurrent(owner)) return prev;
        const merged = { ...prev, ...localProgressByBook };
        progressRef.current = merged;
        return merged;
      });

      if (replaceBooks) {
        setBooks(localBooks);
      } else if (localBooks.length > 0) {
        setBooks((prev) => {
          if (!ownerRuntime.isCurrent(owner)) return prev;
          const existingIds = new Set(prev.map((book) => book.id));
          const newBooks = localBooks.filter((book) => !existingIds.has(book.id));
          return prev.length === 0 ? localBooks : newBooks.length > 0 ? [...prev, ...newBooks] : prev;
        });
      }

      if (localBooks.length > 0) {
        if (!preventRedirect) setView('shelf');
        return true;
      }

      return false;
    } catch (error) {
      console.error('Failed to restore local data:', error);
      return false;
    }
  }, [prepareOwnerStorage, setIsOfflineMode, setView]);

  const loadLibraryFromDrive = useCallback(async (
    token: string,
    requestedDriveSessionId?: string,
  ) => {
    const previousOwner = ownerRuntime.capture();
    if (!previousOwner) return false;
    const sessionId = requestedDriveSessionId ?? driveSessionId;
    if (!sessionId) return false;
    try {
      const permissionId = await getDriveUserPermissionId(token);
      if (!ownerRuntime.isCurrent(previousOwner)) return false;
      const { authOwnerKey } = splitOwnerKey(previousOwner.ownerKey);
      const libraryScopeKey = makeDriveScopeKey(permissionId);
      const ownerKey = makeOwnerKey(authOwnerKey, libraryScopeKey);
      const cacheKey = `${ownerKey}::${sessionId}`;
      const previousBinding = (await getOwnerBindingsV5(authOwnerKey))
        .find((binding) => binding.libraryScopeKey === libraryScopeKey);
      if (!ownerRuntime.isCurrent(previousOwner)) return false;
      const folderId = await getDriveLibraryFolderId(token, { cacheKey });
      if (!ownerRuntime.isCurrent(previousOwner)) return false;

      if (previousBinding?.folderId && previousBinding.folderId !== folderId) {
        invalidateDriveCachesForOwner(ownerKey, cacheKey);
      }

      await Promise.all([
        putOwnerBindingV5({
          authOwnerKey,
          libraryScopeKey,
          permissionId,
          folderId: folderId ?? undefined,
          verifiedAt: Date.now(),
        }),
        putOwnerSessionV5({ authOwnerKey, ownerKey, updatedAt: Date.now() }),
      ]);
      if (!ownerRuntime.isCurrent(previousOwner)) return false;
      const owner = ownerRuntime.activate(ownerKey);
      if (previousOwner.ownerKey !== owner.ownerKey) resetLibraryState();

      const data = folderId
        ? await fetchDriveFiles(token, folderId)
        : { files: [] };
      if (!ownerRuntime.isCurrent(owner)) return false;
      const cloudBooks = (data.files as Book[]).map((book) => ({ ...book, source: 'cloud' as const }));
      const cloudIds = new Set(cloudBooks.map((book) => book.id));
      const localBooks = owner.storageMode === 'legacy-readonly'
        ? await getAllOfflineBooks()
        : await getAllOfflineBooksV5(owner.ownerKey);
      if (!ownerRuntime.isCurrent(owner)) return false;
      const localOnly = localBooks
        .filter((book) => !cloudIds.has(book.id))
        .map((book) => ({ ...book, source: 'local' as const }));
      setBooks([...cloudBooks, ...localOnly]);

      setIsOfflineMode(false);
      return true;
    } catch (error) {
      if (isGoogleDriveAuthError(error)) {
        const activeOwner = ownerRuntime.capture();
        if (activeOwner && sessionId) {
          invalidateDriveCache(`${activeOwner.ownerKey}::${sessionId}`);
        }
        clearToken();
      }
      if (error instanceof GoogleDriveFolderConflictError) {
        onLibraryError?.(error.message);
      }
      console.warn('Drive Library Load Failed (Offline or Error)');
      setIsOfflineMode(true);
      return false;
    }
  }, [clearToken, driveSessionId, onLibraryError, resetLibraryState, setIsOfflineMode]);

  return {
    books,
    setBooks,
    progress,
    setProgress,
    progressRef,
    remoteProgress,
    setRemoteProgress,
    restoreLocalData,
    loadLibraryFromDrive,
    resetLibraryState,
  };
};
