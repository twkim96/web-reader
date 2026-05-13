// src/app/page.tsx
'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { auth, db, googleProvider, APP_ID } from '../lib/firebase';
import { signInWithPopup, signOut, User as FirebaseUser } from 'firebase/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';

import { saveProgressToLocal } from '../lib/localDB';
import { Shelf } from '../components/shelf';
import dynamic from 'next/dynamic';

const EpubReader = dynamic(() => import('../components/EpubReader'), { ssr: false });
import { Book, UserProgress, ViewState, Bookmark } from '../types';
import { THEMES, ACCENT_PALETTE } from '../lib/constants';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { AuthLanding, CloudModeSelector } from '../components/AuthScreens';
import { useAuthBootstrap } from '../hooks/useAuthBootstrap';
import { useDeviceId } from '../hooks/useDeviceId';
import { useGoogleDriveToken } from '../hooks/useGoogleDriveToken';
import { useGoogleIdentityScript } from '../hooks/useGoogleIdentityScript';
import { useLibraryData } from '../hooks/useLibraryData';
import { useNetworkLibrarySync } from '../hooks/useNetworkLibrarySync';
import { useViewerSettings } from '../hooks/useViewerSettings';

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

export default function Page() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [view, setView] = useState<ViewState>('loading');
  const { googleToken, setGoogleToken, getStoredToken, saveToken, clearToken, hasValidToken } = useGoogleDriveToken();
  const [activeBook, setActiveBook] = useState<Book | null>(null);
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
  const {
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
  } = useLibraryData({ clearToken, setIsOfflineMode, setView });

  useGoogleIdentityScript();
  useAuthBootstrap({
    deviceId,
    progressRef,
    isGuestRef,
    getStoredToken,
    setGoogleToken,
    setUser,
    setIsGuest,
    setIsOfflineMode,
    setProgress,
    setRemoteProgress,
    setView,
    restoreLocalData,
    loadLibraryFromDrive,
    syncLocalAndCloud,
  });
  useNetworkLibrarySync({
    user,
    googleToken,
    setIsOfflineMode,
    loadLibraryFromDrive,
    syncLocalAndCloud,
  });


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
  }, [user, activeBook, deviceId, setProgress]);

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
  }, [user, deviceId, setProgress]);

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
