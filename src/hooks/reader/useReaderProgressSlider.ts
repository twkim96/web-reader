'use client';

import { useCallback, useRef, useState } from 'react';
import { Bookmark } from '../../types';
import { toClampedPercent } from './progress';

export type PendingSliderMove = {
  targetPercent: number;
  startPercent: number;
  startCfi: string;
  stagedBookmarks?: Bookmark[];
};

interface UseReaderProgressSliderOptions {
  currentCfi: string;
  totalProgress: number;
  stageAutoBookmark: (prevCfi: string, prevPct: number) => Bookmark[];
  commitBookmarks: (bookmarks: Bookmark[]) => Bookmark[];
  getBookmarks: () => Bookmark[];
  getCurrentPercent: () => number;
  goTo: (cfi: string) => Promise<boolean>;
  goToFraction: (fraction: number) => Promise<boolean>;
  beginProvisionalNavigation: () => void;
  confirmProvisionalNavigation: (bookmarks?: Bookmark[]) => Promise<boolean>;
  cancelProvisionalNavigation: () => void;
  markReadingActivity: () => void;
}

export const useReaderProgressSlider = ({
  currentCfi, totalProgress, stageAutoBookmark, commitBookmarks, getBookmarks, getCurrentPercent, goTo, goToFraction,
  beginProvisionalNavigation, confirmProvisionalNavigation, cancelProvisionalNavigation,
  markReadingActivity,
}: UseReaderProgressSliderOptions) => {
  const [draftProgress, setDraftProgress] = useState<number | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingSliderMove | null>(null);
  const [isCommittingMove, setIsCommittingMove] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const draftRef = useRef<number | null>(null);
  const originRef = useRef<{ cfi: string; percent: number } | null>(null);
  const pendingRef = useRef<PendingSliderMove | null>(null);
  const resolvingRef = useRef(false);
  const originBookmarkRef = useRef<Bookmark | undefined>(undefined);
  // Serial navigation prevents an earlier slow jump from winning over cancel/confirm.
  const navigationRef = useRef<Promise<boolean>>(Promise.resolve(true));

  const beginSliderMove = useCallback(() => {
    if (resolvingRef.current || originRef.current) return;
    originRef.current = { cfi: currentCfi, percent: totalProgress };
    beginProvisionalNavigation();
    const existingIds = new Set(getBookmarks().map(bookmark => bookmark.id));
    const staged = stageAutoBookmark(currentCfi, totalProgress);
    const newAuto = staged.find(bookmark => !existingIds.has(bookmark.id));
    originBookmarkRef.current = newAuto ? { ...newAuto, cfi: currentCfi, progressPercent: totalProgress } : undefined;
  }, [beginProvisionalNavigation, currentCfi, getBookmarks, stageAutoBookmark, totalProgress]);

  const previewSliderMove = useCallback((percent: number) => {
    if (resolvingRef.current) return;
    const safe = toClampedPercent(percent);
    if (safe === null) return;
    beginSliderMove();
    draftRef.current = safe;
    setDraftProgress(safe);
  }, [beginSliderMove]);

  const commitSliderMove = useCallback(() => {
    if (resolvingRef.current) return;
    const target = draftRef.current;
    const origin = originRef.current;
    draftRef.current = null;
    setDraftProgress(null);
    if (target === null || !origin) {
      if (!pendingRef.current) {
        originRef.current = null;
        cancelProvisionalNavigation();
      }
      return;
    }
    if (!pendingRef.current && Math.abs(target - origin.percent) < 0.05) {
      cancelProvisionalNavigation();
      originRef.current = null;
      return;
    }
    const move: PendingSliderMove = {
      targetPercent: target, startPercent: origin.percent, startCfi: origin.cfi,
    };
    pendingRef.current = move;
    setPendingMove(move);
    setMoveError(null);
    navigationRef.current = navigationRef.current.catch(() => false).then(async () => {
      try {
        const moved = await goToFraction(target / 100);
        if (!moved) setMoveError('위치를 열지 못했습니다. 다시 이동하거나 취소해 주세요.');
        else { pendingRef.current = move; setPendingMove(move); }
        return moved;
      } catch {
        setMoveError('위치를 열지 못했습니다. 다시 이동하거나 취소해 주세요.');
        return false;
      }
    });
  }, [cancelProvisionalNavigation, goToFraction]);

  const navigateWithinPreview = useCallback((navigate: () => Promise<boolean>) => {
    if (resolvingRef.current || !originRef.current) return Promise.resolve(false);
    const origin = originRef.current;
    const navigation = navigationRef.current.catch(() => false).then(async () => {
      try {
        const moved = await navigate();
        if (moved) {
          const move = { targetPercent: getCurrentPercent(), startCfi: origin.cfi, startPercent: origin.percent };
          pendingRef.current = move;
          setPendingMove(move);
          setMoveError(null);
        } else setMoveError('위치를 열지 못했습니다. 다시 이동하거나 취소해 주세요.');
        return moved;
      } catch {
        setMoveError('위치를 열지 못했습니다. 다시 이동하거나 취소해 주세요.');
        return false;
      }
    });
    navigationRef.current = navigation;
    return navigation;
  }, [getCurrentPercent]);

  const cancelSliderPreview = useCallback(() => {
    draftRef.current = null;
    setDraftProgress(null);
    if (!pendingRef.current) {
      originRef.current = null;
      cancelProvisionalNavigation();
    }
  }, [cancelProvisionalNavigation]);

  const clearMove = useCallback(() => {
    pendingRef.current = null;
    originRef.current = null;
    originBookmarkRef.current = undefined;
    draftRef.current = null;
    setPendingMove(null);
    setDraftProgress(null);
    setMoveError(null);
  }, []);

  const cancelSliderMove = useCallback(async () => {
    if (resolvingRef.current || !originRef.current) return;
    resolvingRef.current = true;
    setIsCommittingMove(true);
    try {
      await navigationRef.current;
      const origin = originRef.current;
      const restored = origin.cfi ? await goTo(origin.cfi) : await goToFraction(origin.percent / 100);
      if (!restored) {
        setMoveError('원래 위치로 돌아가지 못했습니다. 취소를 다시 눌러 주세요.');
        return;
      }
      cancelProvisionalNavigation();
      clearMove();
    } catch {
      setMoveError('원래 위치로 돌아가지 못했습니다. 취소를 다시 눌러 주세요.');
    } finally {
      resolvingRef.current = false;
      setIsCommittingMove(false);
    }
  }, [cancelProvisionalNavigation, clearMove, goTo, goToFraction]);

  const confirmSliderMove = useCallback(async () => {
    if (resolvingRef.current || !pendingRef.current) return false;
    resolvingRef.current = true;
    setIsCommittingMove(true);
    try {
      if (!await navigationRef.current) return false;
      const actualPercent = getCurrentPercent();
      const origin = originRef.current;
      const originBookmark = originBookmarkRef.current;
      const liveBookmarks = getBookmarks();
      const bookmarks = origin && originBookmark && Math.abs(actualPercent - origin.percent) > 5
        ? [...liveBookmarks.filter(bookmark => bookmark.type === 'manual'), originBookmark,
          ...liveBookmarks.filter(bookmark => bookmark.type === 'auto' && bookmark.id !== originBookmark.id).slice(0, 2)]
        : undefined;
      if (!await confirmProvisionalNavigation(bookmarks)) {
        setMoveError('위치를 저장하지 못했습니다. 확인을 다시 눌러 주세요.');
        return false;
      }
      if (bookmarks) commitBookmarks([
        ...getBookmarks().filter(bookmark => bookmark.type === 'manual'),
        ...bookmarks.filter(bookmark => bookmark.type === 'auto'),
      ]);
      clearMove();
      markReadingActivity();
      return true;
    } catch {
      setMoveError('위치를 저장하지 못했습니다. 확인을 다시 눌러 주세요.');
      return false;
    } finally {
      resolvingRef.current = false;
      setIsCommittingMove(false);
    }
  }, [clearMove, commitBookmarks, confirmProvisionalNavigation, getBookmarks, getCurrentPercent, markReadingActivity]);

  return {
    sliderProgress: draftProgress ?? pendingMove?.targetPercent ?? totalProgress,
    isSliderPreviewing: draftProgress !== null,
    pendingSliderMove: pendingMove,
    isSliderMoveCommitting: isCommittingMove,
    sliderMoveError: moveError,
    beginSliderMove, previewSliderMove, commitSliderMove, cancelSliderPreview,
    cancelSliderMove, confirmSliderMove, navigateWithinPreview,
  };
};
