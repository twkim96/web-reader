import type { ViewerSettings } from '../types';

export type ReaderNavigationMode = ViewerSettings['navMode'];
export type ReaderTapAction = 'prev' | 'next' | 'controls';
export type ReaderKeyboardAction = 'prev' | 'next' | null;

export const DEFAULT_TOP_BOTTOM_TAP_PERCENT = 33;
export const DEFAULT_LEFT_RIGHT_TAP_PERCENT = 30;
export const MIN_TAP_ZONE_PERCENT = 10;
export const MAX_TAP_ZONE_PERCENT = 45;

export const getReaderMaxColumnCount = (
  navMode: ReaderNavigationMode,
  landscapeTwoPage: boolean,
) => navMode !== 'scroll' && landscapeTwoPage ? 2 : 1;

export const clampTapZonePercent = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_TAP_ZONE_PERCENT, Math.max(MIN_TAP_ZONE_PERCENT, Math.round(value)));
};

type ReaderTapActionOptions = {
  navMode: ReaderNavigationMode;
  clientX: number;
  clientY: number;
  width: number;
  height: number;
  topBottomPercent: number;
  leftRightPercent: number;
};

export const getReaderTapAction = ({
  navMode,
  clientX,
  clientY,
  width,
  height,
  topBottomPercent,
  leftRightPercent,
}: ReaderTapActionOptions): ReaderTapAction => {
  const verticalRatio = clampTapZonePercent(
    topBottomPercent,
    DEFAULT_TOP_BOTTOM_TAP_PERCENT,
  ) / 100;
  const horizontalRatio = clampTapZonePercent(
    leftRightPercent,
    DEFAULT_LEFT_RIGHT_TAP_PERCENT,
  ) / 100;

  if (navMode === 'page' || navMode === 'all-dir') {
    if (clientY < height * verticalRatio) return 'prev';
    if (clientY > height * (1 - verticalRatio)) return 'next';
  }

  if (navMode === 'left-right' || navMode === 'all-dir') {
    if (clientX < width * horizontalRatio) return 'prev';
    if (clientX > width * (1 - horizontalRatio)) return 'next';
  }

  return 'controls';
};

export const getReaderKeyboardAction = (
  navMode: ReaderNavigationMode,
  key: string,
): ReaderKeyboardAction => {
  if (key === ' ' || key === 'Spacebar' || key === 'Space') return 'next';

  if (navMode === 'scroll') {
    if (key === 'ArrowUp') return 'prev';
    if (key === 'ArrowDown') return 'next';
    return null;
  }

  if (navMode === 'page') {
    if (key === 'ArrowUp') return 'prev';
    if (key === 'ArrowDown') return 'next';
    return null;
  }

  if (navMode === 'left-right') {
    if (key === 'ArrowLeft') return 'prev';
    if (key === 'ArrowRight') return 'next';
    return null;
  }

  if (key === 'ArrowUp' || key === 'ArrowLeft') return 'prev';
  if (key === 'ArrowDown' || key === 'ArrowRight') return 'next';
  return null;
};

export const getEffectiveNavigationMode = (
  navMode: ReaderNavigationMode,
  isFixedLayout: boolean,
): ReaderNavigationMode => (
  isFixedLayout && navMode === 'scroll' ? 'left-right' : navMode
);

export const getNavigationOptions = (isFixedLayout: boolean) => {
  const options = [
    { value: 'scroll', label: 'Scroll' },
    { value: 'page', label: 'T/B Tap' },
    { value: 'left-right', label: 'L/R Tap' },
    { value: 'all-dir', label: '4-Way' },
  ] as const;

  return isFixedLayout
    ? options.filter(({ value }) => value !== 'scroll')
    : options;
};
