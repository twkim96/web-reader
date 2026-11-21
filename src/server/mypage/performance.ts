export type ReadingEvidenceRoute = 'reading-evidence-import' | 'reading-evidence-legacy' | 'reading-evidence-deferred';

export function reportMyPageApiTiming(
  route: 'profile' | 'book-reviews' | ReadingEvidenceRoute,
  start: number,
  counters: Record<string, number>,
) {
  if (process.env.MY_PAGE_PERF_LOG !== '1') return;
  console.info('[MyPagePerformance]', { route, durationMs: Math.round(performance.now() - start), ...counters });
}
