'use client';

import React, { useState, useEffect } from 'react';
// 로컬 모듈 참조 경로 (src/app/page.tsx -> src/lib/firebase)
import { auth, db } from '../lib/firebase';
import { 
  onAuthStateChanged, 
  signInAnonymously, 
  User as FirebaseUser 
} from 'firebase/auth';
import { 
  collection, 
  doc, 
  onSnapshot, 
  setDoc, 
  serverTimestamp 
} from 'firebase/firestore';

// 모듈화된 유틸리티 및 UI 컴포넌트 임포트
import { findFolderId, fetchDriveFiles } from '../lib/googleDrive';
import { Shelf } from '../components/Shelf';
import { Reader } from '../components/Reader';
import { Book, UserProgress, ViewerSettings, ViewState } from '../types';
import { HardDrive } from 'lucide-react';

/**
 * [Main Controller]
 * page.tsx는 오로지 인증 상태, 뷰 전환, 그리고 Firestore 데이터 저장만을 관리하는
 * '오케스트레이터' 역할을 수행합니다. 모든 세부 독서 로직은 Reader 컴포넌트로 위임되었습니다.
 */
const APP_ID = "private-web-novel-viewer";

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
    navMode: 'scroll'
  });

  // 1. 초기 시스템 초기화 및 Firebase 익명 인증
  useEffect(() => {
    // Google Identity Services 스크립트 로드
    const script = document.createElement('script');
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true; 
    script.defer = true;
    document.body.appendChild(script);

    signInAnonymously(auth);
    const unsubscribeAuth = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        // Firestore에서 해당 사용자의 모든 독서 기록 실시간 구독
        const historyRef = collection(db, 'artifacts', APP_ID, 'users', u.uid, 'readingHistory');
        const unsubProgress = onSnapshot(historyRef, (snapshot) => {
          const p: Record<string, UserProgress> = {};
          snapshot.forEach(d => p[d.id] = d.data() as UserProgress);
          setProgress(p);
        });
        setView('auth');
        return () => unsubProgress();
      }
    });
    return () => unsubscribeAuth();
  }, []);

  /**
   * 구글 드라이브 라이브러리(폴더/파일 목록) 로드
   */
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

  /**
   * 독서 진행도 저장 핸들러
   * Reader.tsx에서 계산된 절대 위치(charIndex)와 백분율(percent)을 전달받아 DB에 기록합니다.
   */
  const handleSaveProgress = async (idx: number, pct: number) => {
    if (!user || !activeBook) return;
    const docRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'readingHistory', activeBook.id);
    await setDoc(docRef, { 
      bookId: activeBook.id, 
      charIndex: idx, 
      progressPercent: pct, 
      lastRead: serverTimestamp() 
    }, { merge: true });
  };

  /**
   * 구글 드라이브 액세스 토큰 획득
   */
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
        <p className="font-black uppercase tracking-widest text-xs opacity-30">Initializing Cloud Library</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen font-sans">
      {view === 'auth' && (
        <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#0f172a] text-white gap-12 p-10 text-center">
          <div className="p-10 bg-indigo-600 rounded-[3.5rem] shadow-2xl shadow-indigo-500/20">
            <HardDrive size={64} />
          </div>
          <div className="space-y-4">
            <h1 className="text-4xl font-black italic uppercase tracking-tighter">Private Cloud Reader</h1>
            <p className="text-slate-400 text-sm max-w-xs mx-auto leading-relaxed">
              구글 드라이브와 연동하여 소설 파일을 가져오고 기기 간 독서 위치를 실시간으로 동기화합니다.
            </p>
          </div>
          <button 
            onClick={handleConnect} 
            className="w-full max-w-xs py-5 bg-white text-slate-900 font-black rounded-[2rem] shadow-2xl transition-transform active:scale-95 text-xs uppercase tracking-widest"
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
          userEmail={user?.email} 
        />
      )}

      {view === 'reader' && activeBook && googleToken && (
        <Reader 
          book={activeBook} 
          googleToken={googleToken}
          initialProgress={progress[activeBook.id]} 
          settings={settings} 
          setSettings={setSettings} 
          onBack={() => setView('shelf')} 
          onSaveProgress={handleSaveProgress} 
        />
      )}
    </div>
  );
}