import type { waitForCurrentLocalCommits } from './localCommitTracker';

type DrainResult = Awaited<ReturnType<typeof waitForCurrentLocalCommits>>;

export const prepareServiceWorkerUpdate = async ({
  flushCurrentProgress,
  drainLocalCommits,
}: {
  flushCurrentProgress?: () => Promise<boolean>;
  drainLocalCommits: () => Promise<DrainResult>;
}) => {
  if (flushCurrentProgress && !await flushCurrentProgress()) return false;
  return (await drainLocalCommits()).ok;
};
