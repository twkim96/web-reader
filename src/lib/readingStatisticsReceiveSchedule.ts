const MIN_RECEIVE_INTERVAL_MS = 60_000;

const RECEIVE_DELAYS_MS = [MIN_RECEIVE_INTERVAL_MS, 120_000, 300_000, 600_000] as const;

// Upload, explicit refresh, and online recovery are separate triggers
// and do not wait for the idle delay.
export function createReadingStatisticsReceiveSchedule() {
  let emptyStreak = 0;
  let lastCheck: number | null = null;

  const observeCheck = (checkedAt: number, receivedRecords?: boolean) => {
    if (lastCheck !== null && checkedAt <= lastCheck) return;
    lastCheck = checkedAt;
    if (receivedRecords === true) emptyStreak = 0;
    if (receivedRecords === false) emptyStreak = Math.min(emptyStreak + 1, RECEIVE_DELAYS_MS.length - 1);
  };
  const due = (now: number, delay: number) => (
    lastCheck === null || now < lastCheck || now - lastCheck >= delay
  );

  return {
    observeCheck,
    complete(now: number, receivedRecords: boolean) {
      if (lastCheck !== null && now <= lastCheck) lastCheck = null;
      observeCheck(now, receivedRecords);
    },
    pollDue: (now: number) => due(now, RECEIVE_DELAYS_MS[emptyStreak]),
    wakeDue: (now: number) => due(now, MIN_RECEIVE_INTERVAL_MS),
    nextPollDelay(now: number) {
      if (lastCheck === null || now < lastCheck) return MIN_RECEIVE_INTERVAL_MS;
      return Math.max(MIN_RECEIVE_INTERVAL_MS, RECEIVE_DELAYS_MS[emptyStreak] - (now - lastCheck));
    },
  };
}
