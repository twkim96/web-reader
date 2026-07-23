export const ACTIVE_SYNC_POLL_DELAY_MS = 100;
export const IDLE_SYNC_POLL_DELAY_MS = 30_000;

export const runProgressSyncPoll = async (
  flushOne: () => Promise<string>,
  reportError: (error: unknown) => void,
) => {
  try {
    const result = await flushOne();
    return result === 'apply' || result === 'already_applied' || result === 'stale_lease'
      ? ACTIVE_SYNC_POLL_DELAY_MS
      : IDLE_SYNC_POLL_DELAY_MS;
  } catch (error) {
    reportError(error);
    return IDLE_SYNC_POLL_DELAY_MS;
  }
};
