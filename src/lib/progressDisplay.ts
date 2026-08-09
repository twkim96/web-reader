import type { UserProgress } from '../types';

export const mergeLatestProgressForDisplay = (
  local: Record<string, UserProgress>,
  remote: Record<string, UserProgress>,
) => {
  const merged = { ...local };
  for (const [bookId, remoteProgress] of Object.entries(remote)) {
    const localProgress = local[bookId];
    const ignoredRemoteRevision = localProgress?.ignoredRemoteRevision;
    if (
      Number.isSafeInteger(ignoredRemoteRevision)
      && Number.isSafeInteger(remoteProgress.syncRevision)
      && ignoredRemoteRevision! >= remoteProgress.syncRevision!
    ) continue;
    const comparableRevisions = Number.isSafeInteger(localProgress?.syncRevision)
      && Number.isSafeInteger(remoteProgress.syncRevision);
    if (
      !localProgress
      || (comparableRevisions
        ? remoteProgress.syncRevision! > localProgress.syncRevision!
        : remoteProgress.lastRead > localProgress.lastRead)
    ) {
      merged[bookId] = remoteProgress;
    }
  }
  return merged;
};
