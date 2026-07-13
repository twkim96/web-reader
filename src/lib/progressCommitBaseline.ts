import type { UserProgress } from '../types';

const committedProgress = new Map<string, UserProgress | undefined>();

const baselineKey = (ownerKey: string, bookId: string) => `${ownerKey}\u0000${bookId}`;

export const getProgressCommitBaseline = (
  ownerKey: string,
  bookId: string,
  fallback: UserProgress | undefined,
) => {
  const key = baselineKey(ownerKey, bookId);
  if (!committedProgress.has(key)) committedProgress.set(key, fallback);
  return committedProgress.get(key);
};

export const rebaseProgressCommitBaseline = (
  ownerKey: string,
  bookId: string,
  progress: UserProgress,
) => {
  committedProgress.set(baselineKey(ownerKey, bookId), progress);
};

export const clearProgressCommitBaseline = (ownerKey: string, bookId: string) => {
  committedProgress.delete(baselineKey(ownerKey, bookId));
};

export const resetProgressCommitBaselinesForTests = () => committedProgress.clear();
