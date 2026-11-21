type DiscoveryPhase = 'json' | 'validation' | 'grouping' | 'search' | 'sort' | 'filter' | 'first-rows';

export function startDiscoveryTiming() {
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mypagePerf') === '1') {
    return performance.now();
  }
}

export function finishDiscoveryTiming(phase: DiscoveryPhase, start: number | undefined) {
  if (start !== undefined) performance.measure(`mypage:catalog:${phase}`, { start, end: performance.now() });
}
