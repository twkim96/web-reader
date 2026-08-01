export const MEANINGFUL_PROGRESS_DELTA_PERCENT = 0.03;

const toComparablePercent = (value: number) => (
  Number.isFinite(value) ? value : 0
);

export const hasMeaningfulProgressDelta = (
  leftPercent: number,
  rightPercent: number,
) => Math.abs(
  toComparablePercent(leftPercent) - toComparablePercent(rightPercent)
) > MEANINGFUL_PROGRESS_DELTA_PERCENT;
