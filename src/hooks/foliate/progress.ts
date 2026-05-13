'use client';

import { RelocateDetail } from './types';

export const toClampedPercent = (value: unknown) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  return Math.min(100, Math.max(0, numericValue));
};

export const getProgressFromRelocateDetail = (detail: RelocateDetail) => {
  if (Number.isFinite(detail.fraction)) {
    return toClampedPercent(detail.fraction * 100);
  }

  if (detail.location) {
    const { current, total } = detail.location;
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
      return toClampedPercent((current / total) * 100);
    }
  }

  return null;
};
