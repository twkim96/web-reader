// src/hooks/useLibrary.ts
'use client';

import { useState, useCallback } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import { collection, doc, setDoc, serverTimestamp, getDocs, deleteDoc } from 'firebase/firestore';
import { db, APP_ID } from '../lib/firebase';
import { findFolderId, fetchDriveFiles } from '../lib/googleDrive';
import { getAllOfflineBooks, saveProgressToLocal, getAllLocalProgress, removeProgressFromLocal } from '../lib/localDB';
import { Book, UserProgress, Bookmark, ViewState } from '../types';

interface UseLibraryArgs {
  user: FirebaseUser | null;
  setView: React.Dispatch<React.SetStateAction<ViewState>>;
}

export function useLibrary({ user, setView }: UseLibraryArgs) {
  const [books, setBooks] = useState<Book[]>([]);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [isOfflineMode, setIsOfflineMode] = useState(true);

  const getStoredToken = () => {
    const sToken = sessionStorage.getItem('google_drive_token');
    const sExpiry = sessionStorage.getItem('google_drive_token_expiry');
    if (sToken && sExpiry && Date.now() < parseInt(sExpiry)) return sToken;

    const lToken = localStorage.getItem('google_drive_token');
    const lExpiry = localStorage.getItem('google_drive_token_expiry');
    if (lToken && lExpiry && Date.now() < parseInt(lExpiry)) return lToken;

    return null;
  };

  // [Modified] preventRedirect 인자 추가: 데이터만 로드하고 화면 전환은 하지 않는 옵션
  const restoreLocalData = async (preventRedirect = false) => {
    try {
      if (!preventRedirect) setIsOfflineMode(true);

      const [localBooks, localProgress] = await Promise.all([
        getAllOfflineBooks(),
        getAllLocalProgress()
      ]);

      const p: Record<string, UserProgress> = {};
      localProgress.forEach(item => { p[item.bookId] = item; });

      // progress는 항상 merge (덮어쓰지 않음)
      setProgress(prev => ({ ...prev, ...p }));

      if (localBooks.length > 0) {
        // books는 기존 목록에 로컬 전용 도서만 추가 (중복 방지)
        setBooks(prev => {
          const existingIds = new Set(prev.map(b => b.id));
          const newBooks = localBooks.filter(b => !existingIds.has(b.id));
          // 목록이 비어 있으면 전체 로컬 도서로 채움, 아니면 새것만 append
          return prev.length === 0 ? localBooks : newBooks.length > 0 ? [...prev, ...newBooks] : prev;
        });
        if (!preventRedirect) setView('shelf');
        return true;
      }
      return false;
    } catch (e) {
      console.error("Failed to restore local data:", e);
      return false;
    }
  };

  const syncLocalAndCloud = async (uid: string) => {
    if (!navigator.onLine) return;

    try {
      const localProgressList = await getAllLocalProgress();
      const cloudRef = collection(db, 'artifacts', APP_ID, 'users', uid, 'readingHistory');
      const cloudSnapshot = await getDocs(cloudRef);

      const localMap = new Map(localProgressList.map(p => [p.bookId, p]));
      const cloudMap = new Map(cloudSnapshot.docs.map(d => [d.id, d.data() as UserProgress]));

      for (const [bookId, localData] of localMap.entries()) {
        const cloudData = cloudMap.get(bookId);
        const localTime = new Date(localData.lastRead).getTime();
        const cloudTime = cloudData?.lastRead?.toDate ? cloudData.lastRead.toDate().getTime() : 0;

        if (!cloudData || localTime > cloudTime) {
          await setDoc(doc(cloudRef, bookId), { ...localData, lastRead: serverTimestamp() }, { merge: true });
        }
      }

      for (const [bookId, cloudData] of cloudMap.entries()) {
        const localData = localMap.get(bookId);
        const localTime = localData ? new Date(localData.lastRead).getTime() : 0;
        const cloudTime = cloudData.lastRead?.toDate ? cloudData.lastRead.toDate().getTime() : 0;

        if (!localData || cloudTime > localTime) {
          await saveProgressToLocal({ ...cloudData, lastRead: cloudTime });
        }
      }
    } catch (e) {
      console.warn("Background sync paused:", e);
    }
  };

  /**
   * 구글 드라이브에서 도서 목록을 불러옵니다.
   */
  const loadLibraryFromDrive = async (token: string) => {
    try {
      const targetFolderName = "web viewer";
      const fid = await findFolderId(targetFolderName, token);
      
      if (fid) {
        const data = await fetchDriveFiles(token, fid);
        if (data.files && data.files.length > 0) {
          // 클라우드 도서 + 로컬 전용 도서 병합
          const cloudIds = new Set(data.files.map((f: Book) => f.id));
          const localBooks = await getAllOfflineBooks();
          const localOnly = localBooks.filter(b => !cloudIds.has(b.id));
          setBooks([...data.files, ...localOnly]);
        }
      }
      setIsOfflineMode(false);
      return true;
    } catch (err) {
      console.warn("Drive Library Load Failed (Offline or Error)");
      setIsOfflineMode(true);
      return false;
    }
  };

  const handleSaveProgress = useCallback(async (idx: number, pct: number, bookmarks?: Bookmark[], activeBook?: Book | null) => {
    if (!activeBook || isNaN(idx)) return;

    const now = Date.now();
    const progressData: UserProgress = {
      bookId: activeBook.id,
      charIndex: idx,
      progressPercent: pct,
      lastRead: now,
      bookmarks: bookmarks
    };

    try {
      await saveProgressToLocal(progressData);
      setProgress(prev => ({ ...prev, [activeBook.id]: progressData }));
    } catch (e) { console.error(e); }

    if (user) {
      try {
        const docRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'readingHistory', activeBook.id);
        await setDoc(docRef, { ...progressData, lastRead: serverTimestamp() }, { merge: true });
      } catch (e) { }
    }
  }, [user]);

  const handleDeleteProgress = useCallback(async (bookId: string) => {
    setProgress(prev => {
      const next = { ...prev };
      delete next[bookId];
      return next;
    });

    try {
      await removeProgressFromLocal(bookId);
    } catch (e) { console.error(e); }

    if (user) {
      try {
        await deleteDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'readingHistory', bookId));
      } catch (e) { console.error(e); }
    }
  }, [user]);

  return {
    books, setBooks,
    progress, setProgress,
    googleToken, setGoogleToken,
    isOfflineMode, setIsOfflineMode,
    getStoredToken,
    restoreLocalData,
    syncLocalAndCloud,
    loadLibraryFromDrive,
    handleSaveProgress,
    handleDeleteProgress,
  };
}
