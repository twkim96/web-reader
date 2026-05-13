// src/app/page.tsx
'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { auth, db, googleProvider, APP_ID } from '../lib/firebase';
import { onAuthStateChanged, signInWithPopup, signOut, User as FirebaseUser } from 'firebase/auth';
import { collection, doc, onSnapshot, setDoc, serverTimestamp, getDocs, deleteDoc } from 'firebase/firestore';

import { findFolderId, fetchDriveFiles } from '../lib/googleDrive';
import { getAllOfflineBooks, saveProgressToLocal, getAllLocalProgress, removeProgressFromLocal } from '../lib/localDB';
import { Shelf } from '../components/shelf';
import dynamic from 'next/dynamic';

const EpubReader = dynamic(() => import('../components/EpubReader'), { ssr: false });
import { Book, UserProgress, ViewerSettings, ViewState, Bookmark } from '../types';
import { THEMES, ACCENT_PALETTE } from '../lib/constants';
import { HardDrive, LogOut, ShieldCheck, Wifi, WifiOff, User as UserIcon } from 'lucide-react';
import { ConfirmDialog } from '../components/ConfirmDialog';

export default function Page() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [view, setView] = useState<ViewState>('loading');
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [activeBook, setActiveBook] = useState<Book | null>(null);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  const prevProgress = useRef<Record<string, UserProgress>>({});
  
  useEffect(() => {
    prevProgress.current = progress;
  }, [progress]);

  const [remoteProgress, setRemoteProgress] = useState<Record<string, UserProgress>>({});
  const deviceId = useRef<string>('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      let id = localStorage.getItem('reader_device_id');
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem('reader_device_id', id);
      }
      deviceId.current = id;
    }
  }, []);

  const [isPublicPC, setIsPublicPC] = useState(false);
  const [isOfflineMode, setIsOfflineMode] = useState(true);
  const [isGuest, setIsGuest] = useState(false);
  // [Fix] Auth Effect에서 isGuest를 의존성으로 쓰면 Firebase 리스너가 재구독됨 → ref로 대체
  const isGuestRef = useRef(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (localStorage.getItem('isGuest') === 'true') {
        setIsGuest(true);
        isGuestRef.current = true;
      }
    }
  }, []);

  const [pendingAction, setPendingAction] = useState<'logout' | 'disconnect' | null>(null);

  const [settings, setSettings] = useState<ViewerSettings>({
    fontSize: 18, lineHeight: 1.9, padding: 24, textAlign: 'justify',
    theme: 'sepia', navMode: 'scroll', fontFamily: 'ridi',
    accentColor: 'sky'
  });

  const theme = THEMES[settings.theme as keyof typeof THEMES] || THEMES.sepia;

  useEffect(() => {
    const savedSettings = localStorage.getItem('viewer_settings');
    if (savedSettings) {
      try {
        setSettings(prev => ({ ...prev, ...JSON.parse(savedSettings) }));
      } catch (e) {
        console.error("Failed to parse settings", e);
      }
    }
  }, []);

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
      const cloudRef = collection(db, 'artifacts', APP_ID, 'users', uid, 'readingHistory');
      const cloudSnapshot = await getDocs(cloudRef);

      // 서버 데이터를 로컬에 동기화 (서버 = 진실의 원천)
      for (const d of cloudSnapshot.docs) {
        const cloudData = d.data() as UserProgress;
        const cloudTime = cloudData.lastRead?.toDate ? cloudData.lastRead.toDate().getTime() : 0;
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
      console.warn("Drive Library Load Failed (Offline or Error)");
      setIsOfflineMode(true);
      return false;
    }
  };

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
          const isFromCache = snapshot.metadata.fromCache;
          const hasPending = snapshot.metadata.hasPendingWrites;
          const p: Record<string, UserProgress> = {};

          for (const d of snapshot.docs) {
            const raw = d.data() as any;
            const serverTime = raw.lastRead?.toDate ? raw.lastRead.toDate().getTime() : Date.now();
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
              cfi: raw.cfi || (raw.charIndex !== undefined ? String(raw.charIndex) : ''),
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
                const data = d.data() as UserProgress & { deviceId?: string };
                if (data.deviceId && data.deviceId !== deviceId.current) {
                  const serverTime = data.lastRead?.toDate ? data.lastRead.toDate().getTime() : Date.now();
                  const entry: UserProgress = { ...data, lastRead: serverTime };
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

  const handleUpdateSettings = useCallback((newSettings: Partial<ViewerSettings>) => {
    setSettings(prev => {
      const updated = { ...prev, ...newSettings };
      localStorage.setItem('viewer_settings', JSON.stringify(updated));
      return updated;
    });
  }, []);

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
  }, [user, activeBook]);

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
  }, [user]);

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
        <div className="h-screen w-screen flex flex-col items-center justify-center gap-12 p-10 text-center">
          <div className="p-10 bg-accent-600 text-white rounded-[3.5rem] shadow-2xl shadow-accent-500/20">
            <HardDrive size={64} />
          </div>
          <h1 className="text-4xl font-black italic uppercase tracking-tighter">TW-WEB Reader</h1>
          <div className="flex flex-col gap-4 w-full max-w-xs">
            <button onClick={() => signInWithPopup(auth, googleProvider).catch((e) => console.log('Popup cancelled or closed'))} className={`w-full py-5 ${theme.secondary} border ${theme.border} font-black rounded-[2rem] text-xs uppercase tracking-widest shadow-xl active:scale-95 hover:opacity-80 transition-all`}>
              Sign in with Google
            </button>
            <button onClick={handleGuestMode} className={`w-full py-5 ${theme.secondary} opacity-70 hover:opacity-100 border ${theme.border} font-bold rounded-[2rem] text-xs uppercase tracking-widest shadow-lg active:scale-95 flex items-center justify-center gap-2 transition-colors`}>
              <UserIcon size={16} />
              <span>Guest Mode (Offline)</span>
            </button>
          </div>
        </div>
      )}

      {/* 2. 모드 선택 화면 */}
      {view === 'auth' && user && (
        <div className="h-screen w-screen flex flex-col items-center justify-center gap-8 p-10 text-center">
          <div className="relative mb-4">
            <div className="p-10 bg-accent-600 text-white rounded-[3.5rem] shadow-2xl">
              <HardDrive size={64} />
            </div>
            <button onClick={handleLogout} className="absolute -top-2 -right-2 p-3 bg-red-500 rounded-full shadow-lg active:scale-90"><LogOut size={18} /></button>
          </div>
          <div className="space-y-1 mb-2">
            <p className="text-accent-400 font-black text-[10px] uppercase tracking-[0.3em]">Welcome back</p>
            <h1 className="text-xl font-bold">{user.displayName || user.email}</h1>
          </div>
          <div className="w-full max-w-xs space-y-4">
            <button onClick={handleConnect} className={`group relative w-full py-5 ${theme.secondary} border ${theme.border} font-black rounded-[2rem] text-xs uppercase tracking-widest shadow-xl active:scale-95 flex items-center justify-center gap-3 overflow-hidden hover:opacity-80 transition-all`}>
              <div className="absolute inset-0 bg-accent-500 opacity-0 group-hover:opacity-10 transition-opacity" />
              <Wifi size={18} className="text-accent-600 dark:text-accent-400" />
              <span>Connect Cloud</span>
            </button>
            <button onClick={handleLocalMode} className={`w-full py-5 ${theme.secondary} opacity-70 hover:opacity-100 border ${theme.border} font-bold rounded-[2rem] text-xs uppercase tracking-widest shadow-lg active:scale-95 flex items-center justify-center gap-3 transition-colors`}>
              <WifiOff size={18} />
              <span>Local Library Only</span>
            </button>
            <label className={`flex items-center justify-center gap-3 p-4 rounded-2xl border-2 transition-all cursor-pointer ${isPublicPC ? 'border-accent-500 bg-accent-500/10' : `border-transparent ${theme.secondary}`}`}>
              <input type="checkbox" checked={isPublicPC} onChange={(e) => setIsPublicPC(e.target.checked)} className="hidden" />
              <ShieldCheck size={20} className={isPublicPC ? 'text-accent-500' : 'opacity-40'} />
              <span className={`text-[11px] font-bold uppercase tracking-wider ${isPublicPC ? 'text-accent-500' : 'opacity-60'}`}>
                {isPublicPC ? 'Public PC (Session Only)' : 'Private PC (Keep Logged in)'}
              </span>
            </label>
          </div>
        </div>
      )}

      {/* 3. 책장 */}
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

      {/* 4. 리더 (epub 전용) */}
      {view === 'reader' && activeBook && (
        <EpubReader
          key={activeBook.id}
          book={activeBook}
          googleToken={googleToken || ''}
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
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
    </div>
  );
}