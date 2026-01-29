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
import { HardDrive, LogOut } from 'lucide-react';

export default function Page() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [view, setView] = useState<ViewState>('loading');
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [activeBook, setActiveBook] = useState<Book | null>(null);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  
  const [settings, setSettings] = useState<ViewerSettings>({
    fontSize: 18, 
    lineHeight: 1.9, 
    padding: 24, 
    textAlign: 'justify', 
    theme: 'sepia', 
    navMode: 'scroll',
    fontFamily: 'sans',
    encoding: 'auto',
  });

  useEffect(() => {
    const script = document.createElement('script');
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true; 
    script.defer = true;
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
          if (docSnap.exists()) {
            setSettings(docSnap.data() as ViewerSettings);
          }
        });

        setView('auth');
        return () => { unsubProgress(); unsubSettings(); };
      } else {
        setView('auth');
      }
    });
    return () => unsubscribeAuth();
  }, []);

  const handleGoogleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  const handleLogout = async () => {
    if (confirm("로그아웃 하시겠습니까?")) {
      await signOut(auth);
      setGoogleToken(null);
      setBooks([]);
      setView('auth');
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

  /**
   * 라이브러리 로드 로직 수정: "web viewer" 폴더 강제 지정
   */
  const loadLibrary = async (token: string) => {
    setView('loading');
    try {
      // 검색할 폴더명을 "web viewer"로 고정
      const targetFolderName = "web viewer";
      const fid = await findFolderId(targetFolderName, token);
      
      if (fid) {
        setFolderId(fid);
        const data = await fetchDriveFiles(token, fid);
        setBooks(data.files || []);
      } else {
        // 폴더가 없으면 빈 목록 설정
        setBooks([]);
      }
      setView('shelf');
    } catch (err) { 
      console.error("Library load failed:", err); 
      setBooks([]); 
      setView('shelf'); 
    }
  };

  const handleSaveProgress = useCallback(async (idx: number, pct: number) => {
    if (!user || !activeBook || isNaN(idx)) return;
    try {
      const docRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'readingHistory', activeBook.id);
      await setDoc(docRef, { 
        bookId: activeBook.id, 
        charIndex: idx, 
        progressPercent: pct, 
        lastRead: serverTimestamp() 
      }, { merge: true });
    } catch (e) {
      console.error("Progress Save Error:", e);
    }
  }, [user?.uid, activeBook?.id]);

  const handleConnect = () => {
    if (!(window as any).google) return;
    const client = (window as any).google.accounts.oauth2.initTokenClient({
      client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      callback: (res: any) => { 
        if (res.access_token) { 
          setGoogleToken(res.access_token); 
          loadLibrary(res.access_token); 
        } 
      },
    });
    client.requestAccessToken();
  };

  if (view === 'loading') {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-slate-900 text-white gap-4">
        <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        <p className="font-black uppercase tracking-widest text-xs opacity-30">Initializing...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen font-sans">
      {view === 'auth' && !user && (
        <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#0f172a] text-white gap-12 p-10 text-center">
          <div className="p-10 bg-indigo-600 rounded-[3.5rem] shadow-2xl">
            <HardDrive size={64} />
          </div>
          <div className="space-y-4">
            <h1 className="text-4xl font-black italic uppercase tracking-tighter text-white">Private Cloud Reader</h1>
            <p className="text-slate-400 text-xs tracking-widest uppercase">Sync your library with Google Account</p>
          </div>
          <button 
            onClick={handleGoogleLogin} 
            className="w-full max-w-xs py-5 bg-white text-slate-900 font-black rounded-[2rem] text-xs uppercase tracking-widest shadow-xl transition-transform active:scale-95"
          >
            Sign in with Google
          </button>
        </div>
      )}

      {view === 'auth' && user && (
        <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#0f172a] text-white gap-12 p-10 text-center">
          <div className="relative">
            <div className="p-10 bg-indigo-600 rounded-[3.5rem] shadow-2xl">
              <HardDrive size={64} />
            </div>
            <button 
              onClick={handleLogout}
              className="absolute -top-2 -right-2 p-3 bg-red-500 rounded-full shadow-lg transition-transform active:scale-90"
            >
              <LogOut size={18} />
            </button>
          </div>
          <div className="space-y-2">
            <p className="text-indigo-400 font-black text-[10px] uppercase tracking-[0.3em]">Welcome back</p>
            <h1 className="text-xl font-bold">{user.displayName || user.email}</h1>
          </div>
          <button 
            onClick={handleConnect} 
            className="w-full max-w-xs py-5 bg-white text-slate-900 font-black rounded-[2rem] text-xs uppercase tracking-widest shadow-xl"
          >
            Connect Google Drive
          </button>
        </div>
      )}

      {view === 'shelf' && (
        <Shelf 
          books={books} 
          progress={progress} 
          isRefreshing={false} 
          onRefresh={() => googleToken && loadLibrary(googleToken)} 
          onOpen={(b) => { setActiveBook(b); setView('reader'); }} 
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
          onBack={() => {
            window.scrollTo(0, 0);
            setView('shelf');
          }} 
          onSaveProgress={handleSaveProgress} 
        />
      )}
    </div>
  );
}