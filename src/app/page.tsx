// src/app/page.tsx
'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { auth, db, googleProvider, APP_ID } from '../lib/firebase';
import { onAuthStateChanged, signInWithPopup, signOut, User as FirebaseUser } from 'firebase/auth';
import { collection, doc, onSnapshot, setDoc, serverTimestamp, getDocs } from 'firebase/firestore';

import { findFolderId, fetchDriveFiles } from '../lib/googleDrive';
import { getAllOfflineBooks, saveProgressToLocal, getAllLocalProgress } from '../lib/localDB';
import { Shelf } from '../components/Shelf';
import { Reader } from '../components/Reader';
import { Book, UserProgress, ViewerSettings, ViewState, Bookmark } from '../types';
import { HardDrive, LogOut, ShieldCheck, Wifi, WifiOff, User as UserIcon } from 'lucide-react';

export default function Page() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [view, setView] = useState<ViewState>('loading');
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [activeBook, setActiveBook] = useState<Book | null>(null);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  
  const [isPublicPC, setIsPublicPC] = useState(false);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [isGuest, setIsGuest] = useState(false);

  const [settings, setSettings] = useState<ViewerSettings>({
    fontSize: 18, lineHeight: 1.9, padding: 24, textAlign: 'justify', 
    theme: 'sepia', navMode: 'scroll', fontFamily: 'sans', encoding: 'auto'
  });

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

  // [Modified] 로컬 데이터와 클라우드 데이터 동기화 로직
  // 오프라인 상태 체크 로직 추가
  const syncLocalAndCloud = async (uid: string) => {
    // 네트워크가 오프라인이면 Firebase 타임아웃을 기다리지 않고 즉시 종료
    if (!navigator.onLine) {
      console.log("Offline mode detected. Skipping background cloud sync.");
      return;
    }

    try {
      // 1. 로컬 데이터 가져오기
      const localProgressList = await getAllLocalProgress();
      
      // 2. 클라우드 데이터 가져오기
      const cloudRef = collection(db, 'artifacts', APP_ID, 'users', uid, 'readingHistory');
      const cloudSnapshot = await getDocs(cloudRef);
      
      const localMap = new Map(localProgressList.map(p => [p.bookId, p]));
      const cloudMap = new Map(cloudSnapshot.docs.map(d => [d.id, d.data() as UserProgress]));

      // 3. 로컬 -> 클라우드 동기화 (로컬이 더 최신이거나 클라우드에 없을 때)
      for (const [bookId, localData] of localMap.entries()) {
        const cloudData = cloudMap.get(bookId);
        
        const localTime = new Date(localData.lastRead).getTime();
        const cloudTime = cloudData?.lastRead?.toDate ? cloudData.lastRead.toDate().getTime() : 0;

        if (!cloudData || localTime > cloudTime) {
          console.log(`Syncing to Cloud: ${bookId}`);
          await setDoc(doc(cloudRef, bookId), {
            ...localData,
            lastRead: serverTimestamp()
          }, { merge: true });
        }
      }

      // 4. 클라우드 -> 로컬 동기화 (클라우드가 더 최신이거나 로컬에 없을 때)
      for (const [bookId, cloudData] of cloudMap.entries()) {
        const localData = localMap.get(bookId);
        
        const localTime = localData ? new Date(localData.lastRead).getTime() : 0;
        const cloudTime = cloudData.lastRead?.toDate ? cloudData.lastRead.toDate().getTime() : 0;

        if (!localData || cloudTime > localTime) {
          console.log(`Syncing to Local: ${bookId}`);
          await saveProgressToLocal({
            ...cloudData,
            lastRead: cloudTime 
          });
        }
      }
    } catch (e) {
      console.error("Sync failed:", e);
    }
  };

  // [New] 네트워크 상태 감지: 오프라인 -> 온라인 전환 시 동기화 및 라이브러리 갱신
  useEffect(() => {
    const handleOnline = async () => {
      console.log("Online connection detected. Resuming sync...");
      
      if (user) {
        // 1. 건너뛰었던 동기화 로직 재실행
        await syncLocalAndCloud(user.uid);
        
        // 2. 구글 토큰이 있다면 라이브러리 목록도 갱신
        if (googleToken) {
           loadLibrary(googleToken);
        }
      }
      
      // 오프라인 모드 해제
      setIsOfflineMode(false);
    };

    const handleOffline = () => {
      console.log("Offline mode detected.");
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
    const script = document.createElement('script');
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true; script.defer = true;
    document.body.appendChild(script);

    const unsubscribeAuth = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        setIsGuest(false);

        // [Modified] await 제거: 동기화를 백그라운드에서 실행하고 UI 차단 해제
        syncLocalAndCloud(u.uid).catch(err => console.error("Background sync error:", err));

        // Firebase 리스너 등록
        const historyRef = collection(db, 'artifacts', APP_ID, 'users', u.uid, 'readingHistory');
        const unsubProgress = onSnapshot(historyRef, async (snapshot) => {
          const p: Record<string, UserProgress> = {};
          
          for (const d of snapshot.docs) {
            const data = d.data() as UserProgress;
            p[d.id] = data;
            
            const serverTime = data.lastRead?.toDate ? data.lastRead.toDate().getTime() : Date.now();
            await saveProgressToLocal({ ...data, lastRead: serverTime });
          }
          
          // 로컬 데이터 병합
          const localP = await getAllLocalProgress();
          localP.forEach(lp => {
             if (!p[lp.bookId] || new Date(lp.lastRead).getTime() > (p[lp.bookId].lastRead?.toDate?.().getTime() || 0)) {
               p[lp.bookId] = lp;
             }
          });

          setProgress(p);
        });

        // 토큰 복구 및 라이브러리 로드
        const recoveredToken = getStoredToken();
        if (recoveredToken) {
          setGoogleToken(recoveredToken);
          // 시작 시점에 브라우저가 오프라인이면 오프라인 모드로 설정
          if (!navigator.onLine) {
            setIsOfflineMode(true);
            // 오프라인이면 로컬 책이라도 먼저 보여주기 위해 로컬 모드 로직 일부 차용 가능하나,
            // 현재 구조상 토큰이 있으면 loadLibrary를 시도함.
            // loadLibrary 내부 에러 처리로 넘어감.
          } else {
            setIsOfflineMode(false);
          }
          loadLibrary(recoveredToken);
        } else {
          setView('auth');
        }

        return () => { unsubProgress(); };
      } else {
        if (!isGuest) {
          setView('auth');
        }
      }
    });
    return () => unsubscribeAuth();
  }, [isGuest]);

  const loadLibrary = async (token: string) => {
    setView('loading');
    try {
      // 오프라인이면 API 호출 실패할 것이므로 즉시 catch로 이동하거나
      // 여기서 미리 체크해서 로컬 책만 보여줄 수도 있음.
      // 현재는 fetch 실패 시 catch 블록에서 기존 책 목록 유지/빈 목록 보여줌.
      const targetFolderName = "web viewer";
      const fid = await findFolderId(targetFolderName, token);
      if (fid) {
        const data = await fetchDriveFiles(token, fid);
        setBooks(data.files || []);
      }
      setView('shelf');
    } catch (err) { 
      console.error("Library load failed (likely offline):", err);
      // 로드 실패 시(오프라인 등) 로컬에 있는 책이라도 보여주기 위해 시도
      try {
        const localBooks = await getAllOfflineBooks();
        if (localBooks.length > 0) {
          setBooks(localBooks);
          setIsOfflineMode(true);
        }
      } catch (e) {
        console.error("Local fallback failed", e);
      }
      setView('shelf'); 
    }
  };

  const handleGuestMode = async () => {
    setView('loading');
    setIsGuest(true);
    setIsOfflineMode(true);
    setUser(null);
    setGoogleToken(null);

    try {
      const localBooks = await getAllOfflineBooks();
      setBooks(localBooks);

      const localProgress = await getAllLocalProgress();
      const p: Record<string, UserProgress> = {};
      localProgress.forEach(item => {
        p[item.bookId] = item;
      });
      setProgress(p);

      setView('shelf');
    } catch (e) {
      console.error("Guest mode init failed", e);
      setView('auth');
    }
  };

  const handleLocalMode = async () => {
    setView('loading');
    try {
      const localBooks = await getAllOfflineBooks();
      setBooks(localBooks);
      setIsOfflineMode(true);
      setGoogleToken(null);
      setView('shelf');
    } catch (e) {
      console.error("Failed to load local books", e);
      setView('auth');
    }
  };

  const handleDisconnectDrive = async () => {
    if (confirm("클라우드 연결을 해제하고 로컬 모드로 전환하시겠습니까?")) {
      setGoogleToken(null);
      localStorage.removeItem('google_drive_token');
      localStorage.removeItem('google_drive_token_expiry');
      sessionStorage.removeItem('google_drive_token');
      sessionStorage.removeItem('google_drive_token_expiry');
      await handleLocalMode(); 
    }
  };

  const handleConnect = () => {
    if (!(window as any).google) return;
    const client = (window as any).google.accounts.oauth2.initTokenClient({
      client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
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
          loadLibrary(res.access_token); 
        } 
      },
    });
    client.requestAccessToken({ prompt: googleToken ? '' : 'select_account' });
  };

  const handleLoginTrigger = () => {
    signInWithPopup(auth, googleProvider).catch(console.error);
  };

  const handleLogout = async () => {
    if (confirm("로그아웃 하시겠습니까?")) {
      await signOut(auth);
      localStorage.removeItem('google_drive_token');
      sessionStorage.removeItem('google_drive_token');
      setGoogleToken(null);
      setBooks([]);
      setIsGuest(false);
      setView('auth');
    }
  };

  const handleUpdateSettings = useCallback((newSettings: Partial<ViewerSettings>) => {
    setSettings(prev => {
      const updated = { ...prev, ...newSettings };
      localStorage.setItem('viewer_settings', JSON.stringify(updated));
      return updated;
    });
  }, []);

  const handleSaveProgress = useCallback(async (idx: number, pct: number, bookmarks?: Bookmark[]) => {
    if (!activeBook || isNaN(idx)) return;

    const now = Date.now();
    const progressData: UserProgress = {
      bookId: activeBook.id,
      charIndex: idx,
      progressPercent: pct,
      lastRead: now,
      bookmarks: bookmarks
    };

    // 1. [Local First] 로컬 DB 저장 및 UI 업데이트
    try {
      await saveProgressToLocal(progressData);
      setProgress(prev => ({
        ...prev,
        [activeBook.id]: progressData
      }));
    } catch (e) {
      console.error("Local save failed", e);
    }

    // 2. [Cloud Sync] 온라인 상태라면 Firebase에도 저장
    // 오프라인이어도 Firestore SDK가 큐에 넣었다가 나중에 보냄 (단, 초기 로딩 지연과는 무관)
    if (user) {
      try {
        const docRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'readingHistory', activeBook.id);
        await setDoc(docRef, { 
          ...progressData, 
          lastRead: serverTimestamp() 
        }, { merge: true });
      } catch (e) {
        console.warn("Cloud sync paused (offline):", e);
      }
    }

  }, [user, activeBook]);

  if (view === 'loading') {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#0f172a] text-white gap-4">
        <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        <p className="font-black uppercase tracking-widest text-xs opacity-30">Loading Library...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen font-sans bg-[#0f172a]">
      {/* 1. 로그인 화면 */}
      {view === 'auth' && !user && (
        <div className="h-screen w-screen flex flex-col items-center justify-center text-white gap-12 p-10 text-center">
          <div className="p-10 bg-indigo-600 rounded-[3.5rem] shadow-2xl shadow-indigo-500/20">
            <HardDrive size={64} />
          </div>
          <h1 className="text-4xl font-black italic uppercase tracking-tighter">TW-WEB Reader</h1>
          
          <div className="flex flex-col gap-4 w-full max-w-xs">
            <button onClick={() => signInWithPopup(auth, googleProvider)} className="w-full py-5 bg-white text-slate-900 font-black rounded-[2rem] text-xs uppercase tracking-widest shadow-xl active:scale-95">
              Sign in with Google
            </button>
            
            <button onClick={handleGuestMode} className="w-full py-5 bg-slate-800 border border-white/10 text-slate-300 font-bold rounded-[2rem] text-xs uppercase tracking-widest shadow-lg active:scale-95 flex items-center justify-center gap-2 hover:bg-slate-700 transition-colors">
              <UserIcon size={16} />
              <span>Guest Mode (Offline)</span>
            </button>
          </div>
        </div>
      )}

      {/* 2. 모드 선택 화면 (클라우드 vs 로컬) */}
      {view === 'auth' && user && (
        <div className="h-screen w-screen flex flex-col items-center justify-center text-white gap-8 p-10 text-center">
          <div className="relative mb-4">
            <div className="p-10 bg-indigo-600 rounded-[3.5rem] shadow-2xl">
              <HardDrive size={64} />
            </div>
            <button onClick={handleLogout} className="absolute -top-2 -right-2 p-3 bg-red-500 rounded-full shadow-lg active:scale-90"><LogOut size={18} /></button>
          </div>
          
          <div className="space-y-1 mb-2">
            <p className="text-indigo-400 font-black text-[10px] uppercase tracking-[0.3em]">Welcome back</p>
            <h1 className="text-xl font-bold">{user.displayName || user.email}</h1>
          </div>

          <div className="w-full max-w-xs space-y-4">
            <button onClick={handleConnect} className="group relative w-full py-5 bg-white text-slate-900 font-black rounded-[2rem] text-xs uppercase tracking-widest shadow-xl active:scale-95 flex items-center justify-center gap-3 overflow-hidden">
               <div className="absolute inset-0 bg-indigo-500 opacity-0 group-hover:opacity-10 transition-opacity" />
               <Wifi size={18} className="text-indigo-600" />
               <span>Connect Cloud</span>
            </button>

            <button onClick={handleLocalMode} className="w-full py-5 bg-slate-800 border border-white/10 text-slate-300 font-bold rounded-[2rem] text-xs uppercase tracking-widest shadow-lg active:scale-95 flex items-center justify-center gap-3 hover:bg-slate-700 transition-colors">
              <WifiOff size={18} />
              <span>Local Library Only</span>
            </button>
            
            <label className={`flex items-center justify-center gap-3 p-4 rounded-2xl border-2 transition-all cursor-pointer ${isPublicPC ? 'border-indigo-500 bg-indigo-500/10' : 'border-white/5 bg-transparent'}`}>
              <input type="checkbox" checked={isPublicPC} onChange={(e) => setIsPublicPC(e.target.checked)} className="hidden" />
              <ShieldCheck size={20} className={isPublicPC ? 'text-indigo-400' : 'text-slate-500'} />
              <span className={`text-[11px] font-bold uppercase tracking-wider ${isPublicPC ? 'text-white' : 'text-slate-400'}`}>
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
          isRefreshing={false} 
          onRefresh={() => !isOfflineMode && googleToken && loadLibrary(googleToken)} 
          onOpen={(b) => { setActiveBook(b); setView('reader'); }} 
          onLogout={handleLogout} 
          onLogin={handleLoginTrigger}
          userEmail={user?.email || "Guest User"} 
          isOfflineMode={isOfflineMode} 
          isGuest={isGuest}
          onToggleCloud={isOfflineMode ? handleConnect : handleDisconnectDrive} 
        />
      )}
      
      {/* 4. 리더 */}
      {view === 'reader' && activeBook && (
        <Reader 
          book={activeBook} 
          googleToken={googleToken || ''} 
          initialProgress={progress[activeBook.id]} 
          settings={settings} 
          onUpdateSettings={handleUpdateSettings} 
          onBack={() => { window.scrollTo(0, 0); setView('shelf'); }} 
          onSaveProgress={handleSaveProgress} 
        />
      )}
    </div>
  );
}