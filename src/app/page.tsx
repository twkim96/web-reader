// src/app/page.tsx
'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { auth, db, googleProvider, APP_ID } from '../lib/firebase';
import { onAuthStateChanged, signInWithPopup, signOut, User as FirebaseUser } from 'firebase/auth';
import { collection, doc, onSnapshot, setDoc, serverTimestamp, getDocs } from 'firebase/firestore';

import { findFolderId, fetchDriveFiles, isGoogleDriveAuthError } from '../lib/googleDrive';
import { getAllOfflineBooks, saveProgressToLocal, getAllLocalProgress } from '../lib/localDB';
import { Shelf } from '../components/shelf';
import dynamic from 'next/dynamic';

const EpubReader = dynamic(() => import('../components/EpubReader'), { ssr: false });
import { Book, UserProgress, ViewState, Bookmark } from '../types';
import { THEMES, ACCENT_PALETTE } from '../lib/constants';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { AuthLanding, CloudModeSelector } from '../components/AuthScreens';
import { useDeviceId } from '../hooks/useDeviceId';
import { useGoogleDriveToken } from '../hooks/useGoogleDriveToken';
import { useViewerSettings } from '../hooks/useViewerSettings';

type TimestampLike = {
  toDate?: () => Date;
};

type RemoteProgressDoc = {
  bookId?: string;
  cfi?: string;
  progressPercent?: number;
  lastRead?: TimestampLike;
  bookmarks?: Bookmark[];
  deviceId?: string;
};

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
};

type GoogleTokenClient = {
  requestAccessToken: (options: { prompt: string }) => void;
};

type GoogleAccountsWindow = Window & {
  google?: {
    accounts: {
      oauth2: {
        initTokenClient: (config: {
          client_id: string;
          scope: string;
          callback: (res: GoogleTokenResponse) => void;
        }) => GoogleTokenClient;
      };
    };
  };
};

const getStoredGuestMode = () => (
  typeof window !== 'undefined' && localStorage.getItem('isGuest') === 'true'
);

const getTimestampMs = (value: unknown, fallback = Date.now()) => {
  const timestamp = value as TimestampLike | undefined;
  const date = timestamp?.toDate ? timestamp.toDate() : undefined;
  return date ? date.getTime() : fallback;
};

export default function Page() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [view, setView] = useState<ViewState>('loading');
  const { googleToken, setGoogleToken, getStoredToken, saveToken, clearToken, hasValidToken } = useGoogleDriveToken();
  const [books, setBooks] = useState<Book[]>([]);
  const [activeBook, setActiveBook] = useState<Book | null>(null);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  const prevProgress = useRef<Record<string, UserProgress>>({});
  
  useEffect(() => {
    prevProgress.current = progress;
  }, [progress]);

  const [remoteProgress, setRemoteProgress] = useState<Record<string, UserProgress>>({});
  const deviceId = useDeviceId();

  const [isPublicPC, setIsPublicPC] = useState(false);
  const [isOfflineMode, setIsOfflineMode] = useState(true);
  const [isGuest, setIsGuest] = useState(getStoredGuestMode);
  // [Fix] Auth Effect에서 isGuest를 의존성으로 쓰면 Firebase 리스너가 재구독됨 → ref로 대체
  const isGuestRef = useRef(getStoredGuestMode());

  const [pendingAction, setPendingAction] = useState<'logout' | 'disconnect' | null>(null);
  const [showCloudAuthExpiredNotice, setShowCloudAuthExpiredNotice] = useState(false);

  const { settings, updateSettings } = useViewerSettings();

  const theme = THEMES[settings.theme as keyof typeof THEMES] || THEMES.sepia;

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
      const cloudRef = collection(db, 'artifacts', APP_ID, 'users', uid, 'readingHistory');
      const cloudSnapshot = await getDocs(cloudRef);

      // 서버 데이터를 로컬에 동기화 (서버 = 진실의 원천)
      for (const d of cloudSnapshot.docs) {
        const cloudData = d.data() as UserProgress;
        const cloudTime = getTimestampMs(cloudData.lastRead, 0);
        await saveProgressToLocal({ ...cloudData, lastRead: cloudTime });
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
      if (isGoogleDriveAuthError(err)) {
        clearToken();
      }
      console.warn("Drive Library Load Failed (Offline or Error)");
      setIsOfflineMode(true);
      return false;
    }
  };

  useEffect(() => {
    const handleOnline = async () => {
      if (user && googleToken) {
        loadLibraryFromDrive(googleToken).then((isSuccess) => {
          if (isSuccess) {
            syncLocalAndCloud(user.uid);
          }
        });
      }
    };
    const handleOffline = () => {
      setIsOfflineMode(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [user, googleToken]);

  useEffect(() => {
    queueMicrotask(() => {
      restoreLocalData(); // 초기 로드 시 실행 (기본 동작: 책장으로 이동)
    });

    const script = document.createElement('script');
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true; script.defer = true;
    document.body.appendChild(script);

    const unsubscribeAuth = onAuthStateChanged(auth, async (u) => {
      setUser(u);

      if (u) {
        setIsGuest(false);
        isGuestRef.current = false;

        // [Fix 2] 로그인 직후 로컬 데이터 복구 (화면 전환 없이 데이터만 로드)
        // 재로그인 시 책장이 비어보이는 현상을 방지하기 위함
        await restoreLocalData(true);

        const recoveredToken = getStoredToken();
        if (recoveredToken) {
          setGoogleToken(recoveredToken);
          setIsOfflineMode(false); // [Fix] 토큰이 있다면 즉시 클라우드 모드로 전환 시도

          // 읽기 모드나 책장에 있다면 로딩 화면 생략
          setView(prev => (prev === 'shelf' || prev === 'reader') ? prev : 'loading');

          loadLibraryFromDrive(recoveredToken).then((isSuccess) => {
            if (isSuccess) {
              syncLocalAndCloud(u.uid);
              setIsOfflineMode(false);
            } else {
              setIsOfflineMode(true);
            }
            setView(prev => prev === 'reader' ? 'reader' : 'shelf');
          });
        } else {
          setIsOfflineMode(true);
          // 드라이브 토큰이 없어도 튕겨내지 않고 로컬 모드 책장으로 진입
          // 이미 읽고 있는 중이라면 유지
          setView(prev => prev === 'reader' ? 'reader' : 'shelf');
        }

        const historyRef = collection(db, 'artifacts', APP_ID, 'users', u.uid, 'readingHistory');
        const unsubProgress = onSnapshot(historyRef, async (snapshot) => {
          const isFromCache = snapshot.metadata.fromCache;
          const hasPending = snapshot.metadata.hasPendingWrites;
          const p: Record<string, UserProgress> = {};

          for (const d of snapshot.docs) {
            const raw = d.data() as RemoteProgressDoc;
            const serverTime = getTimestampMs(raw.lastRead);
            const serverBookmarks = (raw.bookmarks || []) as Bookmark[];
            
            // [중요] 하이브리드 북마크 병합: 
            // 수동 북마크는 서버 데이터를 따르고, 자동 북마크는 현재 로컬 상태를 유지함
            const currentLocal = prevProgress.current[raw.bookId || d.id]?.bookmarks || [];
            const localAuto = currentLocal.filter((b: Bookmark) => b.type === 'auto');
            const mergedBookmarks = [
              ...serverBookmarks.filter((b: Bookmark) => b.type === 'manual'),
              ...localAuto
            ].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

            const bookId = raw.bookId || d.id;
            const data: UserProgress = {
              bookId,
              cfi: raw.cfi || '',
              progressPercent: raw.progressPercent || 0,
              lastRead: serverTime,
              bookmarks: mergedBookmarks,
            };
            p[bookId] = data;

            // 서버 확정 데이터만 로컬 DB에 저장
            if (!isFromCache && !hasPending) {
              await saveProgressToLocal({ ...data, lastRead: serverTime });
            }
          }

          // UI에는 항상 최신 데이터 표시
          setProgress(prev => {
            const hasChanged = Object.keys(p).some(id => {
              const old = prev[id];
              if (!old) return true;
              return old.cfi !== p[id].cfi || 
                     old.progressPercent !== p[id].progressPercent ||
                     (old.bookmarks?.length || 0) !== (p[id].bookmarks?.length || 0);
            }) || Object.keys(prev).length !== Object.keys(p).length;
            
            return hasChanged ? { ...prev, ...p } : prev;
          });

          // 원격 업데이트 감지: 서버 확정 데이터 중 다른 기기에서 온 것만 추출
          if (!isFromCache) {
            setRemoteProgress(prev => {
              let changed = false;
              const updated = { ...prev };
              for (const d of snapshot.docs) {
                const data = d.data() as RemoteProgressDoc;
                if (data.deviceId && data.deviceId !== deviceId.current) {
                  const serverTime = getTimestampMs(data.lastRead);
                  const entry: UserProgress = {
                    bookId: data.bookId || d.id,
                    cfi: data.cfi || '',
                    progressPercent: data.progressPercent || 0,
                    lastRead: serverTime,
                    bookmarks: data.bookmarks || [],
                  };
                  if (!prev[d.id] || prev[d.id].cfi !== data.cfi || prev[d.id].progressPercent !== data.progressPercent) {
                    updated[d.id] = entry;
                    changed = true;
                  }
                }
              }
              return changed ? updated : prev;
            });
          }
        });

        return () => { unsubProgress(); };

      } else {
        if (!isGuestRef.current) {
          setTimeout(() => {
            setView(prev => {
              if (prev === 'shelf') return prev;
              return 'auth';
            });
          }, 500);
        }
      }
    });
    return () => unsubscribeAuth();
  }, []);


  const handleGuestMode = async () => {
    setView('loading');
    setIsGuest(true);
    isGuestRef.current = true;
    localStorage.setItem('isGuest', 'true');
    setIsOfflineMode(true);
    setUser(null);
    setGoogleToken(null);
    await restoreLocalData(); // 게스트 모드는 강제 책장 이동 OK
    setView('shelf');
  };

  const handleLocalMode = async () => {
    setView('loading');
    await restoreLocalData(); // 로컬 모드 전환 시 강제 책장 이동 OK
    setIsOfflineMode(true);
    setGoogleToken(null);
    setView('shelf');
  };

  const handleDisconnectDrive = () => setPendingAction('disconnect');

  const handleCloudAuthExpired = useCallback(() => {
    clearToken();
    setIsOfflineMode(true);
    setShowCloudAuthExpiredNotice(true);
  }, [clearToken]);

  useEffect(() => {
    if (!googleToken || isOfflineMode) return;

    const validateCloudSession = () => {
      if (!hasValidToken()) {
        handleCloudAuthExpired();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        validateCloudSession();
      }
    };

    validateCloudSession();
    window.addEventListener('focus', validateCloudSession);
    window.addEventListener('storage', validateCloudSession);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const intervalId = window.setInterval(validateCloudSession, 30000);

    return () => {
      window.removeEventListener('focus', validateCloudSession);
      window.removeEventListener('storage', validateCloudSession);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.clearInterval(intervalId);
    };
  }, [googleToken, handleCloudAuthExpired, hasValidToken, isOfflineMode]);

  const handleConnect = () => {
    const google = (window as GoogleAccountsWindow).google;
    if (!google) return;

    const client = google.accounts.oauth2.initTokenClient({
      client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '',
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (res) => {
        if (res.access_token && res.expires_in) {
          saveToken(res.access_token, res.expires_in, isPublicPC);

          setIsOfflineMode(false);
          setView('loading');
          loadLibraryFromDrive(res.access_token).then(() => {
            setView('shelf');
          });
        }
      },
    });
    client.requestAccessToken({ prompt: googleToken ? '' : 'select_account' });
  };

  const handleLoginTrigger = () => {
    signInWithPopup(auth, googleProvider).catch(console.error);
  };

  const handleLogout = () => setPendingAction('logout');

  const executePendingAction = async () => {
    if (pendingAction === 'logout') {
      await signOut(auth);
      clearToken();
      setBooks([]);
      setIsGuest(false);
      setView('auth');
    } else if (pendingAction === 'disconnect') {
      clearToken();
      await handleLocalMode();
    }
    setPendingAction(null);
  };

  const handleSaveProgress = useCallback((cfi: number | string, pct: number, bookmarks?: Bookmark[]) => {
    if (!activeBook) return;

    setProgress(prev => {
      const now = Date.now();
      const existingBookmarks = prev[activeBook.id]?.bookmarks || [];
      const finalBookmarks = bookmarks !== undefined ? bookmarks : existingBookmarks;

      const progressData: UserProgress = {
        bookId: activeBook.id,
        cfi: String(cfi),
        progressPercent: pct,
        lastRead: now,
        bookmarks: finalBookmarks
      };

      // 비동기 작업에 필요한 값을 미리 캡처 (activeBook이 null이 될 경우 대비)
      const bookId = activeBook.id;
      const currentBookmarks = progressData.bookmarks || [];

      // Perform side-effects async
      setTimeout(async () => {
        try {
          await saveProgressToLocal(progressData);
        } catch (e) { console.error(e); }

        if (user) {
          try {
            // Firestore에는 수동 북마크만 저장
            const manualOnly = currentBookmarks.filter(b => b.type === 'manual');
            const syncData = { ...progressData, bookmarks: manualOnly };
            
            const docRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'readingHistory', bookId);
            await setDoc(docRef, { ...syncData, lastRead: serverTimestamp(), deviceId: deviceId.current }, { merge: true });
          } catch (e) { console.error('[SaveProgress] Firestore save failed:', e); }
        }
      }, 0);

      return { ...prev, [bookId]: progressData };
    });
  }, [user, activeBook, deviceId]);

  const handleDeleteProgress = useCallback(async (bookId: string) => {
    const now = Date.now();
    const resetData: UserProgress = {
      bookId,
      cfi: '',
      progressPercent: 0,
      lastRead: now,
      bookmarks: []
    };

    setProgress(prev => ({ ...prev, [bookId]: resetData }));

    try {
      await saveProgressToLocal(resetData);
    } catch (e) { console.error(e); }

    if (user) {
      try {
        await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'readingHistory', bookId), { 
          ...resetData, 
          lastRead: serverTimestamp(),
          deviceId: deviceId.current
        }, { merge: true });
      } catch (e) { console.error(e); }
    }
  }, [user, deviceId]);

  const accentColorObj = ACCENT_PALETTE[settings.accentColor] || ACCENT_PALETTE.indigo;
  const dynamicStyles = {
    '--accent-400': accentColorObj[400],
    '--accent-500': accentColorObj[500],
    '--accent-600': accentColorObj[600],
  } as React.CSSProperties;

  if (view === 'loading') {
    return (
      <div className={`h-screen w-screen flex flex-col items-center justify-center ${theme.bg} ${theme.text} gap-4 transition-colors duration-300`} style={dynamicStyles}>
        <div className="w-12 h-12 border-4 border-accent-500 border-t-transparent rounded-full animate-spin" />
        <p className="font-black uppercase tracking-widest text-xs opacity-30">Loading Library...</p>
      </div>
    );
  }

  return (
    <div className={`min-h-screen font-sans ${theme.bg} ${theme.text} transition-colors duration-300`} style={dynamicStyles}>
      {/* 1. 로그인 화면 */}
      {view === 'auth' && !user && (
        <AuthLanding
          theme={theme}
          onGoogleSignIn={handleLoginTrigger}
          onGuestMode={handleGuestMode}
        />
      )}

      {/* 2. 모드 선택 화면 */}
      {view === 'auth' && user && (
        <CloudModeSelector
          theme={theme}
          userName={user.displayName || user.email || 'Google User'}
          isPublicPC={isPublicPC}
          onPublicPCChange={setIsPublicPC}
          onLogout={handleLogout}
          onConnect={handleConnect}
          onLocalMode={handleLocalMode}
        />
      )}

      {/* 3. 책장 */}
      {view === 'shelf' && (
        <Shelf
          books={books}
          progress={progress}
          googleToken={googleToken}
          onRefresh={() => !isOfflineMode && googleToken && loadLibraryFromDrive(googleToken)}
          onOpen={(b) => { setActiveBook(b); setView('reader'); }}
          onLogout={handleLogout}
          onLogin={handleLoginTrigger}
          userEmail={user?.email || "Guest User"}
          isOfflineMode={isOfflineMode}
          isGuest={isGuest}
          onToggleCloud={isOfflineMode ? handleConnect : handleDisconnectDrive}
          onDeleteProgress={handleDeleteProgress}
          settings={settings}
          onUpdateSettings={updateSettings}
          onLocalBookImported={() => restoreLocalData(true)}
          isCloudTokenValid={hasValidToken}
          onCloudAuthExpired={handleCloudAuthExpired}
        />
      )}

      {/* 4. 리더 (epub 전용) */}
      {view === 'reader' && activeBook && (
        <EpubReader
          key={activeBook.id}
          book={activeBook}
          googleToken={googleToken || ''}
          settings={settings}
          onUpdateSettings={updateSettings}
          onBack={() => { setView('shelf'); requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' })); }}
          onSaveProgress={handleSaveProgress}
          initialCfi={progress[activeBook.id]?.cfi}
          initialPercent={progress[activeBook.id]?.progressPercent}
          initialTime={progress[activeBook.id]?.lastRead}
          initialBookmarks={progress[activeBook.id]?.bookmarks || []}
          remoteProgress={remoteProgress[activeBook.id]}
        />
      )}

      {pendingAction && (
        <ConfirmDialog
          message={pendingAction === 'logout' ? '로그아웃 하시겠습니까?' : '클라우드 연결을 해제하시겠습니까?'}
          subMessage={pendingAction === 'disconnect' ? '로컬 모드로 전환됩니다.' : undefined}
          confirmLabel={pendingAction === 'logout' ? '로그아웃' : '연결 해제'}
          theme={theme}
          onConfirm={executePendingAction}
          onCancel={() => setPendingAction(null)}
        />
      )}

      {showCloudAuthExpiredNotice && (
        <ConfirmDialog
          message="클라우드 세션이 만료되었습니다."
          subMessage="현재 도서는 기기에만 저장됩니다. 다시 클라우드를 연결하면 구글 드라이브 업로드를 사용할 수 있습니다."
          confirmLabel="확인"
          hideCancel
          variant="info"
          theme={theme}
          onConfirm={() => setShowCloudAuthExpiredNotice(false)}
          onCancel={() => setShowCloudAuthExpiredNotice(false)}
        />
      )}
    </div>
  );
}
