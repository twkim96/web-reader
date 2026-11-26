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
  retainReadingPositionsOnDeviceV5,
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

interface UseLibraryDataOptions {
  clearToken: () => void;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<ViewState>>;
  onLibraryError?: (message: string) => void;
  driveSessionId: string | null;
}

export type RestoreLocalDataOptions = {
  preventRedirect?: boolean;
  replaceBooks?: boolean;
  retainPositionsFrom?: OwnerKey;
};

interface UseLibraryDataResult {
  books: Book[];
  setBooks: Dispatch<SetStateAction<Book[]>>;
  progress: Record<string, UserProgress>;
  setProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  remoteProgress: Record<string, RemoteProgressUpdate>;
  setRemoteProgress: Dispatch<SetStateAction<Record<string, RemoteProgressUpdate>>>;
  driveCacheKey: string | null;
  restoreLocalData: (options?: boolean | RestoreLocalDataOptions) => Promise<boolean>;
  loadLibraryFromDrive: (token: string, driveSessionId?: string) => Promise<boolean>;
  resetLibraryState: () => void;
}

export const useLibraryData = ({
  clearToken,
  setIsOfflineMode,
  setView,
  onLibraryError,
  driveSessionId,
}: UseLibraryDataOptions): UseLibraryDataResult => {
  const [books, setBooks] = useState<Book[]>([]);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  const [remoteProgress, setRemoteProgress] = useState<Record<string, RemoteProgressUpdate>>({});
  const [driveCacheKey, setDriveCacheKey] = useState<string | null>(null);
  const progressRef = useRef<Record<string, UserProgress>>({});
  const driveLoadCoordinatorRef = useRef(new DriveLoadCoordinator());
  const driveSessionIdRef = useRef(driveSessionId);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useLayoutEffect(() => {
    const coordinator = driveLoadCoordinatorRef.current;
    driveSessionIdRef.current = driveSessionId;
    coordinator.cancel();
    return () => coordinator.cancel();
  }, [driveSessionId]);

  const resetLibraryState = useCallback(() => {
    driveLoadCoordinatorRef.current.cancel();
    progressRef.current = {};
    setBooks([]);
    setProgress({});
    setRemoteProgress({});
  }, []);

  const restoreLocalData = useCallback(async (options?: boolean | RestoreLocalDataOptions) => {
    const { preventRedirect = false, replaceBooks = false, retainPositionsFrom } =
      typeof options === 'boolean' ? { preventRedirect: options } : options ?? {};
    const capturedOwner = ownerRuntime.capture();
    if (!capturedOwner) return false;

    try {
      const owner = capturedOwner;
      if (!preventRedirect) setIsOfflineMode(true);
      const progressOwner = getSyncOwnerKey(owner.ownerKey);
      if (retainPositionsFrom) {
        // A failed local write should not leave the signed-out shelf loading.
        await retainReadingPositionsOnDeviceV5(getSyncOwnerKey(retainPositionsFrom), progressOwner)
          .catch(() => {
            if (ownerRuntime.isCurrent(owner)) {
              onLibraryError?.('기기에 읽기 위치를 남기지 못했습니다. 같은 계정으로 다시 로그인하면 저장된 위치를 볼 수 있습니다.');
            }
          });
      }

      const [localBooks, localProgress] = await Promise.all([
        getAllOfflineBooksV5(DEVICE_CONTENT_OWNER_KEY),
        getAllLocalProgressV5(progressOwner),
      ]);
      if (!ownerRuntime.isCurrent(owner)) return false;

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
  }, [onLibraryError, setIsOfflineMode, setView]);

  const loadLibraryFromDrive = useCallback(async (
    token: string,
    requestedDriveSessionId?: string,
  ) => {
    const previousOwner = ownerRuntime.capture();
    if (!previousOwner) return false;
    const sessionId = requestedDriveSessionId ?? driveSessionId;
    if (!sessionId) return false;
    const requestKey = sessionId;
    return driveLoadCoordinatorRef.current.run(requestKey, async (request) => {
      const isCurrent = () => (
        driveLoadCoordinatorRef.current.isCurrent(request)
        && ownerRuntime.isCurrent(previousOwner)
        && driveSessionIdRef.current === sessionId
      );
      let attemptedCacheKey: string | null = null;
      try {
        const permissionId = await getDriveUserPermissionId(token, request.signal);
        if (!isCurrent()) return false;
        const driveNamespace = `drive:${encodeURIComponent(permissionId)}`;
        const cacheKey = `${driveNamespace}::${sessionId}`;
        attemptedCacheKey = cacheKey;
        const folderId = await getDriveLibraryFolderId(token, {
          cacheKey,
          signal: request.signal,
        });
        if (!isCurrent()) return false;
        invalidateDriveCachesForOwner(driveNamespace, cacheKey);
        setDriveCacheKey(cacheKey);

        const data = folderId
          ? await fetchDriveFiles(token, folderId, request.signal)
          : { files: [] };
        if (!isCurrent()) return false;
        const cloudBooks = (data.files as Book[])
          .map((book) => ({ ...book, source: 'cloud' as const }));
        const cloudIds = new Set(cloudBooks.map((book) => book.id));
        const localBooks = await getAllOfflineBooksV5(DEVICE_CONTENT_OWNER_KEY);
        if (!isCurrent()) return false;
        const localOnly = localBooks
          .filter((book) => !cloudIds.has(book.id))
          .map((book) => ({ ...book, source: 'local' as const }));
        setBooks([...cloudBooks, ...localOnly]);

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
      }
    });
  }, [clearToken, driveSessionId, onLibraryError, setIsOfflineMode]);

  return {
    books,
    setBooks,
    progress,
    setProgress,
    progressRef,
    remoteProgress,
    setRemoteProgress,
    driveCacheKey: driveSessionId ? driveCacheKey : null,
    restoreLocalData,
    loadLibraryFromDrive,
    resetLibraryState,
  };
};
