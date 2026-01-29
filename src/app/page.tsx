// src/app/page.tsx
'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { auth, db, APP_ID } from '../lib/firebase';
import { onAuthStateChanged, signInAnonymously, User as FirebaseUser } from 'firebase/auth';
import { collection, doc, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore';

import { findFolderId, fetchDriveFiles } from '../lib/googleDrive';
import { Shelf } from '../components/Shelf';
import { Reader } from '../components/Reader';
import { Book, UserProgress, ViewerSettings, ViewState } from '../types';
import { HardDrive } from 'lucide-react';

export default function Page() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [view, setView] = useState<ViewState>('loading');
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [activeBook, setActiveBook] = useState<Book | null>(null);
  const [progress, setProgress] = useState<Record<string, UserProgress>>({});
  
  // [수정] ViewerSettings 타입 변경에 맞춰 fontFamily 초기값 추가
  const [settings, setSettings] = useState<ViewerSettings>({
    fontSize: 18, 
    lineHeight: 1.9, 
    padding: 24, 
    textAlign: 'justify', 
    theme: 'sepia', 
    navMode: 'scroll',
    fontFamily: 'sans' // 기본값 추가
  });

  useEffect(() => {
    const script = document.createElement('script');
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true; 
    script.defer = true;
    document.body.appendChild(script);

    signInAnonymously(auth);
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
      }
    });
    return () => unsubscribeAuth();
  }, []);

  const handleUpdateSettings = useCallback(async (newSettings: Partial<ViewerSettings>) => {
    const updated = { ...settings, ...newSettings };
    setSettings(updated);
    if (user) {
      const settingsRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'settings', 'viewer');
      await setDoc(settingsRef, updated, { merge: true });
    }
  }, [settings, user]);

  const loadLibrary = async (token: string) => {
    setView('loading');
    try {
      const fid = folderId || await findFolderId("web reader", token);
      setFolderId(fid);
      const data = await fetchDriveFiles(token, fid || undefined);
      setBooks(data.files || []);
      setView('shelf');
    } catch (err) { 
      console.error("Library load failed:", err); 
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
        <p className="font-black uppercase tracking-widest text-xs opacity-30">Initializing Library</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen font-sans">
      {view === 'auth' && (
        <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#0f172a] text-white gap-12 p-10 text-center">
          <div className="p-10 bg-indigo-600 rounded-[3.5rem] shadow-2xl">
            <HardDrive size={64} />
          </div>
          <h1 className="text-4xl font-black italic uppercase tracking-tighter text-white">Private Cloud Reader</h1>
          <button onClick={handleConnect} className="w-full max-w-xs py-5 bg-white text-slate-900 font-black rounded-[2rem] text-xs uppercase tracking-widest">Connect Google Drive</button>
        </div>
      )}

      {view === 'shelf' && (
        <Shelf 
          books={books} 
          progress={progress} 
          isRefreshing={false} 
          onRefresh={() => googleToken && loadLibrary(googleToken)} 
          onOpen={(b) => { setActiveBook(b); setView('reader'); }} 
          userEmail={user?.email} 
        />
      )}

      {view === 'reader' && activeBook && googleToken && (
        <Reader 
          book={activeBook} 
          googleToken={googleToken}
          initialProgress={progress[activeBook.id]} 
          settings={settings} 
          // [수정] 프롭 이름을 Reader의 interface와 동일하게 맞춥니다.
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