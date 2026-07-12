import { Dispatch, MutableRefObject, SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { APP_ID, db } from '../lib/firebase';
import {
  fetchDriveFiles,
  getDriveLibraryFolderId,
  GoogleDriveFolderConflictError,
  isGoogleDriveAuthError,
} from '../lib/googleDrive';
import {
  getAllLocalProgressV5,
  getAllOfflineBooksV5,
  saveProgressToLocalV5,
} from '../lib/localDBV5';
import { ownerRuntime } from '../lib/ownerRuntime';
import { Book, UserProgress, ViewState } from '../types';
import {
  getTimestampMs,
  mergeRemoteManualWithLocalAuto,
  RemoteProgressDoc,
  toProgressPercent,
} from './progressPolicy';

interface UseLibraryDataOptions {
  clearToken: () => void;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<ViewState>>;
  onLibraryError?: (message: string) => void;
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
  syncLocalAndCloud: (uid: string) => Promise<void>;
  loadLibraryFromDrive: (token: string) => Promise<boolean>;
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
}: UseLibraryDataOptions): UseLibraryDataResult => {
  const [books, setBooks] = useState<Book[]>([]);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  const [remoteProgress, setRemoteProgress] = useState<Record<string, UserProgress>>({});
  const progressRef = useRef<Record<string, UserProgress>>({});

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  const resetLibraryState = useCallback(() => {
    progressRef.current = {};
    setBooks([]);
    setProgress({});
    setRemoteProgress({});
  }, []);

  const restoreLocalData = useCallback(async (options?: boolean | RestoreLocalDataOptions) => {
    const { preventRedirect, replaceBooks } = normalizeRestoreOptions(options);
    const owner = ownerRuntime.capture();
    if (!owner) return false;

    try {
      if (!preventRedirect) setIsOfflineMode(true);

      const [localBooks, localProgress] = await Promise.all([
        getAllOfflineBooksV5(owner.ownerKey),
        getAllLocalProgressV5(owner.ownerKey),
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
  }, [setIsOfflineMode, setView]);

  const syncLocalAndCloud = useCallback(async (uid: string) => {
    if (!navigator.onLine) return;
    const owner = ownerRuntime.capture();
    if (!owner) return;

    try {
      const cloudRef = collection(db, 'artifacts', APP_ID, 'users', uid, 'readingHistory');
      const cloudSnapshot = await getDocs(cloudRef);
      if (!ownerRuntime.isCurrent(owner)) return;

      for (const documentSnapshot of cloudSnapshot.docs) {
        const cloudData = documentSnapshot.data() as RemoteProgressDoc;
        const bookId = cloudData.bookId || documentSnapshot.id;
        const cloudTime = getTimestampMs(cloudData.lastRead, 0);
        const localBookmarks = progressRef.current[bookId]?.bookmarks || [];

        await saveProgressToLocalV5(owner.ownerKey, {
          bookId,
          cfi: cloudData.cfi || '',
          anchorCfi: cloudData.anchorCfi || cloudData.cfi || '',
          progressPercent: toProgressPercent(cloudData.progressPercent) ?? 0,
          lastRead: cloudTime,
          bookmarks: mergeRemoteManualWithLocalAuto(cloudData.bookmarks || [], localBookmarks),
        });
        if (!ownerRuntime.isCurrent(owner)) return;
      }
    } catch (error) {
      console.warn('Background sync paused:', error);
    }
  }, []);

  const loadLibraryFromDrive = useCallback(async (token: string) => {
    const owner = ownerRuntime.capture();
    if (!owner) return false;
    try {
      const folderId = await getDriveLibraryFolderId(token);
      if (!ownerRuntime.isCurrent(owner)) return false;
      const data = folderId
        ? await fetchDriveFiles(token, folderId)
        : { files: [] };
      if (!ownerRuntime.isCurrent(owner)) return false;
      const cloudBooks = (data.files as Book[]).map((book) => ({ ...book, source: 'cloud' as const }));
      const cloudIds = new Set(cloudBooks.map((book) => book.id));
      const localBooks = await getAllOfflineBooksV5(owner.ownerKey);
      if (!ownerRuntime.isCurrent(owner)) return false;
      const localOnly = localBooks
        .filter((book) => !cloudIds.has(book.id))
        .map((book) => ({ ...book, source: 'local' as const }));
      setBooks([...cloudBooks, ...localOnly]);

      setIsOfflineMode(false);
      return true;
    } catch (error) {
      if (isGoogleDriveAuthError(error)) {
        clearToken();
      }
      if (error instanceof GoogleDriveFolderConflictError) {
        onLibraryError?.(error.message);
      }
      console.warn('Drive Library Load Failed (Offline or Error)');
      setIsOfflineMode(true);
      return false;
    }
  }, [clearToken, onLibraryError, setIsOfflineMode]);

  return {
    books,
    setBooks,
    progress,
    setProgress,
    progressRef,
    remoteProgress,
    setRemoteProgress,
    restoreLocalData,
    syncLocalAndCloud,
    loadLibraryFromDrive,
    resetLibraryState,
  };
};
