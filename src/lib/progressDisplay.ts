import type { UserProgress } from '../types';

export const mergeLatestProgressForDisplay = (
  local: Record<string, UserProgress>,
  remote: Record<string, UserProgress>,
) => {
  const merged = { ...local };
  for (const [bookId, remoteProgress] of Object.entries(remote)) {
    const localProgress = local[bookId];
    if (!localProgress || remoteProgress.lastRead > localProgress.lastRead) {
      merged[bookId] = remoteProgress;
    }
  }
  return merged;
};
