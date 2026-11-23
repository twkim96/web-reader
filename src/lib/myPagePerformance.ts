type DiscoveryPhase = 'json' | 'validation' | 'grouping' | 'search' | 'sort' | 'filter' | 'first-rows';

export function isMyPagePerformanceEnabled() {
  return typeof window !== 'undefined' && new URLSearchParams(window.location?.search).get('mypagePerf') === '1';
}

export function startDiscoveryTiming() {
  if (isMyPagePerformanceEnabled()) {
    return performance.now();
  }
}

export function finishDiscoveryTiming(phase: DiscoveryPhase, start: number | undefined) {
  if (start !== undefined) performance.measure(`mypage:catalog:${phase}`, { start, end: performance.now() });
}

type MyPagePhase = 'wishlist-ready' | 'reviews-ready' | 'review-preview-ready' | 'read-books-timeline' | 'dashboard-timeline'
  | 'reading-calendar-ready' | 'reading-week-ready' | 'reading-files-ready' | 'reading-book-totals-ready';

export function finishMyPageTiming(phase: MyPagePhase, start: number | undefined) {
  if (start !== undefined) performance.measure(`mypage:${phase}`, { start, end: performance.now() });
}

export function measureMyPageWork<T>(phase: MyPagePhase, work: () => T): T {
  const started = startDiscoveryTiming();
  try {
    return work();
  } finally {
    finishMyPageTiming(phase, started);
  }
}
