// src/app/page.tsx
'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { auth, db, googleProvider, APP_ID } from '../lib/firebase';
import { onAuthStateChanged, signInWithPopup, signOut, User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot } from 'firebase/firestore';
import { saveProgressToLocal, getAllLocalProgress } from '../lib/localDB';

import { useViewerSettings } from '../hooks/useViewerSettings';
import { useLibrary } from '../hooks/useLibrary';

import { Shelf } from '../components/Shelf';
import { Reader } from '../components/Reader';
import { AuthView } from '../components/AuthView';
import { LoadingView } from '../components/LoadingView';
import { ConfirmDialog } from '../components/ConfirmDialog';

import { Book, UserProgress, ViewState } from '../types';

export default function Page() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [view, setView] = useState<ViewState>('loading');
  const [activeBook, setActiveBook] = useState<Book | null>(null);
  const [isPublicPC, setIsPublicPC] = useState(false);
  const [isGuest, setIsGuest] = useState(false);
  const [pendingAction, setPendingAction] = useState<'logout' | 'disconnect' | null>(null);

  const { settings, handleUpdateSettings, theme, dynamicStyles } = useViewerSettings();

  const {
    books, progress, setProgress, googleToken, isOfflineMode,
    setGoogleToken, setIsOfflineMode, setBooks,
    getStoredToken, restoreLocalData, syncLocalAndCloud,
    loadLibraryFromDrive, handleSaveProgress, handleDeleteProgress,
  } = useLibrary({ user, setView });

  // --- Online/Offline 감지 ---
  useEffect(() => {
    const handleOnline = async () => {
      console.log("Online detected.");
      if (user && googleToken) {
        loadLibraryFromDrive(googleToken).then((isSuccess) => {
          if (isSuccess) {
            syncLocalAndCloud(user.uid);
          }
        });
      }
    };
    const handleOffline = () => {
      console.log("Offline detected.");
      setIsOfflineMode(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [user, googleToken]);

  // --- Firebase Auth + 초기 로드 ---
  useEffect(() => {
    restoreLocalData(); // 초기 로드 시 실행 (기본 동작: 책장으로 이동)

    const script = document.createElement('script');
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true; script.defer = true;
    document.body.appendChild(script);

    const unsubscribeAuth = onAuthStateChanged(auth, async (u) => {
      setUser(u);

      if (u) {
        setIsGuest(false);

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
          const p: Record<string, UserProgress> = {};
          for (const d of snapshot.docs) {
            const data = d.data() as UserProgress;
            p[d.id] = data;
            const serverTime = data.lastRead?.toDate ? data.lastRead.toDate().getTime() : Date.now();
            await saveProgressToLocal({ ...data, lastRead: serverTime });
          }
          const localP = await getAllLocalProgress();
          localP.forEach(lp => {
            if (!p[lp.bookId] || new Date(lp.lastRead).getTime() > (p[lp.bookId].lastRead?.toDate?.().getTime() || 0)) {
              p[lp.bookId] = lp;
            }
          });
          setProgress(p);
        });

        return () => { unsubProgress(); };

      } else {
        if (!isGuest) {
          setTimeout(() => {
            setView(prev => {
              // 읽고 있거나 책장에 있다면 유지 (단, 로그아웃 명시적 처리는 handleLogout에서 함)
              // 여기서는 세션 만료 등의 자동 처리를 위함이나, 안전하게 shelf면 유지
              if (prev === 'shelf') return prev;
              return 'auth';
            });
          }, 500);
        }
      }
    });
    return () => unsubscribeAuth();
  }, [isGuest]);

  // --- 핸들러: 게스트 모드 ---
  const handleGuestMode = async () => {
    setView('loading');
    setIsGuest(true);
    setIsOfflineMode(true);
    setUser(null);
    setGoogleToken(null);
    await restoreLocalData(); // 게스트 모드는 강제 책장 이동 OK
    setView('shelf');
  };

  // --- 핸들러: 로컬 모드 ---
  const handleLocalMode = async () => {
    setView('loading');
    await restoreLocalData(); // 로컬 모드 전환 시 강제 책장 이동 OK
    setIsOfflineMode(true);
    setGoogleToken(null);
    setView('shelf');
  };

  // --- 핸들러: 클라우드 연결/해제 ---
  const handleDisconnectDrive = () => setPendingAction('disconnect');

  const handleConnect = () => {
    if (!(window as any).google) return;
    const client = (window as any).google.accounts.oauth2.initTokenClient({
      client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (res: any) => {
        if (res.access_token) {
          setGoogleToken(res.access_token);
          const expiryTime = (Date.now() + (res.expires_in * 1000)).toString();
          const storage = isPublicPC ? sessionStorage : localStorage;
          localStorage.removeItem('google_drive_token');
          sessionStorage.removeItem('google_drive_token');
          storage.setItem('google_drive_token', res.access_token);
          storage.setItem('google_drive_token_expiry', expiryTime);

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

  // --- 핸들러: 로그인/로그아웃 ---
  const handleLoginTrigger = () => {
    signInWithPopup(auth, googleProvider).catch(console.error);
  };

  const handleLogout = () => setPendingAction('logout');

  const executePendingAction = async () => {
    if (pendingAction === 'logout') {
      await signOut(auth);
      localStorage.removeItem('google_drive_token');
      sessionStorage.removeItem('google_drive_token');
      setGoogleToken(null);
      setBooks([]);
      setIsGuest(false);
      setView('auth');
    } else if (pendingAction === 'disconnect') {
      setGoogleToken(null);
      localStorage.removeItem('google_drive_token');
      localStorage.removeItem('google_drive_token_expiry');
      sessionStorage.removeItem('google_drive_token');
      sessionStorage.removeItem('google_drive_token_expiry');
      await handleLocalMode();
    }
    setPendingAction(null);
  };

  // --- 렌더링 ---
  if (view === 'loading') {
    return <LoadingView theme={theme} dynamicStyles={dynamicStyles} />;
  }

  return (
    <div className={`min-h-screen font-sans ${theme.bg} ${theme.text} transition-colors duration-300`} style={dynamicStyles}>
      {/* 1. 로그인/모드 선택 화면 */}
      {view === 'auth' && (
        <AuthView
          user={user}
          theme={theme}
          isPublicPC={isPublicPC}
          setIsPublicPC={setIsPublicPC}
          onSignIn={() => signInWithPopup(auth, googleProvider).catch((e) => console.log('Popup cancelled or closed'))}
          onGuestMode={handleGuestMode}
          onConnect={handleConnect}
          onLocalMode={handleLocalMode}
          onLogout={handleLogout}
        />
      )}

      {/* 2. 책장 */}
      {view === 'shelf' && (
        <Shelf
          books={books}
          progress={progress}
          googleToken={googleToken}
          isRefreshing={false}
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
          onUpdateSettings={handleUpdateSettings}
          onLocalBookImported={() => restoreLocalData(true)}
        />
      )}

      {/* 3. 리더 */}
      {view === 'reader' && activeBook && (
        <Reader
          book={activeBook}
          googleToken={googleToken || ''}
          initialProgress={progress[activeBook.id]}
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
          onBack={() => { setView('shelf'); requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' })); }}
          onSaveProgress={(idx, pct, bookmarks) => handleSaveProgress(idx, pct, bookmarks, activeBook)}
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
    </div>
  );
}