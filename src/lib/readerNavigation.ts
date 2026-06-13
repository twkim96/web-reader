import type { ViewerSettings } from '../types';

export type ReaderNavigationMode = ViewerSettings['navMode'];

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
