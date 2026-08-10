'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { Book } from '../../types';
import type { FoliateViewElement } from '../foliate/types';
import { getOrCreateDeviceId } from '../useDeviceId';
import { saveLocalReadingSessionV11 } from '../../lib/localReadingStatistics';
import type { OwnerKey } from '../../lib/ownerIdentity';
import {
  getReadingSessionLocalDate,
  getNextReadingTtsTrackingPhase,
  getReadingTrackingEndAt,
  getReadingTrackingMode,
  READING_SESSION_MAX_ACTIVE_INTERVALS,
  READING_SESSION_MAX_DURATION_MS,
  READING_SESSION_MIN_DURATION_MS,
  READING_SESSION_SCHEMA_VERSION,
  type ReadingActiveIntervalV1,
  type ReadingSessionMode,
  type ReadingTtsTrackingPhase,
  type ReadingSessionV1,
} from '../../lib/readingStatistics';
import type { ReaderTtsStatus } from './useReaderTts';
import { readReadingStatisticsClockSample } from '../../lib/readingStatisticsClock';
import {
  getReadingStatisticsDraftKey,
  getReadingStatisticsDraftPrefix,
  getReadingStatisticsDraftRecoveryEnd,
} from '../../lib/readingStatisticsDraft';
import {
  detachReadingActivityTargets,
  reconcileReadingActivityTargets,
  type ReadingActivityTarget,
} from '../../lib/readingActivityTargets';

const HEARTBEAT_MS = 5_000;
const COMPLETION_PERCENT = 99.5;
type ActiveSegment = {
  sessionId: string;
  mode: ReadingSessionMode;
  startedAtClient: number;
  lastHeartbeatAt: number;
  startProgressPercent: number;
  endProgressPercent: number;
  timezoneOffsetMinutes: number;
  startedAtMonotonic: number;
  clockOffsetMs?: number;
  clockUncertaintyMs?: number;
  clockMeasuredAtClient?: number;
  activeIntervals?: ReadingActiveIntervalV1[];
  activeIntervalStartedAtClient?: number | null;
};

type ReadingSessionDraft = ActiveSegment & {
  schemaVersion: 1;
  ownerKey: OwnerKey;
  bookId: string;
  bookTitle: string;
  deviceId: string;
  state?: 'active' | 'closed-pending';
  closedAtClient?: number;
};

const clampProgress = (value: number) => (
  Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0
);

const getNextLocalMidnight = (timestamp: number, timezoneOffsetMinutes: number) => {
  const localTimestamp = timestamp - timezoneOffsetMinutes * 60_000;
  const nextLocalDay = (Math.floor(localTimestamp / 86_400_000) + 1) * 86_400_000;
  return nextLocalDay + timezoneOffsetMinutes * 60_000;
};

const getMonotonicNow = () => performance.now();

const getSegmentWallTime = (segment: ActiveSegment, monotonicAt: number) => (
  segment.startedAtClient + Math.max(0, Math.round(monotonicAt - segment.startedAtMonotonic))
);

const isDraft = (value: unknown): value is ReadingSessionDraft => {
  if (typeof value !== 'object' || value === null) return false;
  const draft = value as Partial<ReadingSessionDraft>;
  return draft.schemaVersion === 1
    && typeof draft.ownerKey === 'string'
    && typeof draft.bookId === 'string'
    && typeof draft.bookTitle === 'string'
    && typeof draft.deviceId === 'string'
    && typeof draft.sessionId === 'string'
    && (draft.mode === 'screen' || draft.mode === 'tts')
    && Number.isSafeInteger(draft.startedAtClient)
    && Number.isSafeInteger(draft.lastHeartbeatAt)
    && typeof draft.startProgressPercent === 'number'
    && typeof draft.endProgressPercent === 'number'
    && Number.isInteger(draft.timezoneOffsetMinutes)
    && (
      draft.activeIntervals === undefined
      || (
        Array.isArray(draft.activeIntervals)
        && draft.activeIntervals.length <= READING_SESSION_MAX_ACTIVE_INTERVALS
        && draft.activeIntervals.every((interval) => (
          typeof interval === 'object'
          && interval !== null
          && Number.isSafeInteger(interval.startedAtClient)
          && Number.isSafeInteger(interval.endedAtClient)
          && interval.endedAtClient > interval.startedAtClient
        ))
      )
    )
    && (
      draft.activeIntervalStartedAtClient === undefined
      || draft.activeIntervalStartedAtClient === null
      || Number.isSafeInteger(draft.activeIntervalStartedAtClient)
    );
};

const toClosedSession = (
  draft: ReadingSessionDraft,
  endedAtClient: number,
): ReadingSessionV1 | null => {
  const safeEnd = Math.min(
    endedAtClient,
    draft.startedAtClient + READING_SESSION_MAX_DURATION_MS,
    getNextLocalMidnight(draft.startedAtClient, draft.timezoneOffsetMinutes),
  );
  const activeIntervals = draft.mode === 'tts' && draft.activeIntervals
    ? [
      ...draft.activeIntervals,
      ...(draft.activeIntervalStartedAtClient !== null
        && draft.activeIntervalStartedAtClient !== undefined
        && safeEnd > draft.activeIntervalStartedAtClient
        ? [{
          startedAtClient: draft.activeIntervalStartedAtClient,
          endedAtClient: safeEnd,
        }]
        : []),
    ].map((interval) => ({
      startedAtClient: Math.max(draft.startedAtClient, interval.startedAtClient),
      endedAtClient: Math.min(safeEnd, interval.endedAtClient),
    })).filter((interval) => interval.endedAtClient > interval.startedAtClient)
    : null;
  const actualEnd = activeIntervals?.at(-1)?.endedAtClient ?? safeEnd;
  const durationMs = activeIntervals
    ? activeIntervals.reduce((total, interval) => (
      total + interval.endedAtClient - interval.startedAtClient
    ), 0)
    : actualEnd - draft.startedAtClient;
  if (durationMs < READING_SESSION_MIN_DURATION_MS) return null;
  return {
    schemaVersion: READING_SESSION_SCHEMA_VERSION,
    sessionId: draft.sessionId,
    bookId: draft.bookId,
    bookTitle: draft.bookTitle.slice(0, 1_000) || '제목 없음',
    deviceId: draft.deviceId,
    mode: draft.mode,
    startedAtClient: draft.startedAtClient,
    endedAtClient: actualEnd,
    durationMs,
    startProgressPercent: clampProgress(draft.startProgressPercent),
    endProgressPercent: clampProgress(draft.endProgressPercent),
    timezoneOffsetMinutes: draft.timezoneOffsetMinutes,
    localDate: getReadingSessionLocalDate(
      draft.startedAtClient,
      draft.timezoneOffsetMinutes,
    ),
    completed: draft.endProgressPercent >= COMPLETION_PERCENT,
    ...(activeIntervals ? { activeIntervals } : {}),
    ...(draft.clockOffsetMs !== undefined ? {
      clockOffsetMs: draft.clockOffsetMs,
      clockUncertaintyMs: draft.clockUncertaintyMs,
      clockMeasuredAtClient: draft.clockMeasuredAtClient,
    } : {}),
  };
};

export const useReadingSessionTracker = ({
  ownerKey,
  book,
  deviceId: providedDeviceId,
  isLoaded,
  suspended,
  ttsStatus,
  progressPercent,
  viewRef,
}: {
  ownerKey: OwnerKey;
  book: Book;
  deviceId?: string;
  isLoaded: boolean;
  suspended: boolean;
  ttsStatus: ReaderTtsStatus;
  progressPercent: number;
  viewRef: MutableRefObject<FoliateViewElement | null>;
}) => {
  const activeSegmentRef = useRef<ActiveSegment | null>(null);
  const lastActivityAtRef = useRef(0);
  const loadedRef = useRef(isLoaded);
  const suspendedRef = useRef(suspended);
  const ttsTrackingPhaseRef = useRef<ReadingTtsTrackingPhase>(
    getNextReadingTtsTrackingPhase('inactive', ttsStatus),
  );
  const progressRef = useRef(progressPercent);
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());
  const deviceIdRef = useRef('');
  const bookRef = useRef(book);
  const ttsGapStartedAtMonotonicRef = useRef<number | null>(null);

  const queuePersist = useCallback((
    draft: ReadingSessionDraft,
    endedAtClient: number,
    draftStorageKey?: string,
  ) => {
    const key = draftStorageKey ?? getReadingStatisticsDraftKey(
      draft.ownerKey,
      draft.deviceId,
      draft.bookId,
      draft.sessionId,
    );
    const session = toClosedSession(draft, endedAtClient);
    if (!session) {
      localStorage.removeItem(key);
      return;
    }
    persistChainRef.current = persistChainRef.current.then(async () => {
      await saveLocalReadingSessionV11(draft.ownerKey, session);
      try {
        const current = localStorage.getItem(key);
        if (!current) return;
        const parsed = JSON.parse(current) as unknown;
        if (isDraft(parsed) && parsed.sessionId === draft.sessionId) localStorage.removeItem(key);
      } catch {
        // A malformed draft will be ignored and replaced by the next segment.
      }
    }).catch((error) => {
      console.error('[ReadingStatistics] session persistence failed:', error);
    });
  }, []);

  const writeDraft = useCallback((segment: ActiveSegment) => {
    const deviceId = deviceIdRef.current;
    if (!deviceId) return;
    const currentBook = bookRef.current;
    const draft: ReadingSessionDraft = {
      schemaVersion: 1,
      ownerKey,
      bookId: currentBook.id,
      bookTitle: currentBook.name || '제목 없음',
      deviceId,
      state: 'active',
      ...segment,
    };
    try {
      localStorage.setItem(
        getReadingStatisticsDraftKey(ownerKey, deviceId, currentBook.id, segment.sessionId),
        JSON.stringify(draft),
      );
    } catch (error) {
      console.warn('[ReadingStatistics] draft checkpoint failed:', error);
    }
  }, [ownerKey]);

  const startSegment = useCallback((
    mode: ReadingSessionMode,
    startedAtClient: number,
    startedAtMonotonic = getMonotonicNow(),
  ) => {
    const progress = clampProgress(progressRef.current);
    const segment: ActiveSegment = {
      sessionId: crypto.randomUUID(),
      mode,
      startedAtClient,
      lastHeartbeatAt: startedAtClient,
      startProgressPercent: progress,
      endProgressPercent: progress,
      timezoneOffsetMinutes: new Date(startedAtClient).getTimezoneOffset(),
      startedAtMonotonic,
      ...(mode === 'tts' ? {
        activeIntervals: [],
        activeIntervalStartedAtClient: startedAtClient,
      } : {}),
      ...(() => {
        const clock = readReadingStatisticsClockSample(
          deviceIdRef.current,
          localStorage,
          startedAtClient,
        );
        return clock ? {
          clockOffsetMs: clock.offsetMs,
          clockUncertaintyMs: clock.uncertaintyMs,
          clockMeasuredAtClient: clock.measuredAtClient,
        } : {};
      })(),
    };
    activeSegmentRef.current = segment;
    writeDraft(segment);
  }, [writeDraft]);

  const closeSegment = useCallback((endedAtClient: number) => {
    const segment = activeSegmentRef.current;
    if (!segment) return;
    activeSegmentRef.current = null;
    const deviceId = deviceIdRef.current;
    if (!deviceId) return;
    const currentBook = bookRef.current;
    const draft: ReadingSessionDraft = {
      schemaVersion: 1,
      ownerKey,
      bookId: currentBook.id,
      bookTitle: currentBook.name || '제목 없음',
      deviceId,
      state: 'closed-pending',
      closedAtClient: endedAtClient,
      ...segment,
      endProgressPercent: clampProgress(progressRef.current),
    };
    // Close is journaled synchronously before the async IndexedDB chain. A new
    // segment uses a different key and therefore cannot overwrite this pending
    // commit after a rapid mode/page transition.
    try {
      localStorage.setItem(
        getReadingStatisticsDraftKey(ownerKey, deviceId, currentBook.id, segment.sessionId),
        JSON.stringify(draft),
      );
    } catch (error) {
      console.warn('[ReadingStatistics] closed draft checkpoint failed:', error);
    }
    queuePersist(draft, endedAtClient);
  }, [ownerKey, queuePersist]);

  const getDesiredMode = useCallback((now: number): ReadingSessionMode | null => {
    if (
      ttsTrackingPhaseRef.current === 'active-gap'
      && ttsGapStartedAtMonotonicRef.current !== null
      && activeSegmentRef.current?.mode === 'tts'
      && loadedRef.current
      && !suspendedRef.current
      && document.visibilityState === 'visible'
    ) return 'tts';
    return getReadingTrackingMode({
      isLoaded: loadedRef.current,
      suspended: suspendedRef.current,
      visibilityState: document.visibilityState,
      ttsTrackingPhase: ttsTrackingPhaseRef.current,
      hasFocus: document.hasFocus(),
      lastActivityAt: lastActivityAtRef.current,
      now,
    });
  }, []);

  const reconcile = useCallback(() => {
    const monotonicNow = getMonotonicNow();
    const desiredMode = getDesiredMode(monotonicNow);
    let segment = activeSegmentRef.current;
    if (segment && segment.mode !== desiredMode) {
      const endAtMonotonic = segment.mode === 'tts'
        && ttsGapStartedAtMonotonicRef.current !== null
        ? ttsGapStartedAtMonotonicRef.current
        : getReadingTrackingEndAt({
          mode: segment.mode,
          now: monotonicNow,
          lastActivityAt: lastActivityAtRef.current,
        });
      closeSegment(getSegmentWallTime(
        segment,
        Math.max(segment.startedAtMonotonic, endAtMonotonic),
      ));
      if (segment.mode === 'tts') {
        ttsGapStartedAtMonotonicRef.current = null;
      }
      segment = null;
    }
    if (!desiredMode) return;
    if (!segment) {
      startSegment(desiredMode, Date.now(), monotonicNow);
      segment = activeSegmentRef.current;
    }
    if (!segment) return;
    if (
      segment.mode === 'tts'
      && ttsTrackingPhaseRef.current === 'active-gap'
    ) return;
    const boundary = Math.min(
      segment.startedAtClient + READING_SESSION_MAX_DURATION_MS,
      getNextLocalMidnight(segment.startedAtClient, segment.timezoneOffsetMinutes),
    );
    const stableWallNow = getSegmentWallTime(segment, monotonicNow);
    if (stableWallNow >= boundary) {
      const boundaryMonotonic = segment.startedAtMonotonic
        + boundary - segment.startedAtClient;
      closeSegment(boundary);
      startSegment(desiredMode, boundary, boundaryMonotonic);
      segment = activeSegmentRef.current;
    }
    if (!segment) return;
    const updatedSegment = {
      ...segment,
      lastHeartbeatAt: getSegmentWallTime(segment, monotonicNow),
      endProgressPercent: clampProgress(progressRef.current),
    };
    activeSegmentRef.current = updatedSegment;
    writeDraft(updatedSegment);
  }, [closeSegment, getDesiredMode, startSegment, writeDraft]);

  const markActivity = useCallback(() => {
    lastActivityAtRef.current = getMonotonicNow();
    reconcile();
  }, [reconcile]);

  useEffect(() => {
    loadedRef.current = isLoaded;
    suspendedRef.current = suspended;
    const nextTtsTrackingPhase = getNextReadingTtsTrackingPhase(
      ttsTrackingPhaseRef.current,
      ttsStatus,
    );
    const previousTtsTrackingPhase = ttsTrackingPhaseRef.current;
    if (
      nextTtsTrackingPhase === 'active-gap'
      && previousTtsTrackingPhase === 'active-run'
      && activeSegmentRef.current?.mode === 'tts'
    ) {
      const gapStartedAt = getMonotonicNow();
      const segment = activeSegmentRef.current;
      if (
        segment?.mode === 'tts'
        && segment.activeIntervalStartedAtClient !== null
        && segment.activeIntervalStartedAtClient !== undefined
      ) {
        const intervalEnd = getSegmentWallTime(segment, gapStartedAt);
        const intervals = intervalEnd > segment.activeIntervalStartedAtClient
          ? [
            ...(segment.activeIntervals ?? []),
            {
              startedAtClient: segment.activeIntervalStartedAtClient,
              endedAtClient: intervalEnd,
            },
          ]
          : segment.activeIntervals ?? [];
        const updatedSegment = {
          ...segment,
          activeIntervals: intervals,
          activeIntervalStartedAtClient: null,
          lastHeartbeatAt: Math.max(segment.lastHeartbeatAt, intervalEnd),
        };
        activeSegmentRef.current = updatedSegment;
        writeDraft(updatedSegment);
        if (intervals.length >= READING_SESSION_MAX_ACTIVE_INTERVALS) {
          closeSegment(intervalEnd);
        }
      }
      ttsGapStartedAtMonotonicRef.current = gapStartedAt;
    } else if (nextTtsTrackingPhase === 'active-run') {
      const gapStartedAt = ttsGapStartedAtMonotonicRef.current;
      const segment = activeSegmentRef.current;
      if (gapStartedAt !== null && segment?.mode === 'tts') {
        const gapEndedAt = getMonotonicNow();
        const actualGapEndWallTime = getSegmentWallTime(segment, gapEndedAt);
        const boundary = Math.min(
          segment.startedAtClient + READING_SESSION_MAX_DURATION_MS,
          getNextLocalMidnight(segment.startedAtClient, segment.timezoneOffsetMinutes),
        );
        if (actualGapEndWallTime >= boundary) {
          closeSegment(getSegmentWallTime(segment, gapStartedAt));
        } else {
          const resumedSegment = {
            ...segment,
            activeIntervalStartedAtClient: actualGapEndWallTime,
          };
          activeSegmentRef.current = resumedSegment;
          writeDraft(resumedSegment);
        }
      }
      ttsGapStartedAtMonotonicRef.current = null;
    } else if (
      nextTtsTrackingPhase === 'inactive'
      || nextTtsTrackingPhase === 'paused'
      || nextTtsTrackingPhase === 'awaiting-first-start'
    ) {
      const gapStartedAt = ttsGapStartedAtMonotonicRef.current;
      if (gapStartedAt !== null) {
        const segment = activeSegmentRef.current;
        if (segment?.mode === 'tts') {
          closeSegment(getSegmentWallTime(
            segment,
            Math.max(segment.startedAtMonotonic, gapStartedAt),
          ));
        }
      }
      ttsGapStartedAtMonotonicRef.current = null;
    }
    if (
      nextTtsTrackingPhase === 'inactive'
      || nextTtsTrackingPhase === 'paused'
    ) {
      lastActivityAtRef.current = 0;
    }
    ttsTrackingPhaseRef.current = nextTtsTrackingPhase;
    progressRef.current = progressPercent;
    bookRef.current = book;
  }, [
    book,
    closeSegment,
    isLoaded,
    progressPercent,
    suspended,
    ttsStatus,
    writeDraft,
  ]);

  useEffect(() => {
    const deviceId = providedDeviceId?.trim() || getOrCreateDeviceId(localStorage);
    deviceIdRef.current = deviceId;
    lastActivityAtRef.current = 0;
    const prefix = getReadingStatisticsDraftPrefix(ownerKey, deviceId);
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith(prefix)));
    for (const key of keys) {
      try {
        const value = localStorage.getItem(key);
        if (!value) continue;
        const draft = JSON.parse(value) as unknown;
        if (!isDraft(draft) || draft.ownerKey !== ownerKey || draft.deviceId !== deviceId) {
          localStorage.removeItem(key);
          continue;
        }
        const recovered = toClosedSession(
          draft,
          getReadingStatisticsDraftRecoveryEnd(draft),
        );
        if (recovered) queuePersist(draft, recovered.endedAtClient, key);
        else localStorage.removeItem(key);
      } catch {
        localStorage.removeItem(key);
      }
    }
    reconcile();
    return () => {
      const segment = activeSegmentRef.current;
      const endAtMonotonic = segment?.mode === 'tts'
        && ttsGapStartedAtMonotonicRef.current !== null
        ? ttsGapStartedAtMonotonicRef.current
        : getMonotonicNow();
      ttsGapStartedAtMonotonicRef.current = null;
      closeSegment(segment ? getSegmentWallTime(segment, endAtMonotonic) : Date.now());
      deviceIdRef.current = '';
    };
  }, [
    closeSegment,
    ownerKey,
    providedDeviceId,
    queuePersist,
    reconcile,
  ]);

  useEffect(() => {
    reconcile();
  }, [isLoaded, reconcile, suspended, ttsStatus]);

  useEffect(() => {
    const handleBoundary = () => reconcile();
    const handlePageHide = () => {
      const segment = activeSegmentRef.current;
      const endAtMonotonic = segment?.mode === 'tts'
        && ttsGapStartedAtMonotonicRef.current !== null
        ? ttsGapStartedAtMonotonicRef.current
        : getMonotonicNow();
      ttsGapStartedAtMonotonicRef.current = null;
      closeSegment(segment ? getSegmentWallTime(segment, endAtMonotonic) : Date.now());
    };
    const handleReaderKey = (event: KeyboardEvent) => {
      if (
        !suspendedRef.current
        && ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', ' '].includes(event.key)
      ) markActivity();
    };
    window.addEventListener('blur', handleBoundary);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('keydown', handleReaderKey, { capture: true });
    document.addEventListener('visibilitychange', handleBoundary);
    const intervalId = window.setInterval(() => reconcile(), HEARTBEAT_MS);
    return () => {
      window.removeEventListener('blur', handleBoundary);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('keydown', handleReaderKey, { capture: true });
      document.removeEventListener('visibilitychange', handleBoundary);
      window.clearInterval(intervalId);
    };
  }, [closeSegment, markActivity, reconcile]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !isLoaded) return;
    const attached = new Map<ReadingActivityTarget, readonly string[]>();
    const eventNames: readonly string[] = [
      'pointerdown', 'keydown', 'wheel', 'touchstart',
    ];
    const attachCurrentContents = () => {
      const currentTargets = new Set<ReadingActivityTarget>([view]);
      for (const { doc } of view.renderer?.getContents?.() ?? []) {
        if (doc) currentTargets.add(doc);
      }
      reconcileReadingActivityTargets(attached, currentTargets, eventNames, markActivity);
    };
    attachCurrentContents();
    const intervalId = window.setInterval(attachCurrentContents, 1_000);
    return () => {
      window.clearInterval(intervalId);
      detachReadingActivityTargets(attached, markActivity);
    };
  }, [isLoaded, markActivity, viewRef]);

  return { markActivity };
};
