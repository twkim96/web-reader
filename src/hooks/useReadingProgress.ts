// src/hooks/useReadingProgress.ts
import { useState, useRef, useEffect, useCallback } from 'react';
import { UserProgress, Bookmark } from '../types';

const MANUAL_COLORS = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-green-500', 'bg-blue-500'];

interface UseReadingProgressProps {
  initialProgress?: UserProgress;
  fullContentRef: React.MutableRefObject<string>;
  onSaveProgress: (idx: number, pct: number, bookmarks?: Bookmark[]) => void;
  isLoaded: boolean;
}

export const useReadingProgress = ({
  initialProgress,
  fullContentRef,
  onSaveProgress,
  isLoaded
}: UseReadingProgressProps) => {
  // UI와 직접 바인딩되는 상태들
  const [currentIdx, setCurrentIdx] = useState(0);
  const [readPercent, setReadPercent] = useState(0);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(initialProgress?.bookmarks || []);
  
  const [syncConflict, setSyncConflict] = useState<{ show: boolean, remoteIdx: number, remotePercent: number } | null>(null);
  const [autoSyncToast, setAutoSyncToast] = useState(false);
  
  // [Modified] 타임스탬프 파싱 로직을 안전하게 통일
  const parseTime = (val: any) => {
    if (!val) return 0;
    return val.toMillis ? val.toMillis() : new Date(val).getTime();
  };

  const initialTime = parseTime(initialProgress?.lastRead);
  const lastSaveTime = useRef<number>(initialTime);
  const hasRestored = useRef<string | null>(null);

  // [Added] 상태 기반 자동 동기화 처리를 위한 추적 Ref
  const mountTime = useRef(Date.now());
  const hasInteracted = useRef(false);

  useEffect(() => {
    const handler = () => { hasInteracted.current = true; };
    window.addEventListener('touchstart', handler, { passive: true, once: true });
    window.addEventListener('mousedown', handler, { passive: true, once: true });
    window.addEventListener('wheel', handler, { passive: true, once: true });
    window.addEventListener('keydown', handler, { passive: true, once: true });
    return () => {
      window.removeEventListener('touchstart', handler);
      window.removeEventListener('mousedown', handler);
      window.removeEventListener('wheel', handler);
      window.removeEventListener('keydown', handler);
    };
  }, []);

  // Helper: Get Preview Text
  const getPreviewText = useCallback((idx: number) => {
    if (!fullContentRef.current) return "";
    const start = idx;
    const end = Math.min(fullContentRef.current.length, idx + 80);
    return fullContentRef.current.substring(start, end).replace(/\n/g, ' ').trim();
  }, [fullContentRef]);

  // [Added] 언마운트나 탭 숨김 시 최신 위치를 반드시 저장하기 위한 Ref 트래킹
  const latestState = useRef({ currentIdx: 0, readPercent: 0, bookmarks: [] as Bookmark[] });
  useEffect(() => {
    latestState.current = { currentIdx, readPercent, bookmarks };
  }, [currentIdx, readPercent, bookmarks]);

  useEffect(() => {
    const saveCurrentState = () => {
      const { currentIdx: idx, readPercent: pct, bookmarks: bks } = latestState.current;
      if (idx > 0) {
        onSaveProgress(idx, pct, bks);
        lastSaveTime.current = Date.now();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveCurrentState();
      }
    };

    window.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('visibilitychange', handleVisibilityChange);
      saveCurrentState(); // 언마운트 시 즉시 저장
    };
  }, [onSaveProgress]);

  // Logic: Create Auto Bookmark (최대 2개 유지)
  const createAutoBookmark = useCallback((originIndex: number): Bookmark[] => {
    if (originIndex < 100) return bookmarks; 

    const existingAuto = bookmarks.filter(b => b.type === 'auto');
    const manualBookmarks = bookmarks.filter(b => b.type !== 'auto');

    existingAuto.sort((a, b) => b.createdAt - a.createdAt);
    const survivors = existingAuto.slice(0, 1);

    const newAutoMark: Bookmark = {
      id: crypto.randomUUID(),
      type: 'auto',
      name: getPreviewText(originIndex),
      charIndex: originIndex,
      createdAt: Date.now(),
      color: 'bg-slate-500'
    };

    return [newAutoMark, ...survivors, ...manualBookmarks];
  }, [bookmarks, getPreviewText]);

  // Logic: Add Manual Bookmark
  const addManualBookmark = useCallback(() => {
    const manualCount = bookmarks.filter(b => b.type === 'manual').length;
    if (manualCount >= 5) {
      alert("수동 책갈피는 최대 5개까지만 저장할 수 있습니다.");
      return;
    }

    const targetIdx = currentIdx; 
    const usedColors = bookmarks.filter(b => b.type === 'manual').map(b => b.color);
    const nextColor = MANUAL_COLORS.find(c => !usedColors.includes(c)) || MANUAL_COLORS[0];

    const newMark: Bookmark = {
      id: crypto.randomUUID(),
      type: 'manual',
      name: getPreviewText(targetIdx),
      charIndex: targetIdx,
      createdAt: Date.now(),
      color: nextColor
    };

    setBookmarks(prev => {
      const updated = [newMark, ...prev];
      onSaveProgress(currentIdx, readPercent, updated);
      lastSaveTime.current = Date.now();
      return updated;
    });
  }, [bookmarks, currentIdx, readPercent, getPreviewText, onSaveProgress]);

  // Logic: Delete Bookmark
  const deleteBookmark = useCallback((id: string) => {
    setBookmarks(prev => {
      const updated = prev.filter(b => b.id !== id);
      onSaveProgress(currentIdx, readPercent, updated);
      lastSaveTime.current = Date.now();
      return updated;
    });
  }, [currentIdx, readPercent, onSaveProgress]);

  // Logic: Conflict Detection & Auto Sync
  useEffect(() => {
    if (!isLoaded || !initialProgress || !initialProgress.lastRead) return;
    
    const remoteTime = parseTime(initialProgress.lastRead);
    
    // [Modified] 로컬 저장 시간보다 원격 시간이 '확실히' 미래라면 (2초 버퍼)
    if (remoteTime > lastSaveTime.current + 2000) {
      const diff = Math.abs(initialProgress.charIndex - currentIdx);

      // 1. 책갈피는 무조건 최신으로 동기화
      if (initialProgress.bookmarks) {
        setBookmarks(initialProgress.bookmarks);
      }

      // [Rule 3] 네트워크 응답이 너무 늦은 경우 (로딩 후 5초 초과) 모달/이동 모두 취소
      const timeSinceMount = Date.now() - mountTime.current;
      if (timeSinceMount > 5000) {
        lastSaveTime.current = remoteTime;
        console.log(`[AutoSync] Rejected: Network response took too long (${timeSinceMount}ms)`);
        return;
      }

      // 2. 위치 동기화 로직 분기
      if (diff > 300) {
        // [Rule 1 & 2] 유저의 동작(탭, 스크롤) 여부에 따라 결정
        if (!hasInteracted.current) {
          // Rule 1: 유저 조작이 없었다면 조용히 최신 위치로 자동 이동
          setCurrentIdx(initialProgress.charIndex);
          setReadPercent(initialProgress.progressPercent);
          lastSaveTime.current = remoteTime;
          setAutoSyncToast(true);
          setTimeout(() => setAutoSyncToast(false), 2500);
          console.log(`[AutoSync] Silent auto-jump executed.`);
        } else {
          // Rule 2: 유저가 이미 책을 조작하고 있다면 기존처럼 모달 띄우기
          setSyncConflict({
            show: true,
            remoteIdx: initialProgress.charIndex,
            remotePercent: initialProgress.progressPercent
          });
        }
      } else if (diff > 0) {
        // 미세한 차이는 조용히 맞춤
        if (!hasInteracted.current) {
          setCurrentIdx(initialProgress.charIndex);
          setReadPercent(initialProgress.progressPercent);
        }
        lastSaveTime.current = remoteTime;
      } else {
        lastSaveTime.current = remoteTime;
      }
    }
  }, [initialProgress, currentIdx, isLoaded]); // 의존성 배열 유지

  return {
    currentIdx, setCurrentIdx,
    readPercent, setReadPercent,
    bookmarks, setBookmarks,
    syncConflict, setSyncConflict,
    autoSyncToast,
    createAutoBookmark,
    addManualBookmark,
    deleteBookmark,
    lastSaveTime,
    hasRestored
  };
};