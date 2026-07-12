const pendingLocalCommits = new Set<Promise<unknown>>();

export const trackLocalCommit = <T>(promise: Promise<T>) => {
  pendingLocalCommits.add(promise);
  const cleanup = () => pendingLocalCommits.delete(promise);
  void promise.then(cleanup, cleanup);
  return promise;
};

export const waitForCurrentLocalCommits = async () => {
  const current = [...pendingLocalCommits];
  if (current.length === 0) return;
  await Promise.allSettled(current);
};

export const getPendingLocalCommitCount = () => pendingLocalCommits.size;
