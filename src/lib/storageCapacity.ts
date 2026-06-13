export type StorageEstimate = {
  usage?: number;
  quota?: number;
};

const MAX_HEADROOM_BYTES = 20 * 1024 * 1024;
const HEADROOM_RATIO = 0.05;

export const hasEnoughStorageForWrite = (
  estimate: StorageEstimate,
  additionalBytes: number,
) => {
  if (additionalBytes <= 0) return true;
  if (!Number.isFinite(estimate.usage) || !Number.isFinite(estimate.quota)) return true;

  const usage = Math.max(0, estimate.usage ?? 0);
  const quota = Math.max(0, estimate.quota ?? 0);
  const available = Math.max(0, quota - usage);
  const headroom = Math.min(MAX_HEADROOM_BYTES, quota * HEADROOM_RATIO);
  return available >= additionalBytes + headroom;
};
