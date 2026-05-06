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
  const hasUnresolvedConflict = useRef(false);
  const [autoSyncToast, setAutoSyncToast] = useState(false);
  const [jumpRequest, setJumpRequest] = useState<number | null>(null); // [Added]
  
  
  // [Modified] 타임스탬프 파싱 로직을 안전하게 통일
  const parseTime = (val: any) => {
    if (!val) return 0;
    return val.toMillis ? val.toMillis() : new Date(val).getTime();
  };

  const lastSaveTime = useRef<number>(0);
  const hasRestored = useRef<string | null>(null);
  // [Fix] 마운트 시점의 charIndex를 기록하여 "초기 복원 데이터" vs "실시간 원격 업데이트"를 구분
  const mountCharIndex = useRef<number | null>(null);

  // [Added] 상태 기반 자동 동기화 처리를 위한 추적 Ref
  const mountTime = useRef(Date.now());
  const hasInteracted = useRef(false);
  // 마지막으로 저장한 charIndex를 기억 (Firebase 이중 발행 대응)
  const lastSavedCharIndex = useRef<number | null>(null);
  
  // [Added] 쓰로틀링 전용 타이머 (초기값을 Date.now()로 두어 진입 직후 스크롤에 의한 즉시 저장 방지)
  const lastSaveActionTime = useRef<number>(Date.now());

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

  const triggerSave = useCallback((idx: number, pct: number, bks?: Bookmark[]) => {
    lastSavedCharIndex.current = idx;
    // [Fix] 사용자 본인의 저장 시 baseline도 갱신 → 지연된 Firebase echo가 isBaselineDrift를 오발하지 않도록
    mountCharIndex.current = idx;
    onSaveProgress(idx, pct, bks);
    lastSaveTime.current = Date.now();
    lastSaveActionTime.current = Date.now();
  }, [onSaveProgress]);

  useEffect(() => {
    const saveCurrentState = () => {
      const { currentIdx: idx, readPercent: pct, bookmarks: bks } = latestState.current;
      // 해결되지 않은 원격 충돌(또는 원격 초기화)이 있다면 현재 로컬 상태를 서버에 덮어쓰지 않음
      if (idx > 0 && !hasUnresolvedConflict.current) {
        triggerSave(idx, pct, bks);
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
      triggerSave(currentIdx, readPercent, updated);
      return updated;
    });
  }, [bookmarks, currentIdx, readPercent, getPreviewText, triggerSave]);

  // Logic: Delete Bookmark
  const deleteBookmark = useCallback((id: string) => {
    setBookmarks(prev => {
      const updated = prev.filter(b => b.id !== id);
      triggerSave(currentIdx, readPercent, updated);
      return updated;
    });
  }, [currentIdx, readPercent, triggerSave]);

  // Logic: Conflict Detection & Auto Sync
  useEffect(() => {
    if (!isLoaded || !initialProgress || !initialProgress.lastRead) return;
    
    const remoteTime = parseTime(initialProgress.lastRead);
    const remoteIdx = initialProgress.charIndex;

    // [Fix] 첫 번째 유효 데이터: baseline(마운트 시점 위치)으로 기록하고 종료
    // 초기 복원(Reader의 Initial Restore)이 이 데이터를 사용하므로 여기서는 건드리지 않음
    if (mountCharIndex.current === null) {
      mountCharIndex.current = remoteIdx;
      lastSaveTime.current = remoteTime;
      return;
    }

    // Echo 방지: 최근 10초 이내에 저장했고 charIndex가 내가 마지막으로 저장한 값과 같거나 비슷하면
    // Firebase의 이중 발행(로컬 캐시 + 서버 확인) 응답이므로 무시
    const timeSinceLastSave = Date.now() - lastSaveTime.current;
    if (timeSinceLastSave < 10000 && lastSavedCharIndex.current !== null && Math.abs(lastSavedCharIndex.current - remoteIdx) < 100) {
      lastSaveTime.current = Math.max(lastSaveTime.current, remoteTime);
      return;
    }

    // [Fix] 원격 변경 감지: baseline과 charIndex 비교 (시간 기반 → 위치 기반으로 변경)
    // baseline(mountCharIndex)과 다르거나, 마지막 저장 이후 새로운 원격 업데이트인 경우
    const diffFromBaseline = Math.abs(remoteIdx - mountCharIndex.current);
    const diffFromCurrent = Math.abs(remoteIdx - currentIdx);
    const isNewRemoteUpdate = remoteTime > lastSaveTime.current + 2000;
    const isBaselineDrift = diffFromBaseline > 300;

    if (isBaselineDrift || isNewRemoteUpdate) {
      // 1. 책갈피는 무조건 최신으로 동기화
      if (initialProgress.bookmarks) {
        setBookmarks(initialProgress.bookmarks);
      }

      // 2. 위치 동기화 로직 분기
      if (diffFromCurrent > 300) {
        const isInitialLoad = (Date.now() - mountTime.current) < 5000;
        
        if (isInitialLoad && !hasInteracted.current) {
          setCurrentIdx(remoteIdx);
          setReadPercent(initialProgress.progressPercent);
          lastSaveTime.current = remoteTime;
          mountCharIndex.current = remoteIdx;
          setJumpRequest(remoteIdx);
          setAutoSyncToast(true);
          setTimeout(() => setAutoSyncToast(false), 2500);
        } else {
          hasUnresolvedConflict.current = true;
          setSyncConflict({
            show: true,
            remoteIdx: remoteIdx,
            remotePercent: initialProgress.progressPercent
          });
        }
      } else if (diffFromCurrent > 0) {
        if (!hasInteracted.current) {
          setCurrentIdx(remoteIdx);
          setReadPercent(initialProgress.progressPercent);
          setJumpRequest(remoteIdx);
        }
        lastSaveTime.current = remoteTime;
        mountCharIndex.current = remoteIdx;
      } else {
        lastSaveTime.current = remoteTime;
        mountCharIndex.current = remoteIdx;
      }
    }
  }, [initialProgress, currentIdx, isLoaded]);

  const resolveConflict = useCallback((keepLocal: boolean) => {
    hasUnresolvedConflict.current = false;
    if (keepLocal) {
      lastSaveTime.current = Date.now();
    }
    setSyncConflict(null);
  }, []);

  return {
    currentIdx, setCurrentIdx,
    readPercent, setReadPercent,
    bookmarks, setBookmarks,
    syncConflict, setSyncConflict,
    resolveConflict,
    autoSyncToast,
    createAutoBookmark,
    addManualBookmark,
    deleteBookmark,
    lastSaveTime,
    lastSaveActionTime, // [Added] Export for useVirtualScroll throttle
    hasRestored,
    triggerSave,
    jumpRequest, // [Added]
    setJumpRequest // [Added]
  };
};