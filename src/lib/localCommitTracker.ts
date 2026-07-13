const pendingLocalCommits = new Set<Promise<unknown>>();

export const trackLocalCommit = <T>(promise: Promise<T>) => {
  pendingLocalCommits.add(promise);
  const cleanup = () => pendingLocalCommits.delete(promise);
  void promise.then(cleanup, cleanup);
  return promise;
};

export const waitForCurrentLocalCommits = async () => {
  let rejected = 0;
  while (pendingLocalCommits.size > 0) {
    const results = await Promise.allSettled([...pendingLocalCommits]);
    rejected += results.filter((result) => result.status === 'rejected').length;
    // Let continuations register follow-up commits before deciding the drain is complete.
    await Promise.resolve();
  }
  return { ok: rejected === 0, rejected };
};

export const getPendingLocalCommitCount = () => pendingLocalCommits.size;
