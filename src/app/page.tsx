// src/app/page.tsx
'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { auth } from '../lib/firebase';
import { signOut, User as FirebaseUser } from 'firebase/auth';

import { Shelf } from '../components/shelf';
import { BookTitleDisplayProvider } from '../contexts/BookTitleDisplayContext';
import dynamic from 'next/dynamic';

const EpubReader = dynamic(() => import('../components/EpubReader'), { ssr: false });
import { Book, Bookmark, SaveProgressOptions, ViewState } from '../types';
import { ACCENT_PALETTE } from '../lib/constants';
import { getThemeAccentColor, getThemeClasses, getThemeColors, getThemeCssVariables } from '../lib/themeUtils';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  deleteDriveFile,
  invalidateDriveCache,
  isGoogleDriveAuthError,
  isGoogleDrivePermissionError,
} from '../lib/googleDrive';
import { beginGuestReadingHandoff, clearGuestReadingHandoff, removeBookAndAnnotationsV8, removeBookFromLocalV5 } from '../lib/localDBV5';
import { deleteBookInSafeOrder } from '../lib/bookDeletion';
import { captureAnnotationBookDeletionV5 } from '../lib/annotationBookDeletion';
import { getAuthoritativeRemoteAnnotationHeadV1 } from '../lib/annotationSyncRemote';
import { ANNOTATION_BOOK_DELETE_MARKER_ID } from '../lib/annotationPolicy';
import { subscribeLocalDBLifecycle, type LocalDBLifecycleEvent } from '../lib/localDB';
import { useAuthBootstrap } from '../hooks/useAuthBootstrap';
import { useOwnerSnapshot } from '../hooks/useOwnerSnapshot';
import { useDeviceId } from '../hooks/useDeviceId';
import { useDriveOAuthRedirect } from '../hooks/useDriveOAuthRedirect';
import { useGoogleDriveToken } from '../hooks/useGoogleDriveToken';
import { useLibraryData } from '../hooks/useLibraryData';
import { useNetworkLibrarySync } from '../hooks/useNetworkLibrarySync';
import { useProgressActions } from '../hooks/useProgressActions';
import { useProgressSync } from '../hooks/useProgressSync';
import { useProgressSyncWorker } from '../hooks/useProgressSyncWorker';
import { useViewerSettings } from '../hooks/useViewerSettings';
import { useMyPageNavigation } from '../hooks/useMyPageNavigation';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { AppInstallPrompt } from '../components/AppInstallPrompt';
import { SyncConflictResolutionDialog } from '../components/SyncConflictResolutionDialog';
import { getBookOpenLimitError } from '../lib/bookFormats';
import { clearReaderTtsCursor } from '../lib/readerTtsCursor';
import {
  clearLastReaderSession,
  getLastReaderBookCandidate,
  isLastReaderProgressComplete,
  readLastReaderSession,
  saveLastReaderSession,
} from '../lib/lastReaderSession';
import {
  DEVICE_CONTENT_OWNER_KEY,
  getOrCreateGuestInstallId,
  isGuestOwner,
  makeGuestOwnerKey,
  makeOwnerKey,
  getSyncOwnerKey,
  splitOwnerKey,
} from '../lib/ownerIdentity';
import { waitForCurrentLocalCommits } from '../lib/localCommitTracker';
import { ownerRuntime } from '../lib/ownerRuntime';
import { useSyncConflictResolution } from '../hooks/useSyncConflictResolution';
import { useAnnotationSyncConflictResolution } from '../hooks/useAnnotationSyncConflictResolution';
import { useServiceWorkerUpdate } from '../hooks/useServiceWorkerUpdate';
import { mergeLatestProgressForDisplay } from '../lib/progressDisplay';
import {
  clearPendingGoogleDriveOAuthStates,
  hasPendingGoogleDriveOAuth,
} from '../lib/googleDriveOAuth';
import { mergeSyncHealth, SYNC_RECEIVE_RETRY_EVENT, type SyncHealth } from '../lib/syncHealth';
import { getSyncSessionId } from '../lib/syncSession';
const MyPage = dynamic(() => import('../components/mypage/MyPage').then((module) => module.MyPage), { ssr: false });
import { LibraryReadingStatisticsModal } from '../components/LibraryReadingStatisticsModal';
import { useReadingStatisticsSync } from '../hooks/useReadingStatisticsSync';
import { shouldCancelRemoteProgressCommand } from '../hooks/reader/remoteProgressCommand';
import {
  shouldShowSyncConflictDialog,
  shouldShowSyncReviewBadge,
} from '../lib/syncConflictPresentation';
import { runLogoutFlow } from '../lib/logoutFlow';
import { LoginDisclosureModal, type LoginDisclosureMode } from '../components/LoginDisclosureModal';
import { LoginProgressDialog } from '../components/LoginProgressDialog';
import { useGoogleLogin } from '../hooks/useGoogleLogin';
import { getProgressCommitBaseline, rebaseProgressCommitBaseline } from '../lib/progressCommitBaseline';
import { applyManualBookmarkMutation, type ManualBookmarkMutation } from '../lib/bookmarkSyncPolicy';
import {
  preparePausedSyncRecovery, recoverPausedSyncTargetFromServer,
  type ExpiredSyncProgressUpdate, type PausedSyncRecoverySelection,
} from '../lib/expiredSyncRecovery';
import { resumePausedAuthEventsV5 } from '../lib/syncOutboxV5';
import type { UserProgress } from '../types';

const recoveryTargetLabels = {
  progress: '읽던 위치', bookmark: '책갈피', annotation: '주석', palette: '주석 색상',
} as const;

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
    getCurrentDriveSessionId,
    revokeToken,
  } = useGoogleDriveToken();
  const [activeBook, setActiveBook] = useState<Book | null>(null);
  const [syncReviewOpen, setSyncReviewOpen] = useState(false);
  const [readerReopen, setReaderReopen] = useState<{ ownerKey: string; bookId: string; version: string }>();
  const [readingStatisticsOpen, setReadingStatisticsOpen] = useState(false);
  const deviceId = useDeviceId();
  const hasTriedAutoOpenLastBookRef = useRef(false);

  const [isOfflineMode, setIsOfflineMode] = useState(true);
  const [isGuest, setIsGuest] = useState(getStoredGuestMode);
  // [Fix] Auth Effect에서 isGuest를 의존성으로 쓰면 Firebase 리스너가 재구독됨 → ref로 대체
  const isGuestRef = useRef(getStoredGuestMode());
  const logoutRunning = useRef(false);

  const [pendingAction, setPendingAction] = useState<'logout' | 'disconnect' | null>(null);
  const [cloudAuthExpiredMessage, setCloudAuthExpiredMessage] = useState<React.ReactNode | null>(null);
  const [cloudPermissionMessage, setCloudPermissionMessage] = useState<React.ReactNode | null>(null);
  const [authErrorMessage, setAuthErrorMessage] = useState<string | null>(null);
  const [loginDisclosureMode, setLoginDisclosureMode] = useState<LoginDisclosureMode | null>(null);
  const googleLogin = useGoogleLogin((error) => {
    console.error('[Auth] Google sign-in failed:', error);
    setAuthErrorMessage('Google 로그인을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  });
  const [progressPersistenceError, setProgressPersistenceError] = useState<string | null>(null);
  const [annotationSyncHealth, setAnnotationSyncHealth] = useState<SyncHealth>('healthy');
  const [syncRecovery, setSyncRecovery] = useState<{
    owner: NonNullable<ReturnType<typeof ownerRuntime.capture>>;
    targets: PausedSyncRecoverySelection[];
    selected?: PausedSyncRecoverySelection;
  } | null>(null);
  const [syncRecoveryBusy, setSyncRecoveryBusy] = useState(false);
  const [syncRecoveryFeedback, setSyncRecoveryFeedback] = useState<string | null>(null);
  const syncRecoveryRunning = useRef(false);
  const [localDBLifecycleEvent, setLocalDBLifecycleEvent] = useState<LocalDBLifecycleEvent | null>(null);
  const [recentlyImportedBookIds, setRecentlyImportedBookIds] = useState<string[]>([]);
  const readerProgressFlushRef = useRef<((reason?: 'owner-change') => Promise<boolean>) | null>(null);
  const flushOutgoingProgress = useCallback(() => {
    const flush = readerProgressFlushRef.current;
    if (!flush) return;
    return (async () => {
      await waitForCurrentLocalCommits();
      const saved = await flush('owner-change');
      if (saved) setProgressPersistenceError(null);
      return saved;
    })();
  }, []);
  const flushReaderProgress = useCallback(async () => readerProgressFlushRef.current?.() ?? true, []);
  const readerQuietResumeEligibilityRef = useRef<(() => boolean) | null>(null);
  const readerProgressConflictAutoResolveEligibilityRef = useRef<(() => boolean) | null>(null);
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('browser-regression')) return;
    const regressionWindow = window as Window & {
      __flushReaderProgressForRegression?: () => Promise<boolean>;
    };
    regressionWindow.__flushReaderProgressForRegression = flushReaderProgress;
    return () => {
      delete regressionWindow.__flushReaderProgressForRegression;
    };
  }, [flushReaderProgress]);
  const canQuietlyResolveProgressConflict = useCallback(
    () => readerQuietResumeEligibilityRef.current?.() ?? false,
    [],
  );
  const canAutoResolveSettledProgressConflict = useCallback(
    () => readerProgressConflictAutoResolveEligibilityRef.current?.() ?? false,
    [],
  );
  const isReturningFromFirebaseLogin = googleLogin.isReturning;
  const shouldWaitForAuthRedirect = useCallback(() => isReturningFromFirebaseLogin()
    || hasPendingGoogleDriveOAuth(sessionStorage, localStorage, window.location.hash), [isReturningFromFirebaseLogin]);
  useEffect(() => {
    if (shouldWaitForAuthRedirect()) hasTriedAutoOpenLastBookRef.current = true;
  }, [shouldWaitForAuthRedirect]);

  const { settings, updateSettings } = useViewerSettings();
  const { isInstallable, isIOS, promptInstall, isStandalone } = usePWAInstall();
  const serviceWorkerUpdate = useServiceWorkerUpdate({
    flushCurrentProgress: flushReaderProgress,
    onPersistenceError: setProgressPersistenceError,
  });
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const effectiveAccentColor = useMemo(
    () => getThemeAccentColor(settings),
    [settings],
  );
  const accentColorObj = useMemo(
    () => ACCENT_PALETTE[effectiveAccentColor] || ACCENT_PALETTE.rose,
    [effectiveAccentColor],
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
  const activeOwnerKey = useOwnerSnapshot()?.ownerKey ?? null;
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
    document.documentElement.dataset.viewerMenuStyle = settings.shelfDockStyle;
    document.documentElement.style.backgroundColor = color;
    document.body.style.backgroundColor = color;
    document.documentElement.removeAttribute('data-viewer-theme-bootstrapped');
    document.getElementById('viewer-theme-bootstrap-style')?.remove();
  }, [accentColorObj, settings.shelfDockStyle, themeColors.bg, themeCssVariables]);

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
    deviceId,
    clearToken,
    setIsOfflineMode,
    setView,
    onLibraryError: setAuthErrorMessage,
    driveSessionId,
    getCurrentDriveSessionId,
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

  const {
    isAuthenticatedLibraryReady,
    isLibraryBootstrapReady,
    libraryRestoreFailed,
    retryLibraryRestore,
    flushingOutgoingProgress,
    outgoingProgressFailed,
    retryOutgoingProgress,
  } = useAuthBootstrap({
    isGuestRef,
    setUser,
    setIsGuest,
    setIsOfflineMode,
    setView,
    restoreLocalData,
    resetLibraryState,
    shouldWaitForAuthRedirect,
    flushOutgoingProgress,
    onLibraryRestoreSettled: googleLogin.finish,
  });
  const syncUser = isAuthenticatedLibraryReady && !flushingOutgoingProgress ? user : null;
  const receiveSyncHealth = useProgressSync({
    user: syncUser,
    deviceId,
    progressRef,
    setProgress,
    setRemoteProgress,
    activeBookId: activeBook?.id,
    ownerKey: activeOwnerKey,
  });
  const { health: sendSyncHealth, recoveryAvailable: sendRecoveryAvailable } = useProgressSyncWorker(syncUser, activeOwnerKey, deviceId.current);
  const readingStatisticsSync = useReadingStatisticsSync(syncUser, activeOwnerKey);
  const syncHealth = mergeSyncHealth(
    receiveSyncHealth,
    sendSyncHealth,
    annotationSyncHealth,
  );
  const receiveRetryAvailable = [receiveSyncHealth, annotationSyncHealth].some(
    (health) => health === 'blocked-schema' || health === 'blocked-permission',
  );
  const prepareSyncRecovery = async () => {
    const owner = ownerRuntime.capture();
    if (!owner || !user || splitOwnerKey(owner.ownerKey).authOwnerKey !== `firebase:${user.uid}` || syncRecoveryRunning.current) return;
    syncRecoveryRunning.current = true;
    setSyncRecoveryBusy(true);
    setSyncRecoveryFeedback(null);
    try {
      if (!await flushReaderProgress()) {
        if (ownerRuntime.isCurrent(owner)) setSyncRecoveryFeedback('읽던 위치를 저장한 뒤 다시 시도해 주세요.');
        return;
      }
      const targets = await preparePausedSyncRecovery(getSyncOwnerKey(owner.ownerKey));
      if (!ownerRuntime.isCurrent(owner)) return;
      if (targets.length) setSyncRecovery({ owner, targets });
      else setSyncRecoveryFeedback('확인할 전송 중단 기록이 없습니다.');
    } catch {
      if (ownerRuntime.isCurrent(owner)) setSyncRecoveryFeedback('중단된 기록을 확인하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      syncRecoveryRunning.current = false;
      setSyncRecoveryBusy(false);
    }
  };
  const applySyncRecovery = async (selection: PausedSyncRecoverySelection, useServer: boolean) => {
    if (!syncRecovery || !user || syncRecoveryRunning.current) return;
    const { owner } = syncRecovery;
    if (!ownerRuntime.isCurrent(owner) || splitOwnerKey(owner.ownerKey).authOwnerKey !== `firebase:${user.uid}`) return;
    if (!navigator.onLine) {
      setSyncRecoveryFeedback('인터넷에 연결한 뒤 복구할 수 있습니다.');
      setSyncRecovery(null);
      return;
    }
    syncRecoveryRunning.current = true;
    setSyncRecoveryBusy(true);
    setSyncRecovery(null);
    const ownerKey = getSyncOwnerKey(owner.ownerKey);
    const isCurrent = () => ownerRuntime.isCurrent(owner);
    try {
      if (!useServer) {
        const resumed = await resumePausedAuthEventsV5(ownerKey, Date.now(), true, {
          eventId: selection.eventId, isCurrent,
        });
        if (isCurrent()) setSyncRecoveryFeedback(resumed
          ? '이 기기의 기록을 다시 전송합니다.' : '작업이 변경됐습니다. 목록을 다시 확인해 주세요.');
        return;
      }
      const result = await recoverPausedSyncTargetFromServer(user.uid, ownerKey, selection, { isCurrent });
      if (!isCurrent()) return;
      if (result.status !== 'resynced') {
        setSyncRecoveryFeedback('작업이 변경됐거나 서버 기록을 안전하게 적용할 수 없습니다.');
        return;
      }
      const { target } = selection;
      if (result.progress && (target?.kind === 'progress' || target?.kind === 'bookmark')) {
        const detail: ExpiredSyncProgressUpdate = { ownerKey, progress: result.progress,
          ...(target.kind === 'bookmark' ? { kind: 'bookmark', bookmarkId: target.bookmarkId } : { kind: 'progress' }) };
        window.dispatchEvent(new CustomEvent('web-reader-expired-sync-progress', { detail }));
      }
      setSyncRecoveryFeedback('서버 기록으로 복구했습니다.');
      window.dispatchEvent(new Event(SYNC_RECEIVE_RETRY_EVENT));
    } catch {
      if (isCurrent()) setSyncRecoveryFeedback('복구하지 못했습니다. 이 기기의 기록을 보존했습니다.');
    } finally {
      syncRecoveryRunning.current = false;
      setSyncRecoveryBusy(false);
    }
  };
  const syncConflictResolution = useSyncConflictResolution({
    user: syncUser,
    progressRef,
    setProgress,
    setRemoteProgress,
    ownerKey: activeOwnerKey,
    activeBookId: activeBook?.id,
    canQuietlyResolveProgressConflict,
    canAutoResolveSettledProgressConflict,
    flushReaderProgress,
  });
  const annotationSyncConflictResolution = useAnnotationSyncConflictResolution({
    user: syncUser,
    ownerKey: activeOwnerKey,
    activeBookId: activeBook?.id,
  });
  const conflictResolutions = [
    syncConflictResolution,
    annotationSyncConflictResolution,
  ];
  const activeSyncConflictResolution = conflictResolutions.find(({ conflict }) => {
    const target = conflict?.event?.target;
    return target && 'bookId' in target && target.bookId === activeBook?.id;
  }) ?? conflictResolutions.find(({ conflict }) => conflict) ?? syncConflictResolution;
  const activeSyncConflict = activeSyncConflictResolution.conflict;
  const conflictTarget = activeSyncConflict?.event?.target;
  const conflictBookId = conflictTarget && 'bookId' in conflictTarget
    ? conflictTarget.bookId
    : null;
  const syncConflictPresentation = {
    hasConflict: Boolean(activeSyncConflict)
      && !syncConflictResolution.resolvedRemoteProgressCommand,
    explicitReview: syncReviewOpen,
    view,
    conflictKind: conflictTarget?.kind ?? null,
    conflictBookId,
    activeBookId: activeBook?.id,
  };
  const stagedRemoteProgressCommand = syncConflictResolution.resolvedRemoteProgressCommand;
  const cancelStagedRemoteProgressCommand =
    syncConflictResolution.cancelResolvedRemoteProgressCommand;
  useEffect(() => {
    const command = stagedRemoteProgressCommand;
    if (!command) return;
    if (shouldCancelRemoteProgressCommand({
      view,
      activeBookId: activeBook?.id,
      commandBookId: command.progress.bookId,
    })) {
      cancelStagedRemoteProgressCommand(command.commandId);
    }
  }, [
    activeBook,
    cancelStagedRemoteProgressCommand,
    stagedRemoteProgressCommand,
    view,
  ]);
  const showSyncConflictDialog = shouldShowSyncConflictDialog(syncConflictPresentation);
  const showSyncReviewBadge = shouldShowSyncReviewBadge(syncConflictPresentation);
  const readerVersion = readerReopen?.ownerKey === activeOwnerKey && readerReopen.bookId === activeBook?.id
    ? readerReopen.version : '';
  const readerInteractionBlocked = showSyncConflictDialog
    || flushingOutgoingProgress
    || syncConflictResolution.resolving
    || (syncRecovery !== null && ownerRuntime.isCurrent(syncRecovery.owner))
    || syncRecoveryBusy
    || readingStatisticsOpen
    || pendingAction !== null
    || loginDisclosureMode !== null
    || cloudAuthExpiredMessage !== null
    || cloudPermissionMessage !== null
    || authErrorMessage !== null
    || progressPersistenceError !== null
    || localDBLifecycleEvent !== null
    || showInstallPrompt;
  const outboxProgressConflictRevision = syncConflictResolution.activeProgressConflictRevision;
  const driveRefreshPending = useNetworkLibrarySync({
    user,
    googleToken,
    driveSessionId,
    getCurrentDriveSessionId,
    isAuthenticatedLibraryReady,
    setIsOfflineMode,
    loadLibraryFromDrive,
  });
  const startDriveOAuth = useDriveOAuthRedirect({
    saveToken,
    setView,
    setAuthErrorMessage,
  });

  const handleLocalMode = async () => {
    setView('loading');
    await restoreLocalData({ replaceBooks: true }); // 로컬 모드 전환 시 클라우드 캐시 제거
    setIsOfflineMode(true);
    clearToken();
    setView('shelf');
  };

  const handleDisconnectDrive = () => setPendingAction('disconnect');

  useEffect(() => {
    const handleRecovered = (event: Event) => {
      const detail = (event as CustomEvent<ExpiredSyncProgressUpdate>).detail;
      const { ownerKey, progress: recovered } = detail;
      if (!activeOwnerKey || getSyncOwnerKey(activeOwnerKey) !== ownerKey) return;
      if (detail.kind === 'bookmark') {
        const bookId = recovered.bookId;
        const bookmark = recovered.bookmarks?.find(item => item.type === 'manual' && item.id === detail.bookmarkId);
        const mutation: ManualBookmarkMutation = bookmark
          ? { kind: 'upsert', bookmark }
          : { kind: 'delete', bookmarkId: detail.bookmarkId };
        const withBookmark = (progress: UserProgress | undefined) => progress
          ? { ...progress, bookmarks: applyManualBookmarkMutation(progress.bookmarks, mutation) }
          : recovered;
        const current = progressRef.current[bookId];
        const baseline = getProgressCommitBaseline(activeOwnerKey, bookId, current);
        rebaseProgressCommitBaseline(activeOwnerKey, bookId, withBookmark(baseline));
        progressRef.current = { ...progressRef.current, [bookId]: withBookmark(current) };
        setProgress(previous => ({ ...previous, [bookId]: withBookmark(previous[bookId]) }));
        return;
      }
      rebaseProgressCommitBaseline(activeOwnerKey, recovered.bookId, recovered);
      progressRef.current = { ...progressRef.current, [recovered.bookId]: recovered };
      setProgress(previous => ({ ...previous, [recovered.bookId]: recovered }));
      if (activeBook?.id === recovered.bookId) { setView('shelf'); setActiveBook(null); }
    };
    window.addEventListener('web-reader-expired-sync-progress', handleRecovered);
    return () => window.removeEventListener('web-reader-expired-sync-progress', handleRecovered);
  }, [activeBook, activeOwnerKey, progressRef, setProgress]);

  const resetExpiredDriveSession = useCallback(() => {
    if (driveCacheKey) invalidateDriveCache(driveCacheKey);
    clearToken();
    setIsOfflineMode(true);
    void restoreLocalData({ preventRedirect: true, replaceBooks: true });
  }, [clearToken, driveCacheKey, restoreLocalData]);

  const handleCloudAuthExpired = useCallback((message?: React.ReactNode) => {
    resetExpiredDriveSession();
    setCloudAuthExpiredMessage(message || "현재 도서는 기기에만 저장됩니다. 다시 클라우드를 연결하면 구글 드라이브 업로드를 사용할 수 있습니다.");
  }, [resetExpiredDriveSession]);

  useEffect(() => {
    if (!googleToken || (isOfflineMode && view !== 'mypage')) return;

    const validateCloudSession = () => {
      if (!hasValidToken()) {
        if (view === 'mypage' && window.location.hash.startsWith('#mypage/book/')) resetExpiredDriveSession();
        else handleCloudAuthExpired();
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
  }, [googleToken, handleCloudAuthExpired, hasValidToken, isOfflineMode, resetExpiredDriveSession, view]);

  const handleConnect = () => {
    if (isGuest || !user) {
      setLoginDisclosureMode('firebase');
      return;
    }

    setLoginDisclosureMode('drive');
  };

  const handleDriveConnectTrigger = () => {
    setLoginDisclosureMode(null);
    setAuthErrorMessage(null);

    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';
    if (!clientId) {
      setAuthErrorMessage('Google Drive 연결 설정을 찾지 못했습니다.');
      return;
    }

    startDriveOAuth(clientId);
  };

  const handleLoginTrigger = () => {
    setLoginDisclosureMode(null);
    setAuthErrorMessage(null);

    const usePopup = (process.env.NODE_ENV === 'development' || process.env.NEXT_PUBLIC_WEB_READER_PREVIEW === '1')
      && window.location.host !== auth.config.authDomain;
    googleLogin.start(usePopup ? 'popup' : 'redirect');
  };

  const handleLogout = () => setPendingAction('logout');

  const executePendingAction = async () => {
    const action = pendingAction;
    if (!action) return;
    setPendingAction(null);

    if (action === 'logout') {
      const logoutOwner = ownerRuntime.capture();
      if (!logoutOwner || isGuestOwner(logoutOwner.ownerKey) || logoutRunning.current) return;
      logoutRunning.current = true;
      try {
        const flushed = await flushReaderProgress();
        const commits = await waitForCurrentLocalCommits();
        if (!ownerRuntime.isCurrent(logoutOwner)) return;
        if (!flushed || !commits.ok) {
          setAuthErrorMessage('읽기 위치를 저장하지 못했습니다. 잠시 후 로그아웃을 다시 시도해 주세요.');
          return;
        }
        const guestOwner = makeOwnerKey(makeGuestOwnerKey(getOrCreateGuestInstallId(localStorage)), 'library:local');
        const handoff = await beginGuestReadingHandoff(getSyncOwnerKey(logoutOwner.ownerKey), guestOwner);
        if (!ownerRuntime.isCurrent(logoutOwner)) {
          await clearGuestReadingHandoff(handoff, true);
          return;
        }
        await runLogoutFlow({
          prepareUi: () => {
            // Mark the upcoming anonymous auth state as a guest transition before
            // Firebase emits it. Invalidate the authenticated owner first so every
            // Firestore listener and outbox worker observes a stale owner before
            // Firebase drops its credential and cannot pause work as permission-denied.
            setActiveBook(null);
            ownerRuntime.clear();
            isGuestRef.current = true;
          },
          signOut: () => signOut(auth),
          commitLocalCleanup: () => {
            if (driveCacheKey) invalidateDriveCache(driveCacheKey);
            clearToken();
            clearPendingGoogleDriveOAuthStates(sessionStorage, localStorage);
            clearLastReaderSession();
          },
          recoverUi: async (error) => {
            await clearGuestReadingHandoff(handoff, true).catch((failure) => {
              console.error('[Auth] Could not clear failed logout handoff:', failure);
            });
            if (auth.currentUser?.uid !== user?.uid || ownerRuntime.capture()) return;
            ownerRuntime.activate(logoutOwner.ownerKey);
            isGuestRef.current = false;
            localStorage.removeItem('isGuest');
            setIsGuest(false);
            console.error('[Auth] Sign out failed:', error);
            setAuthErrorMessage('로그아웃하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.');
            setView('shelf');
          },
        });
      } catch (error) {
        console.error('[Auth] Could not prepare logout:', error);
        setAuthErrorMessage('읽기 위치를 보존하지 못했습니다. 잠시 후 로그아웃을 다시 시도해 주세요.');
      } finally {
        logoutRunning.current = false;
      }
    } else if (action === 'disconnect') {
      await revokeToken();
      if (driveCacheKey) invalidateDriveCache(driveCacheKey);
      clearToken();
      clearPendingGoogleDriveOAuthStates(sessionStorage, localStorage);
      clearLastReaderSession();
      await handleLocalMode();
    }
  };

  const {
    saveProgress: handleSaveProgress,
    saveBookmarkMutation: handleSaveBookmarkMutation,
    deleteProgress: handleDeleteProgress,
    deleteBookProgress: handleDeleteBookProgress,
    adoptRemoteProgress: handleAdoptRemoteProgress,
    ignoreRemoteProgress: handleIgnoreRemoteProgress,
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
      const observedDeletion = user ? await captureAnnotationBookDeletionV5(
        annotationOwner.ownerKey,
        book.id,
        navigator.onLine
          ? () => getAuthoritativeRemoteAnnotationHeadV1(user.uid, book.id, ANNOTATION_BOOK_DELETE_MARKER_ID)
          : undefined,
      ) : undefined;
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
          user ? {
            deviceId: deviceId.current,
            sessionId: getSyncSessionId(),
          } : undefined,
          observedDeletion,
        ).then(() => {
          clearReaderTtsCursor(annotationOwner.ownerKey, book.id);
        }),
      });
      if (!deleted) return;
      if (!ownerRuntime.isCurrent(annotationOwner)) return;

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
  }, [deviceId, googleToken, handleCloudAuthExpired, handleDeleteBookProgress, hasValidToken, isOfflineMode, setBooks, user]);

  const handleDeleteLocalBookCopy = useCallback(async (book: Book) => {
    const owner = ownerRuntime.capture();
    if (!owner) return;
    await removeBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, book.id);
    if (!ownerRuntime.isCurrent(owner)) return;
  }, []);

  const handleOpenBook = useCallback((book: Book) => {
    const limitError = getBookOpenLimitError(book.name, book.mimeType, book.size);
    if (limitError) {
      alert(limitError);
      return false;
    }
    if (settings.autoOpenLastBook) {
      saveLastReaderSession(book.id, progress[book.id]?.progressPercent);
    }
    setActiveBook(book);
    setView('reader');
    return true;
  }, [progress, settings.autoOpenLastBook]);

  const handleReaderBack = useCallback(() => {
    const command = stagedRemoteProgressCommand;
    if (command) {
      cancelStagedRemoteProgressCommand(command.commandId);
    }
    if (activeBook) {
      clearLastReaderSession(undefined, activeBook.id);
    }
    setView('shelf');
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  }, [activeBook, cancelStagedRemoteProgressCommand, stagedRemoteProgressCommand]);

  const { openMyPage, closeMyPage } = useMyPageNavigation({
    view, setView, isLibraryBootstrapReady, autoOpenHandledRef: hasTriedAutoOpenLastBookRef,
  });

  useEffect(() => {
    if (window.location.hash.startsWith('#mypage')) return;
    if (hasTriedAutoOpenLastBookRef.current) {
      return;
    }
    if (view !== 'shelf') {
      document.documentElement.dataset.lastReaderAutoOpen = `waiting-view:${view}`;
      return;
    }
    if (!isLibraryBootstrapReady) {
      document.documentElement.dataset.lastReaderAutoOpen = 'waiting-bootstrap';
      return;
    }
    if (!settings.autoOpenLastBook) {
      document.documentElement.dataset.lastReaderAutoOpen = 'disabled';
      hasTriedAutoOpenLastBookRef.current = true;
      return;
    }
    if (driveRefreshPending) {
      const session = readLastReaderSession();
      if (session && !books.some((book) => book.id === session.bookId)) return;
    }
    if (books.length === 0) {
      document.documentElement.dataset.lastReaderAutoOpen = 'empty-library';
      clearLastReaderSession();
      hasTriedAutoOpenLastBookRef.current = true;
      return;
    }

    hasTriedAutoOpenLastBookRef.current = true;
    const lastBook = getLastReaderBookCandidate(books);
    if (!lastBook) {
      document.documentElement.dataset.lastReaderAutoOpen = 'no-candidate';
      return;
    }

    const limitError = getBookOpenLimitError(lastBook.name, lastBook.mimeType, lastBook.size);
    if (limitError) {
      document.documentElement.dataset.lastReaderAutoOpen = 'blocked-by-limit';
      clearLastReaderSession(undefined, lastBook.id);
      return;
    }

    document.documentElement.dataset.lastReaderAutoOpen = `opening:${lastBook.id}`;
    setActiveBook(lastBook);
    setView('reader');
  }, [books, driveRefreshPending, isLibraryBootstrapReady, settings.autoOpenLastBook, view]);

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

  const localDBDialog = localDBLifecycleEvent && (
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
  );

  const outgoingProgressDialog = !localDBDialog && outgoingProgressFailed && (
    <ConfirmDialog
      message="읽기 위치를 저장하지 못했습니다."
      subMessage="현재 위치를 저장한 뒤 계정을 전환합니다."
      confirmLabel="다시 시도"
      hideCancel
      variant="info"
      theme={theme}
      onConfirm={retryOutgoingProgress}
      onCancel={retryOutgoingProgress}
    />
  );
  const loginDialog = !localDBDialog && !outgoingProgressDialog && googleLogin.phase && (
    <LoginProgressDialog finishing={googleLogin.phase === 'finishing' || Boolean(user)} onCancel={googleLogin.cancel} style={dynamicStyles} />
  );

  if (view === 'loading' || !isLibraryBootstrapReady) {
    return (
      <div
        data-app-view={view}
        data-library-bootstrap-ready={isLibraryBootstrapReady ? 'true' : 'false'}
        className="viewer-theme-texture h-screen w-screen flex flex-col items-center justify-center gap-4 transition-colors duration-300"
        style={{
          backgroundColor: 'var(--viewer-theme-bg, #141517)',
          color: 'var(--viewer-theme-text, #d2d3d6)',
        }}
      >
        {libraryRestoreFailed ? (
          <>
            <p role="status" className="px-4 text-center text-sm">저장된 읽기 위치를 불러오지 못했습니다.</p>
            <button type="button" onClick={retryLibraryRestore}
              className="min-h-11 rounded-xl border border-current/20 px-4 text-sm hover:bg-current/5 focus-visible:outline-2 focus-visible:outline-accent-500">
              다시 시도
            </button>
          </>
        ) : (
          <>
            <div className="w-12 h-12 border-4 border-accent-500 border-t-transparent rounded-full animate-spin" />
            <p className="font-black uppercase tracking-widest text-xs opacity-30">Loading Library...</p>
          </>
        )}
        {localDBDialog}
        {outgoingProgressDialog}
        {loginDialog}
      </div>
    );
  }

  return (
    <BookTitleDisplayProvider summarize={settings.summarizeBookTitles !== false}>
    <div
      data-app-view={view}
      data-library-bootstrap-ready={isLibraryBootstrapReady ? 'true' : 'false'}
      className={`app-optical-radius min-h-screen font-sans ${theme.bg} ${theme.text} transition-colors duration-300`}
      style={dynamicStyles}
    >
      {/* 책장 */}
      {view === 'shelf' && activeOwnerKey && (
        <Shelf
          books={books}
          ownerKey={activeOwnerKey}
          progress={shelfProgress}
          googleToken={googleToken}
          driveCacheKey={driveCacheKey}
          onRefresh={() => !isOfflineMode && googleToken && loadLibraryFromDrive(googleToken)}
          onOpen={handleOpenBook}
          onLogout={handleLogout}
          onLogin={() => setLoginDisclosureMode('firebase')}
          userEmail={user?.email || "Guest User"}
          isOfflineMode={isOfflineMode}
          isGuest={isGuest}
          onToggleCloud={isOfflineMode ? handleConnect : handleDisconnectDrive}
          onDeleteProgress={handleDeleteProgress}
          onDeleteBook={handleDeleteBook}
          onDeleteLocalBookCopy={handleDeleteLocalBookCopy}
          settings={settings}
          onUpdateSettings={updateSettings}
          themeStyle={dynamicStyles}
          recentlyImportedBookIds={recentlyImportedBookIds}
          onBookImported={handleBookImported}
          isCloudTokenValid={hasValidToken}
          onCloudAuthExpired={handleCloudAuthExpired}
          onShowMyPage={openMyPage}
          onShowStatistics={() => setReadingStatisticsOpen(true)}
        />
      )}

      {/* Account changes clear progress before hydration. Mount only after it is restored. */}
      {view === 'reader' && activeBook && activeOwnerKey && isLibraryBootstrapReady && (
        <EpubReader
          key={`${activeOwnerKey}:${activeBook.id}:${readerVersion}`}
          book={activeBook}
          ownerKey={activeOwnerKey}
          annotationSyncDeviceId={user ? deviceId.current : undefined}
          readingStatsDeviceId={deviceId.current}
          onAnnotationSyncHealthChange={setAnnotationSyncHealth}
          googleToken={googleToken || ''}
          isOfflineMode={isOfflineMode}
          settings={settings}
          onUpdateSettings={updateSettings}
          onOpenStatistics={() => setReadingStatisticsOpen(true)}
          onBack={handleReaderBack}
          onSaveProgress={handleReaderSaveProgress}
          onSaveBookmarkMutation={handleSaveBookmarkMutation}
          onAdoptRemoteProgress={handleAdoptRemoteProgress}
          initialCfi={progress[activeBook.id]?.cfi || progress[activeBook.id]?.anchorCfi}
          initialAnchorCfi={progress[activeBook.id]?.anchorCfi}
          initialPercent={progress[activeBook.id]?.progressPercent}
          initialTime={progress[activeBook.id]?.lastRead}
          initialBookmarks={progress[activeBook.id]?.bookmarks || []}
          initialRevision={progress[activeBook.id]?.syncRevision}
          initialPositionToken={progress[activeBook.id]?.localPositionToken}
          remoteProgress={remoteProgress[activeBook.id]}
          resolvedRemoteProgressCommand={syncConflictResolution.resolvedRemoteProgressCommand
            ?.progress.bookId === activeBook.id
            ? syncConflictResolution.resolvedRemoteProgressCommand
            : null}
          onResolvedRemoteProgressConsumed={
            syncConflictResolution.consumeResolvedRemoteProgressCommand
          }
          onResolvedRemoteProgressFinalize={
            syncConflictResolution.finalizeResolvedRemoteProgressCommand
          }
          onResolvedRemoteProgressCancelled={
            syncConflictResolution.cancelResolvedRemoteProgressCommand
          }
          outboxProgressConflictRevision={outboxProgressConflictRevision}
          ignoredRemoteRevision={progress[activeBook.id]?.ignoredRemoteRevision}
          onIgnoreRemoteProgress={handleIgnoreRemoteProgress}
          onRegisterProgressFlush={(flush) => {
            readerProgressFlushRef.current = flush;
          }}
          onRegisterQuietResumeEligibility={(check) => {
            readerQuietResumeEligibilityRef.current = check;
          }}
          onRegisterProgressConflictAutoResolveEligibility={(check) => {
            readerProgressConflictAutoResolveEligibilityRef.current = check;
          }}
          interactionBlocked={readerInteractionBlocked}
        />
      )}

      {view === 'mypage' && activeOwnerKey && (
        <MyPage
          key={activeOwnerKey}
          ownerKey={activeOwnerKey}
          driveConnected={Boolean(googleToken && driveSessionId)}
          onConnect={handleConnect}
          sharedDrive={googleToken && driveSessionId && driveCacheKey?.endsWith(`::${driveSessionId}`)
            ? { token: googleToken, sessionId: driveSessionId, hasValidToken, refreshShelf: () => {
              invalidateDriveCache(driveCacheKey);
              void loadLibraryFromDrive(googleToken);
            } }
            : undefined}
          onSharedDriveReconnect={() => {
            if (googleToken) resetExpiredDriveSession();
            setLoginDisclosureMode('drive-reconnect');
          }}
          books={books}
          progress={shelfProgress}
          bookmarkProgress={progress}
          onOpenDeviceBook={handleOpenBook}
          theme={theme}
          themeVariables={themeCssVariables}
          accentColor={effectiveAccentColor}
          syncHealth={readingStatisticsSync.health}
          quarantinedDocumentCount={readingStatisticsSync.quarantinedCount}
          canRefresh={readingStatisticsSync.canRefresh}
          refreshing={readingStatisticsSync.refreshing}
          lastServerCheckedAt={readingStatisticsSync.lastServerCheckedAt}
          showRecommendedBooks={settings.showRecommendedBooks !== false}
          onShowRecommendedBooksChange={(showRecommendedBooks) => updateSettings({ showRecommendedBooks })}
          onRefresh={readingStatisticsSync.refresh}
          onBack={closeMyPage}
        />
      )}

      {readingStatisticsOpen && activeOwnerKey && (
        <LibraryReadingStatisticsModal
          key={activeOwnerKey}
          open={readingStatisticsOpen}
          visible={view === 'shelf' || view === 'reader'}
          ownerKey={activeOwnerKey}
          theme={theme}
          themeVariables={themeCssVariables}
          accentColor={effectiveAccentColor}
          syncHealth={readingStatisticsSync.health}
          quarantinedDocumentCount={readingStatisticsSync.quarantinedCount}
          canRefresh={readingStatisticsSync.canRefresh}
          refreshing={readingStatisticsSync.refreshing}
          lastServerCheckedAt={readingStatisticsSync.lastServerCheckedAt}
          onRefresh={readingStatisticsSync.refresh}
          onClose={() => setReadingStatisticsOpen(false)}
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

      {loginDisclosureMode && (
        <LoginDisclosureModal
          theme={theme}
          mode={loginDisclosureMode}
          themeBackgroundColor={themeColors.bg}
          onClose={() => setLoginDisclosureMode(null)}
          onConfirm={loginDisclosureMode === 'firebase' ? handleLoginTrigger : handleDriveConnectTrigger}
        />
      )}
      {loginDialog}

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

      {progressPersistenceError && !flushingOutgoingProgress && (
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

      {localDBDialog}
      {outgoingProgressDialog}

      {showSyncReviewBadge && (
        <button
          type="button"
          className="fixed bottom-4 right-4 z-[90] rounded-2xl bg-slate-900 px-4 py-3 text-sm font-bold text-white shadow-2xl"
          onClick={() => setSyncReviewOpen(true)}
        >
          {conflictTarget?.kind === 'progress' ? '이어 읽을 위치 선택' : '동기화 확인 필요'}
        </button>
      )}

      {showSyncConflictDialog && activeSyncConflict && (
        <SyncConflictResolutionDialog
          conflict={activeSyncConflict}
          theme={theme}
          resolving={activeSyncConflictResolution.resolving}
          error={activeSyncConflictResolution.resolutionError}
          bookTitle={conflictBookId
            ? books.find(({ id }) => id === conflictBookId)?.name
            : undefined}
          onKeepLocal={() => {
            void activeSyncConflictResolution.keepLocal().then((resolved) => {
              if (!resolved) return;
              if (view === 'reader' && conflictTarget?.kind === 'progress' && activeOwnerKey && activeBook?.id === conflictTarget.bookId) {
                setReaderReopen({ ownerKey: activeOwnerKey, bookId: activeBook.id, version: crypto.randomUUID() });
              }
              setSyncReviewOpen(false);
            });
          }}
          onUseRemote={() => {
            void activeSyncConflictResolution.useRemote().then((resolved) => {
              if (resolved) setSyncReviewOpen(false);
            });
          }}
          onDefer={() => {
            void activeSyncConflictResolution.defer().then((resolved) => {
              if (resolved) setSyncReviewOpen(false);
            });
          }}
        />
      )}

      {serviceWorkerUpdate.updateAvailable && (
        <div className="fixed bottom-4 left-1/2 z-[100] flex w-[calc(100%_-_2rem)] -translate-x-1/2 items-center gap-3 rounded-2xl bg-slate-900 px-4 py-3 text-sm text-white shadow-2xl sm:w-auto">
          <span className="min-w-0 flex-1 sm:flex-initial">새 버전을 사용할 수 있습니다.</span>
          <button
            type="button"
            className="shrink-0 whitespace-nowrap rounded-xl bg-white px-3 py-2 font-bold text-slate-900 disabled:cursor-wait disabled:opacity-60 sm:shrink sm:whitespace-normal"
            onClick={() => void serviceWorkerUpdate.applyUpdate()}
            disabled={serviceWorkerUpdate.isApplying}
            aria-busy={serviceWorkerUpdate.isApplying}
          >
            {serviceWorkerUpdate.isApplying ? '처리 중…' : <>
              <span className="sm:hidden">저장 후<br /> 적용</span>
              <span className="hidden sm:inline">저장 후 적용</span>
            </>}
          </button>
        </div>
      )}

      {syncRecovery && !syncRecovery.selected && ownerRuntime.isCurrent(syncRecovery.owner) && (
        <ConfirmDialog
          key="sync-recovery-targets"
          variant="info"
          message="동기화가 중단된 기록"
          subMessage={
            <span className="block max-h-[45dvh] space-y-3 overflow-y-auto text-left">
              {syncRecovery.targets.map((selection) => {
                const { target, targetKey, lastErrorCode, recovery } = selection;
                const title = target && 'bookId' in target
                  ? books.find(({ id }) => id === target.bookId)?.name ?? '서재에 없는 도서'
                  : null;
                const retryLocal = target && lastErrorCode === 'permission-denied';
                return (
                  <span key={targetKey} className="block space-y-1">
                    <span className="block break-words">
                      {title && `${title} · `}{target ? recoveryTargetLabels[target.kind] : '대상을 확인할 수 없는 기록'}
                    </span>
                    <span className="block font-normal">
                      {retryLocal ? '전송 권한 오류' : '전송 오류'}
                      {lastErrorCode && /^[a-zA-Z0-9_/-]{1,120}$/.test(lastErrorCode) && ` (${lastErrorCode})`}
                    </span>
                    <span className="flex flex-wrap gap-x-3 gap-y-1">
                      {recovery && (
                        <button type="button" className="min-h-8 underline"
                          onClick={() => setSyncRecovery({ ...syncRecovery, selected: selection })}>
                          서버 기록 적용
                        </button>
                      )}
                      {retryLocal && (
                        <button type="button" className="min-h-8 underline"
                          onClick={() => void applySyncRecovery(selection, false)}>
                          기기 기록 재전송
                        </button>
                      )}
                      {!recovery && !retryLocal && <span className="font-normal">이 기록은 여기서 복구할 수 없습니다.</span>}
                    </span>
                  </span>
                );
              })}
            </span>
          }
          confirmLabel="닫기"
          hideCancel
          dismissible
          theme={theme}
          onConfirm={() => setSyncRecovery(null)}
          onCancel={() => setSyncRecovery(null)}
        />
      )}
      {syncRecovery?.selected && ownerRuntime.isCurrent(syncRecovery.owner) && (
        <ConfirmDialog
          key="sync-recovery-confirm"
          message="서버 기록으로 복구할까요?"
          subMessage="선택한 기록의 이 기기 미전송 변경을 취소하고 서버 기록을 적용합니다."
          confirmLabel="복구"
          theme={theme}
          onConfirm={() => syncRecovery.selected && void applySyncRecovery(syncRecovery.selected, true)}
          onCancel={() => setSyncRecovery({ ...syncRecovery, selected: undefined })}
        />
      )}

      {(syncHealth !== 'healthy' || syncRecoveryFeedback || syncRecoveryBusy) && (
        <div className={`fixed bottom-4 right-4 z-[95] max-w-sm rounded-2xl px-4 py-3 text-sm text-white shadow-2xl ${syncHealth === 'healthy' ? 'bg-slate-700' : 'bg-amber-700'}`}>
          {syncRecoveryBusy ? '동기화 기록을 확인하는 중입니다.' : syncRecoveryFeedback ?? (syncHealth === 'retrying-receive'
            ? '다른 기기의 읽기 기록을 다시 연결하고 있습니다. 이 기기에 저장된 변경은 보존됩니다.'
            : syncHealth === 'recovering-expired'
              ? '전송 기한이 지난 기록을 확인하고 있습니다. 최신 클라우드 기록을 다시 불러옵니다.'
              : syncHealth === 'paused-auth'
                ? 'Firebase 인증이 만료되어 동기화가 멈췄습니다. 다시 로그인하면 자동으로 재개됩니다.'
                : syncHealth === 'blocked-permission'
                  ? 'Firestore 권한 문제로 일부 도서의 동기화가 멈췄습니다.'
                  : '동기화 데이터 형식 오류로 일부 도서의 송수신이 멈췄습니다.')}
          {!syncRecoveryBusy && (sendRecoveryAvailable || receiveRetryAvailable || syncRecoveryFeedback) && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              {sendRecoveryAvailable ? (
                <button type="button" className="font-semibold underline" onClick={() => void prepareSyncRecovery()}>
                  복구 옵션
                </button>
              ) : null}
              {receiveRetryAvailable && (
                <button type="button" className="font-semibold underline"
                  onClick={() => window.dispatchEvent(new Event(SYNC_RECEIVE_RETRY_EVENT))}>
                  다시 연결
                </button>
              )}
              {syncRecoveryFeedback && (
                <button type="button" className="font-semibold underline" onClick={() => setSyncRecoveryFeedback(null)}>
                  닫기
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
    </BookTitleDisplayProvider>
  );
}
