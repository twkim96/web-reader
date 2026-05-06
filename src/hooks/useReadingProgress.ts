// src/hooks/useReadingProgress.ts
import { useState, useRef, useEffect, useCallback } from 'react';
import { UserProgress, Bookmark } from '../types';

const MANUAL_COLORS = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-green-500', 'bg-blue-500'];

interface UseReadingProgressProps {
  initialProgress?: UserProgress;
  remoteProgress?: UserProgress;
  fullContentRef: React.MutableRefObject<string>;
  onSaveProgress: (idx: number, pct: number, bookmarks?: Bookmark[]) => void;
  isLoaded: boolean;
}

export const useReadingProgress = ({
  initialProgress,
  remoteProgress,
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
  const [jumpRequest, setJumpRequest] = useState<number | null>(null);
  
  const hasRestored = useRef<string | null>(null);
  // initialProgress를 ref로 추적하여 remoteProgress effect에서 항상 최신값 참조
  const initialProgressRef = useRef(initialProgress);
  useEffect(() => { initialProgressRef.current = initialProgress; }, [initialProgress]);
  // 초기 복원 완료 여부 추적 (완료 전엔 currentIdx = 0)
  const hasInitialRestored = useRef(false);

  // 자동 동기화 판별용
  const mountTime = useRef(Date.now());
  const hasInteracted = useRef(false);
  
  // 쓰로틀링 전용 타이머 (초기값을 Date.now()로 두어 진입 직후 스크롤에 의한 즉시 저장 방지)
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

  // 언마운트나 탭 숨김 시 최신 위치를 반드시 저장하기 위한 Ref 트래킹
  const latestState = useRef({ currentIdx: 0, readPercent: 0, bookmarks: [] as Bookmark[] });
  useEffect(() => {
    latestState.current = { currentIdx, readPercent, bookmarks };
    // currentIdx가 처음으로 0보다 커지면 초기 복원 완료로 표시
    if (currentIdx > 0 && !hasInitialRestored.current) {
      hasInitialRestored.current = true;
    }
  }, [currentIdx, readPercent, bookmarks]);

  const triggerSave = useCallback((idx: number, pct: number, bks?: Bookmark[]) => {
    onSaveProgress(idx, pct, bks);
    lastSaveActionTime.current = Date.now();
  }, [onSaveProgress]);

  useEffect(() => {
    const saveCurrentState = () => {
      const { currentIdx: idx, readPercent: pct, bookmarks: bks } = latestState.current;
      // 해결되지 않은 원격 충돌이 있다면 현재 로컬 상태를 서버에 덮어쓰지 않음
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

  // Logic: Conflict Detection & Auto Sync (deviceId 기반 — 원격 업데이트만 수신)
  const lastProcessedRemote = useRef<{ charIndex: number, lastRead: number } | null>(null);

  useEffect(() => {
    if (!isLoaded || !remoteProgress) return;

    const remoteIdx = remoteProgress.charIndex;
    const remoteTime = remoteProgress.lastRead;

    // 이미 처리한 업데이트와 동일하면 무시
    if (lastProcessedRemote.current &&
        lastProcessedRemote.current.charIndex === remoteIdx &&
        lastProcessedRemote.current.lastRead === remoteTime) return;
    lastProcessedRemote.current = { charIndex: remoteIdx, lastRead: remoteTime };

    // 1. 책갈피는 무조건 최신으로 동기화
    if (remoteProgress.bookmarks) {
      setBookmarks(remoteProgress.bookmarks);
    }

    // 2. 위치 동기화 로직
    // 초기 복원 전(currentIdx = 0)엔 initialProgress 위치를 기준으로 diff 계산
    // → 같은 onSnapshot에서 initialProgress와 remoteProgress가 동시에 업데이트돼도 diff ≈ 0이므로 오발 없음
    const baseIdx = hasInitialRestored.current
      ? latestState.current.currentIdx
      : (initialProgressRef.current?.charIndex ?? 0);
    const diff = Math.abs(remoteIdx - baseIdx);

    if (diff > 300) {
      const isInitialLoad = (Date.now() - mountTime.current) < 5000;

      if (isInitialLoad && !hasInteracted.current) {
        // 자동 동기화 (토스트)
        setCurrentIdx(remoteIdx);
        setReadPercent(remoteProgress.progressPercent);
        setJumpRequest(remoteIdx);
        setAutoSyncToast(true);
        setTimeout(() => setAutoSyncToast(false), 2500);
      } else {
        // 충돌 다이얼로그
        hasUnresolvedConflict.current = true;
        setSyncConflict({
          show: true,
          remoteIdx: remoteIdx,
          remotePercent: remoteProgress.progressPercent
        });
      }
    } else if (diff > 0 && !hasInteracted.current) {
      // 미세 차이: 조용히 조정
      setCurrentIdx(remoteIdx);
      setReadPercent(remoteProgress.progressPercent);
      setJumpRequest(remoteIdx);
    }
  }, [remoteProgress, isLoaded]);

  const resolveConflict = useCallback((_keepLocal: boolean) => {
    hasUnresolvedConflict.current = false;
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
    lastSaveActionTime,
    hasRestored,
    triggerSave,
    jumpRequest,
    setJumpRequest
  };
};