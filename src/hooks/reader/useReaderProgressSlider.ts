'use client';

import { useCallback, useRef, useState } from 'react';
import { Bookmark } from '../../types';
import { createPendingSliderMove } from '../../lib/readerNavigationCommit';
import { toClampedPercent } from './progress';

type SliderStart = {
  cfi: string;
  percent: number;
};

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
  markUserProgressChange: (options?: {
    forceNextRelocateSave?: boolean;
    expectedPercent?: number;
    bookmarks?: Bookmark[];
  }) => void;
  goToFraction: (fraction: number) => Promise<boolean>;
  saveCurrentProgress: () => boolean | Promise<boolean>;
  markReadingActivity: () => void;
}

export const useReaderProgressSlider = ({
  currentCfi,
  totalProgress,
  stageAutoBookmark,
  commitBookmarks,
  markUserProgressChange,
  goToFraction,
  saveCurrentProgress,
  markReadingActivity,
}: UseReaderProgressSliderOptions) => {
  const [draftProgress, setDraftProgress] = useState<number | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingSliderMove | null>(null);
  const [isCommittingMove, setIsCommittingMove] = useState(false);
  const draftProgressRef = useRef<number | null>(null);
  const startRef = useRef<SliderStart | null>(null);

  const beginSliderMove = useCallback(() => {
    if (startRef.current) return;
    startRef.current = {
      cfi: currentCfi,
      percent: totalProgress,
    };
  }, [currentCfi, totalProgress]);

  const previewSliderMove = useCallback((progressPercent: number) => {
    beginSliderMove();

    const safePercent = toClampedPercent(progressPercent);
    if (safePercent === null) return;

    draftProgressRef.current = safePercent;
    setDraftProgress(safePercent);
  }, [beginSliderMove]);

  const commitSliderMove = useCallback(() => {
    const targetPercent = draftProgressRef.current;
    const start = startRef.current;
    draftProgressRef.current = null;
    startRef.current = null;
    setDraftProgress(null);

    if (targetPercent === null) return;

    const startPercent = start?.percent ?? totalProgress;
    const startCfi = start?.cfi ?? currentCfi;
    if (Math.abs(targetPercent - startPercent) < 0.05) return;

    setPendingMove(createPendingSliderMove({
      targetPercent,
      startPercent,
      startCfi,
      stageAutoBookmark,
    }));
  }, [currentCfi, stageAutoBookmark, totalProgress]);

  const cancelSliderMove = useCallback(() => {
    if (isCommittingMove) return;
    setPendingMove(null);
  }, [isCommittingMove]);

  const confirmSliderMove = useCallback(async () => {
    const move = pendingMove;
    if (!move || isCommittingMove) return false;
    setIsCommittingMove(true);

    try {
      const { targetPercent, stagedBookmarks } = move;

      const committed = await goToFraction(targetPercent / 100);
      if (!committed) return false;
      markReadingActivity();
      markUserProgressChange({
        forceNextRelocateSave: true,
        expectedPercent: targetPercent,
        bookmarks: stagedBookmarks,
      });
      const saved = await saveCurrentProgress();
      if (!saved) return false;
      if (stagedBookmarks) commitBookmarks(stagedBookmarks);
      setPendingMove(null);
      return true;
    } finally {
      setIsCommittingMove(false);
    }
  }, [commitBookmarks, goToFraction, isCommittingMove, markReadingActivity, markUserProgressChange, pendingMove, saveCurrentProgress]);

  return {
    sliderProgress: draftProgress ?? pendingMove?.targetPercent ?? totalProgress,
    isSliderPreviewing: draftProgress !== null,
    pendingSliderMove: pendingMove,
    isSliderMoveCommitting: isCommittingMove,
    beginSliderMove,
    previewSliderMove,
    commitSliderMove,
    cancelSliderMove,
    confirmSliderMove,
  };
};
