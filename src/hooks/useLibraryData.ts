import {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
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
  readGuestReadingHandoff,
  retainReadingPositionsOnDeviceV5,
  restoreGuestReadingToAccountV5,
} from '../lib/localDBV5';
import { ownerRuntime } from '../lib/ownerRuntime';
import {
  DEVICE_CONTENT_OWNER_KEY,
  getSyncOwnerKey,
  type OwnerKey,
} from '../lib/ownerIdentity';
import { DriveLoadCoordinator } from '../lib/driveLoadCoordinator';
import { Book, RemoteProgressUpdate, UserProgress, ViewState } from '../types';
import { rebaseProgressCommitBaseline } from '../lib/progressCommitBaseline';
import { getSyncSessionId } from '../lib/syncSession';

interface UseLibraryDataOptions {
  clearToken: () => void;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<ViewState>>;
  onLibraryError?: (message: string) => void;
  driveSessionId: string | null;
  getCurrentDriveSessionId: () => string | null;
  deviceId?: MutableRefObject<string>;
}

export type RestoreLocalDataOptions = {
  preventRedirect?: boolean;
  replaceBooks?: boolean;
  guestHandoff?: { owner: OwnerKey; confirmed: boolean; refreshFrom?: OwnerKey };
};

export type RestoreLocalDataResult = 'restored' | 'empty' | 'failed' | 'stale';

interface UseLibraryDataResult {
  books: Book[];
  setBooks: Dispatch<SetStateAction<Book[]>>;
  progress: Record<string, UserProgress>;
  setProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  remoteProgress: Record<string, RemoteProgressUpdate>;
  setRemoteProgress: Dispatch<SetStateAction<Record<string, RemoteProgressUpdate>>>;
  driveCacheKey: string | null;
  restoreLocalData: (options?: boolean | RestoreLocalDataOptions) => Promise<RestoreLocalDataResult>;
  loadLibraryFromDrive: (token: string, driveSessionId?: string) => Promise<boolean>;
  resetLibraryState: () => void;
}

export const useLibraryData = ({
  clearToken,
  setIsOfflineMode,
  setView,
  onLibraryError,
  driveSessionId,
  getCurrentDriveSessionId,
  deviceId,
}: UseLibraryDataOptions): UseLibraryDataResult => {
  const [books, setBooks] = useState<Book[]>([]);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  const [remoteProgress, setRemoteProgress] = useState<Record<string, RemoteProgressUpdate>>({});
  const [driveCacheKey, setDriveCacheKey] = useState<string | null>(null);
  const progressRef = useRef<Record<string, UserProgress>>({});
  const driveLoadCoordinatorRef = useRef(new DriveLoadCoordinator());

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useLayoutEffect(() => {
    const coordinator = driveLoadCoordinatorRef.current;
    coordinator.cancel();
    return () => coordinator.cancel();
  }, [driveSessionId]);

  const resetLibraryState = useCallback(() => {
    driveLoadCoordinatorRef.current.cancel();
    progressRef.current = {};
    setDriveCacheKey(null);
    setBooks([]);
    setProgress({});
    setRemoteProgress({});
  }, []);

  const restoreLocalData = useCallback(async (options?: boolean | RestoreLocalDataOptions): Promise<RestoreLocalDataResult> => {
    const { preventRedirect = false, replaceBooks = false, guestHandoff } =
      typeof options === 'boolean' ? { preventRedirect: options } : options ?? {};
    const capturedOwner = ownerRuntime.capture();
    if (!capturedOwner) return 'stale';

    try {
      const owner = capturedOwner;
      if (!preventRedirect) setIsOfflineMode(true);
      const progressOwner = getSyncOwnerKey(owner.ownerKey);
      if (guestHandoff) {
        if (progressOwner === guestHandoff.owner) {
          const handoff = await readGuestReadingHandoff(progressOwner);
          const refreshConfirmed = guestHandoff.refreshFrom !== undefined && handoff?.account === guestHandoff.refreshFrom;
          if (handoff && (refreshConfirmed || (!handoff.confirmed && guestHandoff.refreshFrom === undefined))) {
            if (!guestHandoff.confirmed || !ownerRuntime.isCurrent(owner)) return 'stale';
            await retainReadingPositionsOnDeviceV5(handoff.account, progressOwner, handoff, refreshConfirmed);
          }
        } else if (deviceId?.current) {
          await restoreGuestReadingToAccountV5(progressOwner, guestHandoff.owner, deviceId.current,
            getSyncSessionId(), () => ownerRuntime.isCurrent(owner));
        }
      }

      const [localBooks, localProgress] = await Promise.all([
        getAllOfflineBooksV5(DEVICE_CONTENT_OWNER_KEY),
        getAllLocalProgressV5(progressOwner),
      ]);
      if (!ownerRuntime.isCurrent(owner)) return 'stale';

      const localProgressByBook: Record<string, UserProgress> = {};
      localProgress.forEach((item) => {
        localProgressByBook[item.bookId] = item;
        rebaseProgressCommitBaseline(owner.ownerKey, item.bookId, item);
      });

      setProgress((prev) => {
        if (!ownerRuntime.isCurrent(owner)) return prev;
        const merged = { ...prev, ...localProgressByBook };
        progressRef.current = merged;
        return merged;
      });

      if (replaceBooks) {
        setBooks((prev) => ownerRuntime.isCurrent(owner) ? localBooks : prev);
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
        return 'restored';
      }

      return 'empty';
    } catch (error) {
      console.error('Failed to restore local data:', error);
      return ownerRuntime.isCurrent(capturedOwner) ? 'failed' : 'stale';
    }
  }, [deviceId, setIsOfflineMode, setView]);

  const loadLibraryFromDrive = useCallback(async (
    token: string,
    requestedDriveSessionId?: string,
  ) => {
    const previousOwner = ownerRuntime.capture();
    if (!previousOwner) return false;
    const sessionId = requestedDriveSessionId ?? driveSessionId;
    if (!sessionId || getCurrentDriveSessionId() !== sessionId) return false;
    const requestKey = JSON.stringify([previousOwner.generation, sessionId]);
    const coordinator = driveLoadCoordinatorRef.current;
    return coordinator.run(requestKey, async (request) => {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
      const dispose = ownerRuntime.registerDisposer(() => {
        if (coordinator.isCurrent(request)) coordinator.cancel();
      });
      const isCurrent = () => (
        coordinator.isCurrent(request)
        && ownerRuntime.isCurrent(previousOwner)
        && getCurrentDriveSessionId() === sessionId
      );
      let attemptedCacheKey: string | null = null;
      try {
        const permissionId = await getDriveUserPermissionId(token, signal);
        if (!isCurrent()) return false;
        const driveNamespace = `drive:${encodeURIComponent(permissionId)}`;
        const cacheKey = `${driveNamespace}::${sessionId}`;
        attemptedCacheKey = cacheKey;
        const folderId = await getDriveLibraryFolderId(token, {
          cacheKey,
          signal,
        });
        if (!isCurrent()) return false;
        invalidateDriveCachesForOwner(driveNamespace, cacheKey);

        const data = folderId
          ? await fetchDriveFiles(token, folderId, signal)
          : { files: [] };
        if (!isCurrent()) return false;
        const cloudBooks = (data.files as Book[])
          .map((book) => ({ ...book, source: 'cloud' as const }));
        const cloudIds = new Set(cloudBooks.map((book) => book.id));
        const localBooks = await getAllOfflineBooksV5(DEVICE_CONTENT_OWNER_KEY);
        signal.throwIfAborted();
        if (!isCurrent()) return false;
        const localOnly = localBooks
          .filter((book) => !cloudIds.has(book.id))
          .map((book) => ({ ...book, source: 'local' as const }));
        setDriveCacheKey((current) => isCurrent() ? cacheKey : current);
        setBooks((current) => isCurrent() ? [...cloudBooks, ...localOnly] : current);

        setIsOfflineMode(false);
        return true;
      } catch (error) {
        if (!isCurrent()) return false;
        if (isGoogleDriveAuthError(error)) {
          if (attemptedCacheKey) invalidateDriveCache(attemptedCacheKey);
          setDriveCacheKey(null);
          clearToken();
        }
        if (error instanceof GoogleDriveFolderConflictError) {
          onLibraryError?.(error.message);
        }
        console.warn('Drive Library Load Failed (Offline or Error)');
        setIsOfflineMode(true);
        return false;
      } finally {
        dispose();
      }
    });
  }, [clearToken, driveSessionId, getCurrentDriveSessionId, onLibraryError, setIsOfflineMode]);

  return {
    books,
    setBooks,
    progress,
    setProgress,
    progressRef,
    remoteProgress,
    setRemoteProgress,
    driveCacheKey: driveSessionId && driveCacheKey?.endsWith(`::${driveSessionId}`) ? driveCacheKey : null,
    restoreLocalData,
    loadLibraryFromDrive,
    resetLibraryState,
  };
};
