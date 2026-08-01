'use client';

import type { Bookmark } from '../../types';
import { toClampedPercent } from '../foliate/progress';
import { isSelectionRelocateReason } from '../../lib/readerTextSelection';

export type ReaderRelocateDetail = {
  cfi?: string;
  anchorCfi?: string;
  reason?: string;
  fraction?: number;
  progressPercent?: number;
  location?: {
    current?: number;
    total?: number;
  };
};

export type PersistableReaderLocation = {
  cfi: string;
  anchorCfi: string;
  percent: number;
};

type ReaderProgressPersistenceState = {
  hasUnsavedUserChange: boolean;
  hasPendingRelocateSave: boolean;
  inFlightCommitCount: number;
};

export const isReaderProgressPersistenceSettled = ({
  hasUnsavedUserChange,
  hasPendingRelocateSave,
  inFlightCommitCount,
}: ReaderProgressPersistenceState) => (
  !hasUnsavedUserChange
  && !hasPendingRelocateSave
  && inFlightCommitCount === 0
);

export const isQuietReaderResumeEligible = (
  state: ReaderProgressPersistenceState & { hasUserInteracted: boolean },
) => !state.hasUserInteracted && isReaderProgressPersistenceSettled(state);

export const getRelocatePercent = (detail: ReaderRelocateDetail, fallback: number) => {
  if (Number.isFinite(detail.progressPercent)) {
    return toClampedPercent(detail.progressPercent);
  }

  if (Number.isFinite(detail.fraction)) {
    return toClampedPercent((detail.fraction || 0) * 100);
  }

  if (detail.location) {
    const { current, total } = detail.location;
    if (Number.isFinite(current) && Number.isFinite(total) && total && total > 0) {
      return toClampedPercent((Number(current) / total) * 100);
    }
  }

  return toClampedPercent(fallback);
};

export const updatePersistableReaderLocation = (
  current: PersistableReaderLocation,
  detail: ReaderRelocateDetail,
  fallbackPercent: number,
) => {
  if (!detail.cfi || isSelectionRelocateReason(detail.reason)) return current;
  const percent = getRelocatePercent(detail, fallbackPercent);
  if (percent === null) return current;
  return {
    cfi: detail.cfi,
    anchorCfi: detail.anchorCfi || detail.cfi,
    percent,
  };
};

export const getBookmarksKey = (items?: Bookmark[]) => JSON.stringify(items || []);

export { toClampedPercent };
