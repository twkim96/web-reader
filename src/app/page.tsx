// src/app/page.tsx
'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { auth, db, googleProvider, APP_ID } from '../lib/firebase';
import { onAuthStateChanged, signInWithPopup, signOut, User as FirebaseUser } from 'firebase/auth';
import { collection, doc, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore';

import { findFolderId, fetchDriveFiles } from '../lib/googleDrive';
import { getAllOfflineBooks } from '../lib/localDB'; // [New] 로컬 책 목록 불러오기
import { Shelf } from '../components/Shelf';
import { Reader } from '../components/Reader';
import { Book, UserProgress, ViewerSettings, ViewState, Bookmark } from '../types';
import { HardDrive, LogOut, ShieldCheck, Wifi, WifiOff } from 'lucide-react';

export default function Page() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [view, setView] = useState<ViewState>('loading');
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [activeBook, setActiveBook] = useState<Book | null>(null);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  
  const [isPublicPC, setIsPublicPC] = useState(false);
  const [isOfflineMode, setIsOfflineMode] = useState(false); // [New] 로컬 모드 상태

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

  useEffect(() => {
    const script = document.createElement('script');
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true; script.defer = true;
    document.body.appendChild(script);

    const unsubscribeAuth = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        // Firebase 독서 기록 동기화는 모드 상관없이 항상 수행
        const historyRef = collection(db, 'artifacts', APP_ID, 'users', u.uid, 'readingHistory');
        const unsubProgress = onSnapshot(historyRef, (snapshot) => {
          const p: Record<string, UserProgress> = {};
          snapshot.forEach(d => p[d.id] = d.data() as UserProgress);
          setProgress(p);
        });

        // 저장된 유효 토큰이 있으면 자동으로 '클라우드 모드' 진입
        const recoveredToken = getStoredToken();
        if (recoveredToken) {
          setGoogleToken(recoveredToken);
          setIsOfflineMode(false);
          loadLibrary(recoveredToken);
        } else {
          // 토큰이 없으면 모드 선택 화면(auth) 유지
          setView('auth');
        }

        return () => { unsubProgress(); };
      } else {
        setView('auth');
      }
    });
    return () => unsubscribeAuth();
  }, []);

  const loadLibrary = async (token: string) => {
    setView('loading');
    try {
      const targetFolderName = "web viewer";
      const fid = await findFolderId(targetFolderName, token);
      if (fid) {
        const data = await fetchDriveFiles(token, fid);
        setBooks(data.files || []);
      }
      setView('shelf');
    } catch (err) { setView('shelf'); }
  };

  // [New] 로컬 모드 진입 핸들러
  const handleLocalMode = async () => {
    setView('loading');
    try {
      const localBooks = await getAllOfflineBooks();
      setBooks(localBooks);
      setIsOfflineMode(true);
      setGoogleToken(null); // 토큰 클리어
      setView('shelf');
    } catch (e) {
      console.error("Failed to load local books", e);
      setView('auth');
    }
  };

  // [New] 구글 드라이브 연결만 끊기 (Firebase는 유지)
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
          localStorage.removeItem('google_drive_token_expiry');
          sessionStorage.removeItem('google_drive_token');
          sessionStorage.removeItem('google_drive_token_expiry');

          storage.setItem('google_drive_token', res.access_token);
          storage.setItem('google_drive_token_expiry', expiryTime);
          
          setIsOfflineMode(false); // 클라우드 모드 설정
          loadLibrary(res.access_token); 
        } 
      },
    });
    client.requestAccessToken({ prompt: googleToken ? '' : 'select_account' });
  };

  const handleLogout = async () => {
    if (confirm("로그아웃 하시겠습니까?")) {
      await signOut(auth);
      localStorage.removeItem('google_drive_token');
      localStorage.removeItem('google_drive_token_expiry');
      sessionStorage.removeItem('google_drive_token');
      sessionStorage.removeItem('google_drive_token_expiry');
      setGoogleToken(null);
      setBooks([]);
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
    if (!user || !activeBook || isNaN(idx)) return;
    const docRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'readingHistory', activeBook.id);
    
    const updateData: any = { 
      bookId: activeBook.id, 
      charIndex: idx, 
      progressPercent: pct, 
      lastRead: serverTimestamp() 
    };

    if (bookmarks) {
      updateData.bookmarks = bookmarks;
    }

    await setDoc(docRef, updateData, { merge: true });
  }, [user?.uid, activeBook?.id]);

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
          <button onClick={() => signInWithPopup(auth, googleProvider)} className="w-full max-w-xs py-5 bg-white text-slate-900 font-black rounded-[2rem] text-xs uppercase tracking-widest shadow-xl active:scale-95">
            Sign in with Google
          </button>
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
            {/* A. 클라우드 연결 버튼 */}
            <button onClick={handleConnect} className="group relative w-full py-5 bg-white text-slate-900 font-black rounded-[2rem] text-xs uppercase tracking-widest shadow-xl active:scale-95 flex items-center justify-center gap-3 overflow-hidden">
               <div className="absolute inset-0 bg-indigo-500 opacity-0 group-hover:opacity-10 transition-opacity" />
               <Wifi size={18} className="text-indigo-600" />
               <span>Connect Cloud</span>
            </button>

             {/* B. 로컬 모드 버튼 */}
            <button onClick={handleLocalMode} className="w-full py-5 bg-slate-800 border border-white/10 text-slate-300 font-bold rounded-[2rem] text-xs uppercase tracking-widest shadow-lg active:scale-95 flex items-center justify-center gap-3 hover:bg-slate-700 transition-colors">
              <WifiOff size={18} />
              <span>Local Library Only</span>
            </button>
            
            {/* 공용 PC 옵션 (클라우드 모드용) */}
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
          userEmail={user?.email || ""} 
          isOfflineMode={isOfflineMode} 
          onToggleCloud={isOfflineMode ? handleConnect : handleDisconnectDrive} // 연결 토글 핸들러 전달
        />
      )}
      
      {/* 4. 리더 */}
      {view === 'reader' && activeBook && (
        <Reader 
          book={activeBook} 
          googleToken={googleToken || ''} // 로컬 모드일 땐 빈 토큰 전달
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