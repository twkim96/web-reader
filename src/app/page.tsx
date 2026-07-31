// src/app/page.tsx
'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { auth, googleProvider } from '../lib/firebase';
import { signInWithRedirect, signOut, User as FirebaseUser } from 'firebase/auth';

import { Shelf } from '../components/shelf';
import dynamic from 'next/dynamic';

const EpubReader = dynamic(() => import('../components/EpubReader'), { ssr: false });
import { Book, Bookmark, SaveProgressOptions, ViewState } from '../types';
import { ACCENT_PALETTE } from '../lib/constants';
import { getThemeClasses, getThemeColors, getThemeCssVariables } from '../lib/themeUtils';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  deleteDriveFile,
  invalidateDriveCache,
  isGoogleDriveAuthError,
  isGoogleDrivePermissionError,
} from '../lib/googleDrive';
import { removeBookAndAnnotationsV8 } from '../lib/localDBV5';
import { deleteBookInSafeOrder } from '../lib/bookDeletion';
import { subscribeLocalDBLifecycle, type LocalDBLifecycleEvent } from '../lib/localDB';
import { AuthLanding } from '../components/AuthScreens';
import { useAuthBootstrap } from '../hooks/useAuthBootstrap';
import { useDeviceId } from '../hooks/useDeviceId';
import { useDriveOAuthRedirect } from '../hooks/useDriveOAuthRedirect';
import { useGoogleDriveToken } from '../hooks/useGoogleDriveToken';
import { useLibraryData } from '../hooks/useLibraryData';
import { useNetworkLibrarySync } from '../hooks/useNetworkLibrarySync';
import { useProgressActions } from '../hooks/useProgressActions';
import { useProgressSync } from '../hooks/useProgressSync';
import { useProgressSyncWorker } from '../hooks/useProgressSyncWorker';
import { useViewerSettings } from '../hooks/useViewerSettings';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { AppInstallPrompt } from '../components/AppInstallPrompt';
import { SyncConflictResolutionDialog } from '../components/SyncConflictResolutionDialog';
import { getBookOpenLimitError } from '../lib/bookFormats';
import {
  clearLastReaderSession,
  getLastReaderBookCandidate,
  isLastReaderProgressComplete,
  saveLastReaderSession,
} from '../lib/lastReaderSession';
import {
  getOrCreateGuestInstallId,
  DEVICE_CONTENT_OWNER_KEY,
  makeGuestOwnerKey,
  makeOwnerKey,
} from '../lib/ownerIdentity';
import { ownerRuntime } from '../lib/ownerRuntime';
import { useSyncConflictResolution } from '../hooks/useSyncConflictResolution';
import { useServiceWorkerUpdate } from '../hooks/useServiceWorkerUpdate';
import { mergeLatestProgressForDisplay } from '../lib/progressDisplay';
import { hasPendingGoogleDriveOAuth } from '../lib/googleDriveOAuth';
import { hasRestorableDriveTokenSession } from '../lib/driveTokenMemory';
import { mergeSyncHealth } from '../lib/syncHealth';

const getStoredGuestMode = () => (
  typeof window !== 'undefined' && localStorage.getItem('isGuest') === 'true'
);

export default function Page() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [view, setView] = useState<ViewState>('loading');
  const {
    googleToken,
    driveSessionId,
    saveToken,
    clearToken,
    hasValidToken,
    revokeToken,
  } = useGoogleDriveToken();
  const [activeBook, setActiveBook] = useState<Book | null>(null);
  const deviceId = useDeviceId();
  const hasTriedAutoOpenLastBookRef = useRef(false);

  const [isOfflineMode, setIsOfflineMode] = useState(true);
  const [isGuest, setIsGuest] = useState(getStoredGuestMode);
  // [Fix] Auth Effect에서 isGuest를 의존성으로 쓰면 Firebase 리스너가 재구독됨 → ref로 대체
  const isGuestRef = useRef(getStoredGuestMode());

  const [pendingAction, setPendingAction] = useState<'logout' | 'disconnect' | null>(null);
  const [cloudAuthExpiredMessage, setCloudAuthExpiredMessage] = useState<React.ReactNode | null>(null);
  const [cloudPermissionMessage, setCloudPermissionMessage] = useState<React.ReactNode | null>(null);
  const [authErrorMessage, setAuthErrorMessage] = useState<string | null>(null);
  const [progressPersistenceError, setProgressPersistenceError] = useState<string | null>(null);
  const [localDBLifecycleEvent, setLocalDBLifecycleEvent] = useState<LocalDBLifecycleEvent | null>(null);
  const [recentlyImportedBookIds, setRecentlyImportedBookIds] = useState<string[]>([]);
  const readerProgressFlushRef = useRef<(() => Promise<boolean>) | null>(null);
  const readerQuietResumeEligibilityRef = useRef<(() => boolean) | null>(null);
  const canQuietlyResolveProgressConflict = useCallback(
    () => readerQuietResumeEligibilityRef.current?.() ?? false,
    [],
  );
  const shouldHoldShelfForDrive = useCallback(() => (
    hasPendingGoogleDriveOAuth(sessionStorage, window.location.hash)
    || hasRestorableDriveTokenSession(sessionStorage)
  ), []);

  const { settings, updateSettings } = useViewerSettings();
  const { isInstallable, isIOS, promptInstall, isStandalone } = usePWAInstall();
  const serviceWorkerUpdate = useServiceWorkerUpdate({
    flushCurrentProgress: useCallback(async () => (
      readerProgressFlushRef.current ? readerProgressFlushRef.current() : true
    ), []),
    onPersistenceError: setProgressPersistenceError,
  });
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const accentColorObj = useMemo(
    () => ACCENT_PALETTE[settings.accentColor] || ACCENT_PALETTE.indigo,
    [settings.accentColor],
  );
  const themeLookupSettings = useMemo(
    () => ({
      theme: settings.theme,
      customThemes: settings.customThemes,
    }),
    [settings.customThemes, settings.theme],
  );
  const themeColors = useMemo(
    () => getThemeColors(themeLookupSettings),
    [themeLookupSettings],
  );
  const themeCssVariables = useMemo(
    () => getThemeCssVariables(themeLookupSettings),
    [themeLookupSettings],
  );

  useEffect(() => {
    if (view === 'shelf' && isInstallable && !isStandalone) {
      const neverShow = localStorage.getItem('neverShowInstallPrompt');
      const lastSeen = localStorage.getItem('lastSeenInstallPrompt');
      const now = Date.now();

      if (neverShow === 'true') return;
      if (lastSeen && now - parseInt(lastSeen, 10) < 24 * 60 * 60 * 1000) return; // Hide for 24 hours if just closed

      // slight delay so it doesn't jarringly pop up immediately
      const timer = setTimeout(() => setShowInstallPrompt(true), 1500);
      return () => clearTimeout(timer);
    }
  }, [view, isInstallable, isStandalone]);

  const handleCloseInstallPrompt = (neverShow: boolean) => {
    if (neverShow) {
      localStorage.setItem('neverShowInstallPrompt', 'true');
    } else {
      localStorage.setItem('lastSeenInstallPrompt', Date.now().toString());
    }
    setShowInstallPrompt(false);
  };

  const handleInstallApp = async () => {
    const accepted = await promptInstall();
    handleCloseInstallPrompt(accepted); // Never show again only if successfully installed.
  };

  const theme = getThemeClasses(settings);
  const activeOwnerKey = ownerRuntime.capture()?.ownerKey ?? null;
  useEffect(() => subscribeLocalDBLifecycle(setLocalDBLifecycleEvent), []);

  useEffect(() => {
    const color = themeColors.bg;
    const shellVariables = {
      '--accent-400': accentColorObj[400],
      '--accent-500': accentColorObj[500],
      '--accent-600': accentColorObj[600],
      ...themeCssVariables,
    } as React.CSSProperties;

    const ensureMeta = (name: string) => {
      let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', name);
        document.head.appendChild(meta);
      }
      return meta;
    };

    const themeColorTags = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeColorTags.length === 0) {
      ensureMeta('theme-color').setAttribute('content', color);
    } else {
      themeColorTags.forEach((tag) => tag.setAttribute('content', color));
    }

    ensureMeta('msapplication-navbutton-color').setAttribute('content', color);
    Object.entries(shellVariables).forEach(([key, value]) => {
      document.documentElement.style.setProperty(key, String(value));
      document.body.style.setProperty(key, String(value));
    });
    document.documentElement.style.backgroundColor = color;
    document.body.style.backgroundColor = color;
    document.documentElement.removeAttribute('data-viewer-theme-bootstrapped');
    document.getElementById('viewer-theme-bootstrap-style')?.remove();
  }, [accentColorObj, themeColors.bg, themeCssVariables]);

  const {
    books,
    setBooks,
    progress,
    setProgress,
    progressRef,
    remoteProgress,
    setRemoteProgress,
    driveCacheKey,
    restoreLocalData,
    loadLibraryFromDrive,
    resetLibraryState,
  } = useLibraryData({
    clearToken,
    setIsOfflineMode,
    setView,
    onLibraryError: setAuthErrorMessage,
    driveSessionId,
  });
  const shelfProgress = useMemo(
    () => mergeLatestProgressForDisplay(progress, remoteProgress),
    [progress, remoteProgress],
  );
  const handleBookImported = useCallback((book: Book, savedLocally: boolean) => {
    setRecentlyImportedBookIds((current) => (
      current.includes(book.id) ? current : [...current, book.id]
    ));
    if (savedLocally) void restoreLocalData(true);
  }, [restoreLocalData]);

  const isAuthenticatedLibraryReady = useAuthBootstrap({
    isGuestRef,
    setUser,
    setIsGuest,
    setIsOfflineMode,
    setView,
    restoreLocalData,
    resetLibraryState,
    shouldHoldShelfForDrive,
  });
  const receiveSyncHealth = useProgressSync({
    user,
    deviceId,
    progressRef,
    setRemoteProgress,
    activeBookId: activeBook?.id,
    ownerKey: activeOwnerKey,
  });
  const sendSyncHealth = useProgressSyncWorker(user, activeOwnerKey, deviceId.current);
  const syncHealth = mergeSyncHealth(receiveSyncHealth, sendSyncHealth);
  const syncConflictResolution = useSyncConflictResolution({
    user,
    progressRef,
    setProgress,
    setRemoteProgress,
    ownerKey: activeOwnerKey,
    activeBookId: activeBook?.id,
    canQuietlyResolveProgressConflict,
  });
  useNetworkLibrarySync({
    user,
    googleToken,
    driveSessionId,
    isAuthenticatedLibraryReady,
    setIsOfflineMode,
    setView,
    loadLibraryFromDrive,
  });
  const startDriveOAuth = useDriveOAuthRedirect({
    saveToken,
    setIsOfflineMode,
    setView,
    setAuthErrorMessage,
  });


  const handleGuestMode = async () => {
    ownerRuntime.activate(makeOwnerKey(
      makeGuestOwnerKey(getOrCreateGuestInstallId(localStorage)),
      'library:local',
    ));
    resetLibraryState();
    setActiveBook(null);
    setView('loading');
    setIsGuest(true);
    isGuestRef.current = true;
    localStorage.setItem('isGuest', 'true');
    setIsOfflineMode(true);
    setUser(null);
    clearToken();
    await restoreLocalData({ replaceBooks: true }); // 게스트 모드는 로컬 책장만 표시
    setView('shelf');
  };

  const handleLocalMode = async () => {
    setView('loading');
    await restoreLocalData({ replaceBooks: true }); // 로컬 모드 전환 시 클라우드 캐시 제거
    setIsOfflineMode(true);
    clearToken();
    setView('shelf');
  };

  const handleDisconnectDrive = () => setPendingAction('disconnect');

  const handleCloudAuthExpired = useCallback((message?: React.ReactNode) => {
    if (driveCacheKey) invalidateDriveCache(driveCacheKey);
    clearToken();
    setIsOfflineMode(true);
    setCloudAuthExpiredMessage(message || "현재 도서는 기기에만 저장됩니다. 다시 클라우드를 연결하면 구글 드라이브 업로드를 사용할 수 있습니다.");
    void restoreLocalData({ preventRedirect: true, replaceBooks: true });
  }, [clearToken, driveCacheKey, restoreLocalData]);

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
    if (isGuest || !user) {
      handleLoginTrigger();
      return;
    }

    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';
    if (!clientId) {
      setAuthErrorMessage('Google Drive 연결 설정을 찾지 못했습니다.');
      return;
    }

    startDriveOAuth(clientId);
  };

  const handleLoginTrigger = () => {
    ownerRuntime.clear();
    resetLibraryState();
    setActiveBook(null);
    setAuthErrorMessage(null);
    setIsGuest(false);
    isGuestRef.current = false;
    localStorage.removeItem('isGuest');

    setView('loading');

    signInWithRedirect(auth, googleProvider).catch((error) => {
      console.error('[Auth] Google redirect failed:', error);

      setAuthErrorMessage(
        'Google 로그인을 시작하지 못했습니다. 새로고침 후 다시 시도해 주세요.'
      );
      setView('auth');
    });
  };

  const handleLogout = () => setPendingAction('logout');

  const executePendingAction = async () => {
    if (pendingAction === 'logout') {
      if (driveCacheKey) invalidateDriveCache(driveCacheKey);
      ownerRuntime.clear();
      resetLibraryState();
      setActiveBook(null);
      await signOut(auth);
      clearToken();
      clearLastReaderSession();
      setBooks([]);
      setIsGuest(false);
      setView('auth');
    } else if (pendingAction === 'disconnect') {
      await revokeToken();
      if (driveCacheKey) invalidateDriveCache(driveCacheKey);
      clearToken();
      clearLastReaderSession();
      await handleLocalMode();
    }
    setPendingAction(null);
  };

  const {
    saveProgress: handleSaveProgress,
    deleteProgress: handleDeleteProgress,
    deleteBookProgress: handleDeleteBookProgress,
    adoptRemoteProgress: handleAdoptRemoteProgress,
  } = useProgressActions({
    activeBook,
    user,
    deviceId,
    progressRef,
    setProgress,
    onPersistenceError: setProgressPersistenceError,
  });

  const handleReaderSaveProgress = useCallback((
    cfi: string,
    pct: number,
    bookmarks?: Bookmark[],
    options?: SaveProgressOptions,
  ): Promise<boolean> => {
    const commit = handleSaveProgress(cfi, pct, bookmarks, options);
    if (!activeBook || !settings.autoOpenLastBook || options?.suppressLastReaderSession) return commit;
    return commit.then((committed) => {
      if (committed) saveLastReaderSession(activeBook.id, pct);
      return committed;
    });
  }, [activeBook, handleSaveProgress, settings.autoOpenLastBook]);

  const handleDeleteBook = useCallback(async (book: Book) => {
    const shouldDeleteCloud = !isOfflineMode && Boolean(googleToken) && book.source !== 'local';
    const annotationOwner = ownerRuntime.capture();

    try {
      if (!annotationOwner) return;
      if (shouldDeleteCloud && (!hasValidToken() || !googleToken)) {
        handleCloudAuthExpired("클라우드 세션이 만료되어 도서를 삭제하지 못했습니다. 다시 클라우드를 연결한 뒤 삭제해 주세요.");
        return;
      }
      const deleted = await deleteBookInSafeOrder({
        isCurrent: () => ownerRuntime.isCurrent(annotationOwner),
        deleteDrive: shouldDeleteCloud && googleToken
          ? () => deleteDriveFile(book.id, googleToken)
          : undefined,
        resetProgress: () => handleDeleteBookProgress(book.id, annotationOwner),
        removeLocalContent: () => removeBookAndAnnotationsV8(
          annotationOwner.ownerKey,
          DEVICE_CONTENT_OWNER_KEY,
          book.id,
        ).then(() => undefined),
      });
      if (!deleted || !ownerRuntime.isCurrent(annotationOwner)) return;

      clearLastReaderSession(undefined, book.id);
      setActiveBook((current) => current?.id === book.id ? null : current);
      setBooks((prev) => prev.filter((item) => item.id !== book.id));
    } catch (error) {
      if (isGoogleDriveAuthError(error)) {
        handleCloudAuthExpired("클라우드 세션이 만료되어 도서를 삭제하지 못했습니다. 다시 클라우드를 연결한 뒤 삭제해 주세요.");
        return;
      }
      if (isGoogleDrivePermissionError(error)) {
        setCloudPermissionMessage("이 앱에서 삭제할 수 없는 Google Drive 파일입니다. Google Drive에서 직접 삭제하거나, 이 앱으로 업로드한 도서를 삭제해 주세요.");
        return;
      }

      const message = error instanceof Error ? error.message : '알 수 없는 오류';
      console.error('[DeleteBook] failed:', error);
      alert(`도서 삭제 실패: ${message}`);
    }
  }, [googleToken, handleCloudAuthExpired, handleDeleteBookProgress, hasValidToken, isOfflineMode, setBooks]);

  const handleOpenBook = useCallback((book: Book) => {
    const limitError = getBookOpenLimitError(book.name, book.mimeType, book.size);
    if (limitError) {
      alert(limitError);
      return;
    }
    if (settings.autoOpenLastBook) {
      saveLastReaderSession(book.id, progress[book.id]?.progressPercent);
    }
    setActiveBook(book);
    setView('reader');
  }, [progress, settings.autoOpenLastBook]);

  const handleReaderBack = useCallback(() => {
    if (activeBook) {
      clearLastReaderSession(undefined, activeBook.id);
    }
    setView('shelf');
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  }, [activeBook]);

  useEffect(() => {
    if (hasTriedAutoOpenLastBookRef.current) return;
    if (view !== 'shelf') return;
    if (!settings.autoOpenLastBook) {
      hasTriedAutoOpenLastBookRef.current = true;
      return;
    }
    if (books.length === 0) {
      clearLastReaderSession();
      hasTriedAutoOpenLastBookRef.current = true;
      return;
    }

    hasTriedAutoOpenLastBookRef.current = true;
    const lastBook = getLastReaderBookCandidate(books);
    if (!lastBook) return;

    const limitError = getBookOpenLimitError(lastBook.name, lastBook.mimeType, lastBook.size);
    if (limitError) {
      clearLastReaderSession(undefined, lastBook.id);
      return;
    }

    const openTimer = window.setTimeout(() => {
      setActiveBook(lastBook);
      setView('reader');
    }, 0);
    return () => window.clearTimeout(openTimer);
  }, [books, settings.autoOpenLastBook, view]);

  useEffect(() => {
    if (!activeBook) return;
    if (!isLastReaderProgressComplete(progress[activeBook.id]?.progressPercent)) return;
    clearLastReaderSession(undefined, activeBook.id);
  }, [activeBook, progress]);

  const dynamicStyles = {
    backgroundColor: themeColors.bg,
    color: themeColors.text,
    '--accent-400': accentColorObj[400],
    '--accent-500': accentColorObj[500],
    '--accent-600': accentColorObj[600],
    ...themeCssVariables,
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

      {/* 2. 모드 선택 화면 (제거됨 - 바로 책장으로 이동) */}

      {/* 3. 책장 */}
      {view === 'shelf' && (
        <Shelf
          books={books}
          progress={shelfProgress}
          googleToken={googleToken}
          driveCacheKey={driveCacheKey}
          onRefresh={() => !isOfflineMode && googleToken && loadLibraryFromDrive(googleToken)}
          onOpen={handleOpenBook}
          onLogout={handleLogout}
          onLogin={handleLoginTrigger}
          userEmail={user?.email || "Guest User"}
          isOfflineMode={isOfflineMode}
          isGuest={isGuest}
          onToggleCloud={isOfflineMode ? handleConnect : handleDisconnectDrive}
          onDeleteProgress={handleDeleteProgress}
          onDeleteBook={handleDeleteBook}
          settings={settings}
          onUpdateSettings={updateSettings}
          themeStyle={dynamicStyles}
          recentlyImportedBookIds={recentlyImportedBookIds}
          onBookImported={handleBookImported}
          isCloudTokenValid={hasValidToken}
          onCloudAuthExpired={handleCloudAuthExpired}
        />
      )}

      {/* 4. 리더 (epub 전용) */}
      {view === 'reader' && activeBook && activeOwnerKey && (
        <EpubReader
          key={`${activeOwnerKey}:${activeBook.id}`}
          book={activeBook}
          ownerKey={activeOwnerKey}
          googleToken={googleToken || ''}
          settings={settings}
          onUpdateSettings={updateSettings}
          onBack={handleReaderBack}
          onSaveProgress={handleReaderSaveProgress}
          onAdoptRemoteProgress={handleAdoptRemoteProgress}
          initialCfi={progress[activeBook.id]?.anchorCfi || progress[activeBook.id]?.cfi}
          initialPercent={progress[activeBook.id]?.progressPercent}
          initialTime={progress[activeBook.id]?.lastRead}
          initialBookmarks={progress[activeBook.id]?.bookmarks || []}
          initialRevision={progress[activeBook.id]?.syncRevision}
          remoteProgress={remoteProgress[activeBook.id]}
          resolvedRemoteProgress={syncConflictResolution.resolvedRemoteProgress?.bookId === activeBook.id
            ? syncConflictResolution.resolvedRemoteProgress
            : null}
          onRegisterProgressFlush={(flush) => {
            readerProgressFlushRef.current = flush;
          }}
          onRegisterQuietResumeEligibility={(check) => {
            readerQuietResumeEligibilityRef.current = check;
          }}
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

      {cloudAuthExpiredMessage && (
        <ConfirmDialog
          message="클라우드 세션이 만료되었습니다."
          subMessage={cloudAuthExpiredMessage}
          confirmLabel="확인"
          hideCancel
          variant="info"
          theme={theme}
          onConfirm={() => setCloudAuthExpiredMessage(null)}
          onCancel={() => setCloudAuthExpiredMessage(null)}
        />
      )}

      {cloudPermissionMessage && (
        <ConfirmDialog
          message="클라우드 도서 삭제 권한이 부족합니다."
          subMessage={cloudPermissionMessage}
          confirmLabel="확인"
          hideCancel
          variant="info"
          theme={theme}
          onConfirm={() => setCloudPermissionMessage(null)}
          onCancel={() => setCloudPermissionMessage(null)}
        />
      )}

      {authErrorMessage && (
        <ConfirmDialog
          message="Google 연결에 문제가 있습니다."
          subMessage={authErrorMessage}
          confirmLabel="확인"
          hideCancel
          variant="info"
          theme={theme}
          onConfirm={() => setAuthErrorMessage(null)}
          onCancel={() => setAuthErrorMessage(null)}
        />
      )}

      {progressPersistenceError && (
        <div className="fixed bottom-4 left-1/2 z-[110] flex w-[min(92vw,36rem)] -translate-x-1/2 items-center gap-3 rounded-2xl bg-rose-700 px-4 py-3 text-sm text-white shadow-2xl">
          <span className="flex-1">{progressPersistenceError}</span>
          <button
            type="button"
            className="shrink-0 rounded-xl bg-white px-3 py-2 font-bold text-rose-700"
            onClick={() => setProgressPersistenceError(null)}
          >
            확인
          </button>
        </div>
      )}

      {showInstallPrompt && (
        <AppInstallPrompt 
          theme={theme} 
          isIOS={isIOS} 
          onClose={handleCloseInstallPrompt} 
          onInstall={handleInstallApp} 
        />
      )}

      {localDBLifecycleEvent && (
        <ConfirmDialog
          message={localDBLifecycleEvent.type === 'blocked'
            ? '다른 탭이 로컬 서재 업데이트를 막고 있습니다.'
            : '로컬 서재 연결을 다시 열어야 합니다.'}
          subMessage={localDBLifecycleEvent.type === 'blocked'
            ? '다른 웹리더 탭을 닫은 뒤 이 탭을 다시 불러와 주세요.'
            : '안전하게 연결을 닫았습니다. 페이지를 다시 불러오면 복구를 계속합니다.'}
          confirmLabel="다시 불러오기"
          hideCancel
          variant="info"
          theme={theme}
          onConfirm={() => window.location.reload()}
          onCancel={() => setLocalDBLifecycleEvent(null)}
        />
      )}

      {syncConflictResolution.conflict && (
        <SyncConflictResolutionDialog
          conflict={syncConflictResolution.conflict}
          theme={theme}
          onKeepLocal={() => void syncConflictResolution.keepLocal()}
          onUseRemote={() => void syncConflictResolution.useRemote()}
          onDefer={syncConflictResolution.defer}
        />
      )}

      {serviceWorkerUpdate.updateAvailable && (
        <div className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-3 rounded-2xl bg-slate-900 px-4 py-3 text-sm text-white shadow-2xl">
          <span>새 버전을 사용할 수 있습니다.</span>
          <button
            type="button"
            className="rounded-xl bg-white px-3 py-2 font-bold text-slate-900"
            onClick={() => void serviceWorkerUpdate.applyUpdate()}
          >
            저장 후 적용
          </button>
        </div>
      )}

      {syncHealth !== 'healthy' && (
        <div className="fixed bottom-4 right-4 z-[95] max-w-sm rounded-2xl bg-amber-700 px-4 py-3 text-sm text-white shadow-2xl">
          {syncHealth === 'retrying-receive'
            ? '다른 기기의 읽기 기록을 다시 연결하고 있습니다. 이 기기에 저장된 변경은 보존됩니다.'
            : syncHealth === 'paused-auth'
              ? 'Firebase 인증이 만료되어 동기화가 멈췄습니다. 다시 로그인하면 자동으로 재개됩니다.'
              : syncHealth === 'blocked-permission'
                ? 'Firestore 권한 문제로 일부 도서의 동기화가 멈췄습니다.'
                : '동기화 데이터 형식 오류로 일부 도서의 송수신이 멈췄습니다.'}
        </div>
      )}
    </div>
  );
}
