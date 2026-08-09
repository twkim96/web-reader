import type { ReadingStatisticsClockSample } from './readingStatisticsSync';

const CLOCK_SAMPLE_PREFIX = 'reading_stats_clock_v1:';
const CLOCK_SAMPLE_MAX_AGE_MS = 24 * 60 * 60_000;
const CLOCK_SAMPLE_MAX_UNCERTAINTY_MS = 5_000;

const getKey = (deviceId: string) => `${CLOCK_SAMPLE_PREFIX}${encodeURIComponent(deviceId)}`;

export const isTrustedReadingStatisticsClockSample = (
  value: unknown,
  now = Date.now(),
): value is ReadingStatisticsClockSample => {
  if (typeof value !== 'object' || value === null) return false;
  const sample = value as Partial<ReadingStatisticsClockSample>;
  return Number.isSafeInteger(sample.offsetMs)
    && Math.abs(Number(sample.offsetMs)) <= 24 * 60 * 60_000
    && Number.isSafeInteger(sample.uncertaintyMs)
    && Number(sample.uncertaintyMs) >= 0
    && Number(sample.uncertaintyMs) <= CLOCK_SAMPLE_MAX_UNCERTAINTY_MS
    && Number.isSafeInteger(sample.measuredAtClient)
    && Number(sample.measuredAtClient) <= now + 60_000
    && now - Number(sample.measuredAtClient) <= CLOCK_SAMPLE_MAX_AGE_MS;
};

export const readReadingStatisticsClockSample = (
  deviceId: string,
  storage: Pick<Storage, 'getItem'> = localStorage,
  now = Date.now(),
) => {
  try {
    const raw = storage.getItem(getKey(deviceId));
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    return isTrustedReadingStatisticsClockSample(value, now) ? value : null;
  } catch {
    return null;
  }
};

export const writeReadingStatisticsClockSample = (
  deviceId: string,
  sample: ReadingStatisticsClockSample,
  storage: Pick<Storage, 'setItem'> = localStorage,
) => {
  if (!isTrustedReadingStatisticsClockSample(sample, sample.measuredAtClient)) return false;
  storage.setItem(getKey(deviceId), JSON.stringify(sample));
  return true;
};
