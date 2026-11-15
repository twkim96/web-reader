import type { ViewerSettings } from '../types';

export const DEFAULT_READER_MARGIN_STEP = 4;

export const clampReaderMarginStep = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(7, Math.max(1, Math.round(value)))
    : DEFAULT_READER_MARGIN_STEP
);

export const getReaderHorizontalMarginPercent = (step: unknown) => (
  clampReaderMarginStep(step) + 1
);

// Keep the saved padding/font-size baseline at step 4. Apply the offset
// afterwards so large fonts do not swallow the lower spacing steps.
export const getReaderVerticalPadding = (
  settings: Pick<ViewerSettings, 'padding' | 'fontSize' | 'verticalMarginStep'>,
) => Math.max(0, Math.max(settings.padding || 0, settings.fontSize)
  + (clampReaderMarginStep(settings.verticalMarginStep) - DEFAULT_READER_MARGIN_STEP) * 4);
