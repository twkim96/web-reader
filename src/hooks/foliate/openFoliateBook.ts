import type { FoliateBook, FoliateViewElement } from './types';
import { traceReaderOpenPerformance } from '../../lib/readerBootstrapTrace.ts';

type BeforeInit = (view: FoliateViewElement) => void | Promise<void>;

export const openFoliateBook = async (
  view: FoliateViewElement,
  source: Blob | File | string | FoliateBook,
  initialCfi?: string,
  beforeInit?: BeforeInit,
) => {
  const timingTarget = typeof window !== 'undefined' ? window : null;
  const timingNow = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
  const handleFoliateTiming = (event: Event) => {
    const detail = (event as CustomEvent<Record<string, unknown>>).detail;
    if (!detail || typeof detail.phase !== 'string') return;
    traceReaderOpenPerformance({
      phase: detail.phase,
      durationMs: typeof detail.durationMs === 'number' ? detail.durationMs : undefined,
      sizeBytes: typeof detail.sizeBytes === 'number' ? detail.sizeBytes : undefined,
      entryCount: typeof detail.entryCount === 'number' ? detail.entryCount : undefined,
      sectionCount: typeof detail.sectionCount === 'number' ? detail.sectionCount : undefined,
      tocCount: typeof detail.tocCount === 'number' ? detail.tocCount : undefined,
      sectionIndex: typeof detail.sectionIndex === 'number' ? detail.sectionIndex : undefined,
      sectionSize: typeof detail.sectionSize === 'number' ? detail.sectionSize : undefined,
      status: typeof detail.status === 'string' ? detail.status : undefined,
    });
  };
  timingTarget?.addEventListener('foliate-reader-open-timing', handleFoliateTiming);
  let fileSource = source;
  const isFile = typeof File !== 'undefined' && source instanceof File;
  if (source instanceof Blob && !isFile && typeof File !== 'undefined') {
    fileSource = new File([source], 'book.epub', { type: 'application/epub+zip' });
  }

  try {
    let startedAt = timingNow();
    await view.open(fileSource);
    traceReaderOpenPerformance({
      phase: 'foliate-view-open',
      durationMs: timingNow() - startedAt,
      sizeBytes: fileSource instanceof Blob ? fileSource.size : undefined,
    });

    startedAt = timingNow();
    await beforeInit?.(view);
    traceReaderOpenPerformance({
      phase: 'reader-style-layout-init',
      durationMs: timingNow() - startedAt,
    });

    startedAt = timingNow();
    await view.init({ lastLocation: initialCfi || null });
    traceReaderOpenPerformance({
      phase: 'foliate-initial-navigation',
      durationMs: timingNow() - startedAt,
      status: initialCfi ? 'resume' : 'start',
    });
  } finally {
    timingTarget?.removeEventListener('foliate-reader-open-timing', handleFoliateTiming);
  }
};
