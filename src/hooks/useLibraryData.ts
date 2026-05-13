import { Dispatch, MutableRefObject, SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { APP_ID, db } from '../lib/firebase';
import { fetchDriveFiles, findFolderId, isGoogleDriveAuthError } from '../lib/googleDrive';
import { getAllLocalProgress, getAllOfflineBooks, saveProgressToLocal } from '../lib/localDB';
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
}: UseLibraryDataOptions): UseLibraryDataResult => {
  const [books, setBooks] = useState<Book[]>([]);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  const [remoteProgress, setRemoteProgress] = useState<Record<string, UserProgress>>({});
  const progressRef = useRef<Record<string, UserProgress>>({});

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  const restoreLocalData = useCallback(async (options?: boolean | RestoreLocalDataOptions) => {
    const { preventRedirect, replaceBooks } = normalizeRestoreOptions(options);

    try {
      if (!preventRedirect) setIsOfflineMode(true);

      const [localBooks, localProgress] = await Promise.all([
        getAllOfflineBooks(),
        getAllLocalProgress(),
      ]);

      const localProgressByBook: Record<string, UserProgress> = {};
      localProgress.forEach((item) => {
        localProgressByBook[item.bookId] = item;
      });

      setProgress((prev) => {
        const merged = { ...prev, ...localProgressByBook };
        progressRef.current = merged;
        return merged;
      });

      if (replaceBooks) {
        setBooks(localBooks);
      } else if (localBooks.length > 0) {
        setBooks((prev) => {
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

    try {
      const cloudRef = collection(db, 'artifacts', APP_ID, 'users', uid, 'readingHistory');
      const cloudSnapshot = await getDocs(cloudRef);

      for (const documentSnapshot of cloudSnapshot.docs) {
        const cloudData = documentSnapshot.data() as RemoteProgressDoc;
        const bookId = cloudData.bookId || documentSnapshot.id;
        const cloudTime = getTimestampMs(cloudData.lastRead, 0);
        const localBookmarks = progressRef.current[bookId]?.bookmarks || [];

        await saveProgressToLocal({
          bookId,
          cfi: cloudData.cfi || '',
          progressPercent: toProgressPercent(cloudData.progressPercent) ?? 0,
          lastRead: cloudTime,
          bookmarks: mergeRemoteManualWithLocalAuto(cloudData.bookmarks || [], localBookmarks),
        });
      }
    } catch (error) {
      console.warn('Background sync paused:', error);
    }
  }, []);

  const loadLibraryFromDrive = useCallback(async (token: string) => {
    try {
      const folderId = await findFolderId('web viewer', token);

      if (folderId) {
        const data = await fetchDriveFiles(token, folderId);
        if (data.files && data.files.length > 0) {
          const cloudIds = new Set(data.files.map((file: Book) => file.id));
          const localBooks = await getAllOfflineBooks();
          const localOnly = localBooks.filter((book) => !cloudIds.has(book.id));
          setBooks([...data.files, ...localOnly]);
        }
      }

      setIsOfflineMode(false);
      return true;
    } catch (error) {
      if (isGoogleDriveAuthError(error)) {
        clearToken();
      }
      console.warn('Drive Library Load Failed (Offline or Error)');
      setIsOfflineMode(true);
      return false;
    }
  }, [clearToken, setIsOfflineMode]);

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
  };
};
