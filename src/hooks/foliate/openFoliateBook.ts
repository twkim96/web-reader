import type { FoliateBook, FoliateViewElement } from './types';
import { hashReaderTraceValue, recordReaderResumeFailure, traceReaderOpenPerformance } from '../../lib/readerBootstrapTrace.ts';

type BeforeInit = (view: FoliateViewElement) => void | Promise<void>;
type TimingWindow = Window & { __foliateReaderOpenTimingCount?: number };

export const openFoliateBook = async (
  view: FoliateViewElement,
  source: Blob | File | string | FoliateBook,
  initialCfi?: string,
  beforeInit?: BeforeInit,
  initialAnchorCfi?: string,
) => {
  const timingTarget = typeof window !== 'undefined' ? window : null;
  const timingWindow = timingTarget as TimingWindow | null;
  const timingNow = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
  let rejectedGeometry: { targetRectCount?: number; actualPage?: number; actualPages?: number } = {};
  const handleFoliateTiming = (event: Event) => {
    const detail = (event as CustomEvent<Record<string, unknown>>).detail;
    if (!detail || typeof detail.phase !== 'string') return;
    if (detail.phase === 'foliate-section-anchor' && detail.status === 'anchor-rejected') {
      rejectedGeometry = {
        targetRectCount: typeof detail.targetRectCount === 'number' ? detail.targetRectCount : undefined,
        actualPage: typeof detail.actualPage === 'number' ? detail.actualPage : undefined,
        actualPages: typeof detail.actualPages === 'number' ? detail.actualPages : undefined,
      };
    }
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
      targetHash: typeof detail.targetHash === 'string' ? detail.targetHash : undefined,
      actualPage: typeof detail.actualPage === 'number' ? detail.actualPage : undefined,
      actualPages: typeof detail.actualPages === 'number' ? detail.actualPages : undefined,
      targetRectCount: typeof detail.targetRectCount === 'number' ? detail.targetRectCount : undefined,
    });
  };
  timingTarget?.addEventListener('foliate-reader-open-timing', handleFoliateTiming);
  if (timingWindow) {
    timingWindow.__foliateReaderOpenTimingCount = (timingWindow.__foliateReaderOpenTimingCount ?? 0) + 1;
  }
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
    const resumeTargets = [initialCfi, initialAnchorCfi]
      .filter((target, index, all): target is string => Boolean(target) && all.indexOf(target) === index);
    if (resumeTargets.length > 0) {
      // init silently falls back to the beginning for an unresolved location,
      // and does not report a refused navigation. Resume through the same
      // pagination-stabilized path used by explicit saved-position jumps.
      let restored = false;
      let attempts = 0;
      let rejectedTarget: string | undefined;
      // Only while the opening overlay is present. Stable navigation waits for
      // pagination each time; retry the saved candidates once, never a timer
      // that could pull the user back after they have started reading.
      for (let pass = 0; pass < 2 && !restored; pass += 1) {
        for (const target of resumeTargets) {
          if (view.isConnected === false) throw new DOMException('Reader closed', 'AbortError');
          attempts += 1;
          const result = view.goToStable
            ? await view.goToStable(target)
            : await view.goTo(target);
          if (result) {
            restored = true;
            break;
          }
          rejectedTarget = target;
          traceReaderOpenPerformance({
            phase: 'foliate-initial-navigation',
            durationMs: timingNow() - startedAt,
            status: 'resume-target-rejected',
            targetHash: hashReaderTraceValue(target),
            actualPage: view.renderer?.page,
            actualPages: view.renderer?.pages,
            ...rejectedGeometry,
          });
        }
      }
      if (rejectedTarget) {
        recordReaderResumeFailure({
          status: restored ? 'recovered' : 'failed',
          attempts,
          targetHash: hashReaderTraceValue(rejectedTarget),
          actualPage: view.renderer?.page,
          actualPages: view.renderer?.pages,
          ...rejectedGeometry,
          viewportWidth: timingTarget?.innerWidth,
          viewportHeight: timingTarget?.innerHeight,
          reason: rejectedGeometry.targetRectCount === 0 ? 'missing-geometry' : 'navigation-rejected',
        });
      }
      if (!restored) {
        traceReaderOpenPerformance({
          phase: 'foliate-initial-navigation',
          durationMs: timingNow() - startedAt,
          status: 'resume-failed',
        });
        throw new Error('저장된 읽기 위치를 복원하지 못했습니다. 진행도는 변경하지 않았습니다. 서재에서 다시 열어 주세요.');
      }
    } else {
      await view.init({ lastLocation: null });
    }
    traceReaderOpenPerformance({
      phase: 'foliate-initial-navigation',
      durationMs: timingNow() - startedAt,
      status: resumeTargets.length > 0 ? 'resume' : 'start',
    });
  } finally {
    timingTarget?.removeEventListener('foliate-reader-open-timing', handleFoliateTiming);
    if (timingWindow) {
      timingWindow.__foliateReaderOpenTimingCount = Math.max(
        0,
        (timingWindow.__foliateReaderOpenTimingCount ?? 1) - 1,
      );
    }
  }
};
