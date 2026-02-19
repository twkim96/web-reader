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
  const [isOfflineMode, setIsOfflineMode] = useState(true);
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

  const restoreLocalData = async () => {
    try {
      setIsOfflineMode(true);

      const [localBooks, localProgress] = await Promise.all([
        getAllOfflineBooks(),
        getAllLocalProgress()
      ]);
      
      const p: Record<string, UserProgress> = {};
      localProgress.forEach(item => { p[item.bookId] = item; });
      setProgress(p);

      if (localBooks.length > 0) {
        setBooks(localBooks);
        setView('shelf');
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

  const loadLibraryBackground = async (token: string) => {
    try {
      const targetFolderName = "web viewer";
      const fid = await findFolderId(targetFolderName, token);
      if (fid) {
        const data = await fetchDriveFiles(token, fid);
        if (data.files && data.files.length > 0) {
          setBooks(data.files);
        }
      }
      setIsOfflineMode(false);
      return true;
    } catch (err) { 
      console.log("Background library load skipped (Offline or Error)");
      setIsOfflineMode(true);
      return false;
    }
  };

  useEffect(() => {
    const handleOnline = async () => {
      console.log("Online detected.");
      if (user && googleToken) {
        loadLibraryBackground(googleToken).then((isSuccess) => {
            if(isSuccess) {
              setIsOfflineMode(false);
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
    restoreLocalData();

    const script = document.createElement('script');
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true; script.defer = true;
    document.body.appendChild(script);

    const unsubscribeAuth = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      
      if (u) {
        setIsGuest(false);
        
        const recoveredToken = getStoredToken();
        if (recoveredToken) {
          setGoogleToken(recoveredToken);
          
          // [Fix] 기존 책장에 있지 않다면 로딩 뷰를 띄움
          setView(prev => prev === 'shelf' ? 'shelf' : 'loading');
          
          loadLibraryBackground(recoveredToken).then((isSuccess) => {
            if (isSuccess) {
              syncLocalAndCloud(u.uid);
            }
            // [Fix] 로드가 끝나면 무조건 책장 뷰로 이동
            setView('shelf');
          });
        } else {
          setIsOfflineMode(true);
          // [Fix] 로그인은 되었지만 토큰이 없으면 드라이브 연결 모달(auth 뷰)로 유도
          setView('auth');
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
               if (prev === 'shelf') return prev;
               return 'auth';
             });
          }, 500);
        }
      }
    });
    return () => unsubscribeAuth();
  }, [isGuest]);


  const handleGuestMode = async () => {
    setView('loading');
    setIsGuest(true);
    setIsOfflineMode(true);
    setUser(null);
    setGoogleToken(null);
    await restoreLocalData(); 
    setView('shelf');
  };

  const handleLocalMode = async () => {
    setView('loading');
    await restoreLocalData();
    setIsOfflineMode(true);
    setGoogleToken(null);
    setView('shelf');
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
          // [Fix] 성공적으로 토큰을 받아오면 로딩 화면을 거쳐 책장으로 이동
          setView('loading');
          loadLibraryBackground(res.access_token).then(() => {
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

      {/* 2. 모드 선택 화면 */}
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
          onRefresh={() => !isOfflineMode && googleToken && loadLibraryBackground(googleToken)} 
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