'use client';

import { Bookmark } from '../../types';
import { toClampedPercent } from '../foliate/progress';

export type ReaderRelocateDetail = {
  cfi?: string;
  fraction?: number;
  progressPercent?: number;
  location?: {
    current?: number;
    total?: number;
  };
};

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

export const getBookmarksKey = (items?: Bookmark[]) => JSON.stringify(items || []);

export { toClampedPercent };
