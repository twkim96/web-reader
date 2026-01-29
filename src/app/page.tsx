// src/app/page.tsx
'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { auth, db, googleProvider, APP_ID } from '../lib/firebase';
import { onAuthStateChanged, signInWithPopup, signOut, User as FirebaseUser } from 'firebase/auth';
import { collection, doc, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore';

import { findFolderId, fetchDriveFiles } from '../lib/googleDrive';
import { Shelf } from '../components/Shelf';
import { Reader } from '../components/Reader';
import { Book, UserProgress, ViewerSettings, ViewState } from '../types';
import { HardDrive, LogOut, ShieldCheck } from 'lucide-react';

export default function Page() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [view, setView] = useState<ViewState>('loading');
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [activeBook, setActiveBook] = useState<Book | null>(null);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  
  // 공용 PC 여부 상태 (기본값: false -> localStorage 사용)
  const [isPublicPC, setIsPublicPC] = useState(false);

  const [settings, setSettings] = useState<ViewerSettings>({
    fontSize: 18, lineHeight: 1.9, padding: 24, textAlign: 'justify', 
    theme: 'sepia', navMode: 'scroll', fontFamily: 'sans', encoding: 'auto'
  });

  // 1. 토큰 복구 로직
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
        const historyRef = collection(db, 'artifacts', APP_ID, 'users', u.uid, 'readingHistory');
        const unsubProgress = onSnapshot(historyRef, (snapshot) => {
          const p: Record<string, UserProgress> = {};
          snapshot.forEach(d => p[d.id] = d.data() as UserProgress);
          setProgress(p);
        });

        const settingsRef = doc(db, 'artifacts', APP_ID, 'users', u.uid, 'settings', 'viewer');
        const unsubSettings = onSnapshot(settingsRef, (docSnap) => {
          if (docSnap.exists()) setSettings(docSnap.data() as ViewerSettings);
        });

        const recoveredToken = getStoredToken();
        if (recoveredToken) {
          setGoogleToken(recoveredToken);
          loadLibrary(recoveredToken);
        } else {
          setView('auth');
        }

        return () => { unsubProgress(); unsubSettings(); };
      } else {
        setView('auth');
      }
    });
    return () => unsubscribeAuth();
  }, []);

  // [New] 브라우저 뒤로가기(popstate) 핸들링
  useEffect(() => {
    const handlePopState = () => {
      // URL에 #reader가 없고, 현재 뷰가 reader라면 shelf로 돌아감
      if (view === 'reader' && !window.location.hash.includes('reader')) {
        setView('shelf');
        setActiveBook(null);
        window.scrollTo(0, 0);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [view]);

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
      // 로그아웃 시 해시 제거
      if (window.location.hash) {
        history.replaceState(null, '', ' ');
      }
    }
  };

  const handleUpdateSettings = useCallback(async (newSettings: Partial<ViewerSettings>) => {
    const updated = { ...settings, ...newSettings };
    setSettings(updated);
    if (user) {
      const settingsRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'settings', 'viewer');
      await setDoc(settingsRef, updated, { merge: true });
    }
  }, [settings, user]);

  const handleSaveProgress = useCallback(async (idx: number, pct: number) => {
    if (!user || !activeBook || isNaN(idx)) return;
    const docRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'readingHistory', activeBook.id);
    await setDoc(docRef, { bookId: activeBook.id, charIndex: idx, progressPercent: pct, lastRead: serverTimestamp() }, { merge: true });
  }, [user?.uid, activeBook?.id]);

  // [New] 책 열기 핸들러 (히스토리 추가)
  const handleOpenBook = (b: Book) => {
    // 가상의 히스토리 엔트리 추가 (#reader)
    window.history.pushState({ view: 'reader' }, '', '#reader');
    setActiveBook(b);
    setView('reader');
  };

  // [New] 책 닫기 핸들러 (히스토리 뒤로가기)
  const handleCloseBook = () => {
    if (window.location.hash.includes('reader')) {
      // 히스토리가 있으면 뒤로가기를 통해 popstate 유발 -> useEffect에서 처리
      window.history.back();
    } else {
      // 히스토리가 꼬였을 경우 강제 이동
      window.scrollTo(0, 0);
      setView('shelf');
      setActiveBook(null);
    }
  };

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
          <h1 className="text-4xl font-black italic uppercase tracking-tighter">Private Reader</h1>
          <button onClick={() => signInWithPopup(auth, googleProvider)} className="w-full max-w-xs py-5 bg-white text-slate-900 font-black rounded-[2rem] text-xs uppercase tracking-widest shadow-xl active:scale-95">
            Sign in with Google
          </button>
        </div>
      )}

      {/* 2. 드라이브 연결 화면 */}
      {view === 'auth' && user && (
        <div className="h-screen w-screen flex flex-col items-center justify-center text-white gap-8 p-10 text-center">
          <div className="relative mb-4">
            <div className="p-10 bg-indigo-600 rounded-[3.5rem] shadow-2xl">
              <HardDrive size={64} />
            </div>
            <button onClick={handleLogout} className="absolute -top-2 -right-2 p-3 bg-red-500 rounded-full shadow-lg active:scale-90"><LogOut size={18} /></button>
          </div>
          
          <div className="space-y-1">
            <p className="text-indigo-400 font-black text-[10px] uppercase tracking-[0.3em]">Authorized as</p>
            <h1 className="text-xl font-bold">{user.displayName || user.email}</h1>
          </div>

          <div className="w-full max-w-xs space-y-4">
            <label className={`flex items-center justify-center gap-3 p-4 rounded-2xl border-2 transition-all cursor-pointer ${isPublicPC ? 'border-indigo-500 bg-indigo-500/10' : 'border-white/10 bg-white/5'}`}>
              <input type="checkbox" checked={isPublicPC} onChange={(e) => setIsPublicPC(e.target.checked)} className="hidden" />
              <ShieldCheck size={20} className={isPublicPC ? 'text-indigo-400' : 'text-slate-500'} />
              <span className={`text-[11px] font-bold uppercase tracking-wider ${isPublicPC ? 'text-white' : 'text-slate-400'}`}>
                {isPublicPC ? 'Public PC (Session Only)' : 'Private PC (Keep Logged in)'}
              </span>
            </label>

            <button onClick={handleConnect} className="w-full py-5 bg-white text-slate-900 font-black rounded-[2rem] text-xs uppercase tracking-widest shadow-xl active:scale-95">
              Connect Google Drive
            </button>
          </div>
        </div>
      )}

      {/* 3. 책장 & 리더 */}
      {view === 'shelf' && (
        <Shelf 
          books={books} 
          progress={progress} 
          isRefreshing={false} 
          onRefresh={() => googleToken && loadLibrary(googleToken)} 
          onOpen={handleOpenBook} // 수정된 핸들러 전달
          onLogout={handleLogout}
          userEmail={user?.email || ""} 
        />
      )}
      {view === 'reader' && activeBook && googleToken && (
        <Reader 
          book={activeBook} 
          googleToken={googleToken} 
          initialProgress={progress[activeBook.id]} 
          settings={settings} 
          onUpdateSettings={handleUpdateSettings} 
          onBack={handleCloseBook} // 수정된 핸들러 전달 (내부 뒤로가기 클릭 시)
          onSaveProgress={handleSaveProgress} 
        />
      )}
    </div>
  );
}