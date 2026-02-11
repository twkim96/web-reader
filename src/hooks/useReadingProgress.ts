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
  
  // [Fix] 초기값을 로컬에서 넘겨받은 데이터의 기록 시간으로 설정합니다.
  // 데이터가 아예 없다면 0으로 설정하여, 이후 동기화 시 알림을 띄우게 합니다.
  const initialTime = initialProgress && initialProgress.lastRead
    ? (initialProgress.lastRead.toMillis ? initialProgress.lastRead.toMillis() : new Date(initialProgress.lastRead).getTime())
    : 0;

  const lastSaveTime = useRef<number>(initialTime);
  const hasRestored = useRef<string | null>(null);

  // Helper: Get Preview Text
  const getPreviewText = useCallback((idx: number) => {
    if (!fullContentRef.current) return "";
    const start = Math.max(0, idx - 30);
    const end = Math.min(fullContentRef.current.length, idx + 100);
    return fullContentRef.current.substring(start, end).replace(/\n/g, ' ').trim();
  }, [fullContentRef]);

  // Logic: Create Auto Bookmark (최대 2개 유지)
  const createAutoBookmark = useCallback((originIndex: number): Bookmark[] => {
    if (originIndex < 100) return bookmarks; 

    // 1. 기존 자동/수동 책갈피 분리
    const existingAuto = bookmarks.filter(b => b.type === 'auto');
    const manualBookmarks = bookmarks.filter(b => b.type !== 'auto');

    // 2. 자동 책갈피를 최신순(createdAt 내림차순)으로 정렬
    existingAuto.sort((a, b) => b.createdAt - a.createdAt);

    // 3. 최신 1개만 남김 (새로 하나가 추가되면 총 2개가 됨)
    // 기존이 0개면 [], 1개면 [1], 2개면 [최신]
    const survivors = existingAuto.slice(0, 1);

    const newAutoMark: Bookmark = {
      id: crypto.randomUUID(), // 고유 ID 부여
      type: 'auto',
      name: getPreviewText(originIndex),
      charIndex: originIndex,
      createdAt: Date.now(),
      color: 'bg-slate-500'
    };

    // 4. [새것, 살아남은것(최대1개), 수동...] 순서로 병합
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

  // Logic: Conflict Detection
  useEffect(() => {
    if (!isLoaded || !initialProgress || !initialProgress.lastRead) return;
    const remoteTime = initialProgress.lastRead.toMillis ? initialProgress.lastRead.toMillis() : new Date(initialProgress.lastRead).getTime();
    
    if (remoteTime > lastSaveTime.current + 2000) {
      if (Math.abs(initialProgress.charIndex - currentIdx) > 300) {
        setSyncConflict({
          show: true,
          remoteIdx: initialProgress.charIndex,
          remotePercent: initialProgress.progressPercent
        });
      }
      if (initialProgress.bookmarks) {
        setBookmarks(initialProgress.bookmarks);
      }
    }
  }, [initialProgress, currentIdx, isLoaded]);

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