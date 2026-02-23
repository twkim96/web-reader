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
  
  // [Modified] 타임스탬프 파싱 로직을 안전하게 통일
  const parseTime = (val: any) => {
    if (!val) return 0;
    return val.toMillis ? val.toMillis() : new Date(val).getTime();
  };

  const initialTime = parseTime(initialProgress?.lastRead);
  const lastSaveTime = useRef<number>(initialTime);
  const hasRestored = useRef<string | null>(null);

  // Helper: Get Preview Text
  const getPreviewText = useCallback((idx: number) => {
    if (!fullContentRef.current) return "";
    const start = idx;
    const end = Math.min(fullContentRef.current.length, idx + 80);
    return fullContentRef.current.substring(start, end).replace(/\n/g, ' ').trim();
  }, [fullContentRef]);

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

      // 2. 위치 동기화 로직 분기
      if (diff > 300) {
        // 차이가 크면 사용자에게 선택권 부여 (충돌 모달)
        setSyncConflict({
          show: true,
          remoteIdx: initialProgress.charIndex,
          remotePercent: initialProgress.progressPercent
        });
        // 주의: 여기서 lastSaveTime을 업데이트하면 안 됨 (사용자가 '무시'를 선택할 수 있으므로)
      } else if (diff > 0) {
        // [Key Fix] 차이가 작으면(300자 이내) '조용히' 최신 위치로 자동 보정
        // 이렇게 해야 "미세한 과거 상태"로 덮어쓰는 것을 방지함
        setCurrentIdx(initialProgress.charIndex);
        setReadPercent(initialProgress.progressPercent);
        
        // [Key Fix] 로컬 기준 시간을 원격 시간으로 맞춰줌으로써
        // 불필요한 자동 저장 트리거 방지
        lastSaveTime.current = remoteTime;
        
        console.log(`[AutoSync] Minor diff(${diff}) detected. Synced to remote.`);
      } else {
        // 위치가 정확히 같다면 시간만 동기화
        lastSaveTime.current = remoteTime;
      }
    }
  }, [initialProgress, currentIdx, isLoaded]); // 의존성 배열 유지

  return {
    currentIdx, setCurrentIdx,
    readPercent, setReadPercent,
    bookmarks, setBookmarks,
    syncConflict, setSyncConflict,
    createAutoBookmark,
    addManualBookmark,
    deleteBookmark,
    lastSaveTime,
    hasRestored
  };
};