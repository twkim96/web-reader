const pendingLocalCommits = new Set<Promise<unknown>>();

export const trackLocalCommit = <T>(promise: Promise<T>) => {
  pendingLocalCommits.add(promise);
  const cleanup = () => pendingLocalCommits.delete(promise);
  void promise.then(cleanup, cleanup);
  return promise;
};

export const waitForCurrentLocalCommits = async () => {
  while (pendingLocalCommits.size > 0) {
    await Promise.allSettled([...pendingLocalCommits]);
    // Let continuations register follow-up commits before deciding the drain is complete.
    await Promise.resolve();
  }
};

export const getPendingLocalCommitCount = () => pendingLocalCommits.size;
