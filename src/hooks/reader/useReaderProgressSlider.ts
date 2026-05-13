'use client';

import { useCallback, useRef, useState } from 'react';
import { Bookmark } from '../../types';
import { toClampedPercent } from './progress';

type SliderStart = {
  cfi: string;
  percent: number;
};

interface UseReaderProgressSliderOptions {
  currentCfi: string;
  totalProgress: number;
  createAutoBookmark: (prevCfi: string, prevPct: number) => Bookmark[];
  markUserProgressChange: (options?: {
    forceNextRelocateSave?: boolean;
    expectedPercent?: number;
    bookmarks?: Bookmark[];
  }) => void;
  goToFraction: (fraction: number) => Promise<void>;
}

const AUTO_BOOKMARK_THRESHOLD_PERCENT = 5;

export const useReaderProgressSlider = ({
  currentCfi,
  totalProgress,
  createAutoBookmark,
  markUserProgressChange,
  goToFraction,
}: UseReaderProgressSliderOptions) => {
  const [draftProgress, setDraftProgress] = useState<number | null>(null);
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
    const diff = Math.abs(targetPercent - startPercent);
    const updatedBookmarks = diff > AUTO_BOOKMARK_THRESHOLD_PERCENT
      ? createAutoBookmark(startCfi, startPercent)
      : undefined;

    markUserProgressChange({
      forceNextRelocateSave: true,
      expectedPercent: targetPercent,
      bookmarks: updatedBookmarks,
    });
    void goToFraction(targetPercent / 100);
  }, [createAutoBookmark, currentCfi, goToFraction, markUserProgressChange, totalProgress]);

  return {
    sliderProgress: draftProgress ?? totalProgress,
    beginSliderMove,
    previewSliderMove,
    commitSliderMove,
  };
};
