import type { FoliateBook, FoliateViewElement } from './types';

type BeforeInit = (view: FoliateViewElement) => void | Promise<void>;

export const openFoliateBook = async (
  view: FoliateViewElement,
  source: Blob | File | string | FoliateBook,
  initialCfi?: string,
  beforeInit?: BeforeInit,
) => {
  let fileSource = source;
  const isFile = typeof File !== 'undefined' && source instanceof File;
  if (source instanceof Blob && !isFile && typeof File !== 'undefined') {
    fileSource = new File([source], 'book.epub', { type: 'application/epub+zip' });
  }

  await view.open(fileSource);
  await beforeInit?.(view);
  await view.init({ lastLocation: initialCfi || null });
};
