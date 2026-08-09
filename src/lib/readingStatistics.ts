import type { OwnerKey } from './ownerIdentity';

export const READING_SESSION_SCHEMA_VERSION = 1 as const;
export const READING_SESSION_MAX_DURATION_MS = 5 * 60_000;
export const READING_SESSION_IDLE_TIMEOUT_MS = 90_000;
export const READING_SESSION_MIN_DURATION_MS = 1_000;

export type ReadingSessionMode = 'screen' | 'tts';
export type ReadingSessionSyncState = 'pending' | 'synced';
export type ReadingTtsTrackingPhase =
  | 'inactive'
  | 'awaiting-first-start'
  | 'active-run'
  | 'active-gap'
  | 'paused';

export type ReadingSessionV1 = {
  schemaVersion: typeof READING_SESSION_SCHEMA_VERSION;
  sessionId: string;
  bookId: string;
  bookTitle: string;
  deviceId: string;
  mode: ReadingSessionMode;
  startedAtClient: number;
  endedAtClient: number;
  durationMs: number;
  startProgressPercent: number;
  endProgressPercent: number;
  timezoneOffsetMinutes: number;
  localDate: string;
  completed: boolean;
  clockOffsetMs?: number;
  clockUncertaintyMs?: number;
  clockMeasuredAtClient?: number;
};

export type StoredReadingSessionV11 = ReadingSessionV1 & {
  ownerKey: OwnerKey;
  syncState: ReadingSessionSyncState;
  retryCount: number;
  nextAttemptAt: number;
  lastErrorCode: string | null;
};

export type ReadingStatisticsRange = 'today' | 'week' | 'month' | 'all';

export type ReadingBookStatistics = {
  bookId: string;
  bookTitle: string;
  totalMs: number;
  screenMs: number;
  ttsMs: number;
  readDates: string[];
  startProgressPercent: number;
  endProgressPercent: number;
  completed: boolean;
};

export type ReadingDayStatistics = {
  localDate: string;
  totalMs: number;
  screenMs: number;
  ttsMs: number;
};

export type ReadingStatisticsSummary = {
  totalMs: number;
  screenMs: number;
  ttsMs: number;
  sourceSessionCount: number;
  countedSessionCount: number;
  completedBookCount: number;
  uncertainClockSessionCount: number;
  books: ReadingBookStatistics[];
  days: ReadingDayStatistics[];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isSafeTimestamp = (value: unknown): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
);

const isSafePercent = (value: unknown): value is number => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value >= 0
  && value <= 100
);

const isBoundedString = (value: unknown, maxLength: number) => (
  typeof value === 'string'
  && value.length > 0
  && value.length <= maxLength
);

export const getReadingSessionLocalDate = (
  timestamp: number,
  timezoneOffsetMinutes: number,
) => new Date(timestamp - timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);

export const isReadingSessionV1 = (value: unknown): value is ReadingSessionV1 => {
  if (!isPlainObject(value)) return false;
  if (value.schemaVersion !== READING_SESSION_SCHEMA_VERSION) return false;
  if (!isBoundedString(value.sessionId, 128) || String(value.sessionId).includes('/')) return false;
  if (!isBoundedString(value.bookId, 512)) return false;
  if (!isBoundedString(value.bookTitle, 1_000)) return false;
  if (!isBoundedString(value.deviceId, 128)) return false;
  if (value.mode !== 'screen' && value.mode !== 'tts') return false;
  if (!isSafeTimestamp(value.startedAtClient) || !isSafeTimestamp(value.endedAtClient)) return false;
  if (typeof value.durationMs !== 'number' || !Number.isSafeInteger(value.durationMs)) return false;
  if (
    value.durationMs < READING_SESSION_MIN_DURATION_MS
    || value.durationMs > READING_SESSION_MAX_DURATION_MS
    || value.endedAtClient - value.startedAtClient !== value.durationMs
  ) return false;
  if (!isSafePercent(value.startProgressPercent) || !isSafePercent(value.endProgressPercent)) {
    return false;
  }
  if (
    typeof value.timezoneOffsetMinutes !== 'number'
    || !Number.isInteger(value.timezoneOffsetMinutes)
    || value.timezoneOffsetMinutes < -840
    || value.timezoneOffsetMinutes > 840
  ) return false;
  if (
    typeof value.localDate !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.localDate)
    || value.localDate !== getReadingSessionLocalDate(
      Number(value.startedAtClient),
      Number(value.timezoneOffsetMinutes),
    )
  ) return false;
  if (typeof value.completed !== 'boolean') return false;
  const clockFields = [
    value.clockOffsetMs,
    value.clockUncertaintyMs,
    value.clockMeasuredAtClient,
  ];
  if (clockFields.every((field) => field === undefined)) return true;
  return Number.isSafeInteger(value.clockOffsetMs)
    && Math.abs(Number(value.clockOffsetMs)) <= 24 * 60 * 60_000
    && Number.isSafeInteger(value.clockUncertaintyMs)
    && Number(value.clockUncertaintyMs) >= 0
    && Number(value.clockUncertaintyMs) <= 5_000
    && isSafeTimestamp(value.clockMeasuredAtClient);
};

export const parseReadingSessionV1 = (value: unknown): ReadingSessionV1 => {
  if (!isReadingSessionV1(value)) throw new Error('독서 통계 session schema가 올바르지 않습니다.');
  return value;
};

export const toReadingSessionPayload = (
  session: ReadingSessionV1 | StoredReadingSessionV11,
): ReadingSessionV1 => ({
  schemaVersion: READING_SESSION_SCHEMA_VERSION,
  sessionId: session.sessionId,
  bookId: session.bookId,
  bookTitle: session.bookTitle,
  deviceId: session.deviceId,
  mode: session.mode,
  startedAtClient: session.startedAtClient,
  endedAtClient: session.endedAtClient,
  durationMs: session.durationMs,
  startProgressPercent: session.startProgressPercent,
  endProgressPercent: session.endProgressPercent,
  timezoneOffsetMinutes: session.timezoneOffsetMinutes,
  localDate: session.localDate,
  completed: session.completed,
  ...(session.clockOffsetMs !== undefined ? {
    clockOffsetMs: session.clockOffsetMs,
    clockUncertaintyMs: session.clockUncertaintyMs,
    clockMeasuredAtClient: session.clockMeasuredAtClient,
  } : {}),
});

export const sameReadingSessionPayload = (
  left: ReadingSessionV1,
  right: ReadingSessionV1,
) => JSON.stringify(toReadingSessionPayload(left)) === JSON.stringify(toReadingSessionPayload(right));

export const getReadingStatisticsRangeBounds = (
  range: ReadingStatisticsRange,
  now = Date.now(),
) => {
  if (range === 'all') {
    return { startAt: Number.NEGATIVE_INFINITY, endAt: Number.POSITIVE_INFINITY };
  }
  const current = new Date(now);
  // Stored segments are closed and bounded. Date ranges are defined by their
  // recorded local day, so a viewing device with a skewed wall clock must not
  // clip a corrected remote interval.
  const endAt = Number.POSITIVE_INFINITY;
  const endLocalDate = getReadingSessionLocalDate(now, current.getTimezoneOffset());
  if (range === 'today') {
    return {
      startAt: Number.NEGATIVE_INFINITY,
      endAt,
      startLocalDate: endLocalDate,
      endLocalDate,
    };
  }
  if (range === 'week') {
    const day = current.getDay();
    const daysFromMonday = day === 0 ? 6 : day - 1;
    const start = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate() - daysFromMonday,
    );
    return {
      startAt: Number.NEGATIVE_INFINITY,
      endAt,
      startLocalDate: getReadingSessionLocalDate(start.getTime(), start.getTimezoneOffset()),
      endLocalDate,
    };
  }
  const start = new Date(current.getFullYear(), current.getMonth(), 1);
  return {
    startAt: Number.NEGATIVE_INFINITY,
    endAt,
    startLocalDate: getReadingSessionLocalDate(start.getTime(), start.getTimezoneOffset()),
    endLocalDate,
  };
};

type CountedSlice = {
  session: ReadingSessionV1;
  startAt: number;
  endAt: number;
};

type PreparedSession = {
  session: ReadingSessionV1;
  startAt: number;
  endAt: number;
  clockTrusted: boolean;
  clockDomain: string;
};

const CLOCK_SAMPLE_MAX_AGE_MS = 24 * 60 * 60_000;

const getClockCorrection = (
  session: ReadingSessionV1,
  samplesByDevice: ReadonlyMap<string, ReadingSessionV1[]>,
) => {
  const candidates = samplesByDevice.get(session.deviceId) ?? [];
  let selected: ReadingSessionV1 | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const measuredAt = candidate.clockMeasuredAtClient;
    if (measuredAt === undefined) continue;
    const nextDistance = Math.abs(measuredAt - session.startedAtClient);
    if (nextDistance <= CLOCK_SAMPLE_MAX_AGE_MS && nextDistance < distance) {
      selected = candidate;
      distance = nextDistance;
    }
  }
  return selected?.clockOffsetMs;
};

const compareWinner = (left: PreparedSession, right: PreparedSession) => {
  const modeDifference = Number(right.session.mode === 'tts') - Number(left.session.mode === 'tts');
  return modeDifference || left.session.sessionId.localeCompare(right.session.sessionId);
};

const heapPush = (heap: PreparedSession[], value: PreparedSession) => {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareWinner(heap[parent], value) <= 0) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = value;
};

const heapPop = (heap: PreparedSession[]) => {
  const root = heap[0];
  const tail = heap.pop();
  if (heap.length === 0 || !tail) return root;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && compareWinner(heap[right], heap[left]) < 0
      ? right
      : left;
    if (compareWinner(tail, heap[child]) <= 0) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = tail;
  return root;
};

const buildDomainTimeline = (sessions: readonly PreparedSession[]): CountedSlice[] => {
  const events = sessions.flatMap((prepared) => [
    { at: prepared.startAt, kind: 'start' as const, prepared },
    { at: prepared.endAt, kind: 'end' as const, prepared },
  ]).sort((left, right) => (
    left.at - right.at
    || Number(left.kind === 'start') - Number(right.kind === 'start')
    || left.prepared.session.sessionId.localeCompare(right.prepared.session.sessionId)
  ));
  const active = new Set<PreparedSession>();
  const heap: PreparedSession[] = [];
  const slices: CountedSlice[] = [];
  let previousAt: number | null = null;
  let index = 0;
  while (index < events.length) {
    const at = events[index].at;
    while (heap[0] && !active.has(heap[0])) heapPop(heap);
    const winner = heap[0];
    if (winner && previousAt !== null && at > previousAt) {
      const previous = slices.at(-1);
      if (previous?.session.sessionId === winner.session.sessionId && previous.endAt === previousAt) {
        previous.endAt = at;
      } else {
        slices.push({ session: winner.session, startAt: previousAt, endAt: at });
      }
    }
    while (index < events.length && events[index].at === at && events[index].kind === 'end') {
      active.delete(events[index].prepared);
      index += 1;
    }
    while (index < events.length && events[index].at === at) {
      const prepared = events[index].prepared;
      active.add(prepared);
      heapPush(heap, prepared);
      index += 1;
    }
    previousAt = at;
  }
  return slices;
};

const splitSliceAtLocalMidnights = (slice: CountedSlice): CountedSlice[] => {
  const parts: CountedSlice[] = [];
  let startAt = slice.startAt;
  while (startAt < slice.endAt) {
    const localTimestamp = startAt - slice.session.timezoneOffsetMinutes * 60_000;
    const nextLocalDay = (Math.floor(localTimestamp / 86_400_000) + 1) * 86_400_000;
    const midnightAt = nextLocalDay + slice.session.timezoneOffsetMinutes * 60_000;
    const endAt = Math.min(slice.endAt, midnightAt);
    if (endAt <= startAt) break;
    parts.push({ ...slice, startAt, endAt });
    startAt = endAt;
  }
  return parts;
};

const isLocalDateWithinBounds = (
  localDate: string,
  bounds: { startLocalDate?: string; endLocalDate?: string },
) => (
  (!bounds.startLocalDate || localDate >= bounds.startLocalDate)
  && (!bounds.endLocalDate || localDate <= bounds.endLocalDate)
);

const preparedTouchesLocalDateBounds = (
  prepared: PreparedSession,
  bounds: { startLocalDate?: string; endLocalDate?: string },
) => splitSliceAtLocalMidnights({
  session: prepared.session,
  startAt: prepared.startAt,
  endAt: prepared.endAt,
}).some((slice) => isLocalDateWithinBounds(
  getReadingSessionLocalDate(slice.startAt, slice.session.timezoneOffsetMinutes),
  bounds,
));

export const buildReadingStatistics = (
  sessions: readonly ReadingSessionV1[],
  bounds: {
    startAt?: number;
    endAt?: number;
    startLocalDate?: string;
    endLocalDate?: string;
  } = {},
): ReadingStatisticsSummary => {
  const startAt = bounds.startAt ?? Number.NEGATIVE_INFINITY;
  const endAt = bounds.endAt ?? Number.POSITIVE_INFINITY;
  const candidates = sessions.filter(isReadingSessionV1).filter((session) => (
    session.endedAtClient > startAt && session.startedAtClient < endAt
  ));
  const samplesByDevice = new Map<string, ReadingSessionV1[]>();
  for (const session of candidates) {
    if (session.clockOffsetMs === undefined || session.clockMeasuredAtClient === undefined) continue;
    const samples = samplesByDevice.get(session.deviceId) ?? [];
    samples.push(session);
    samplesByDevice.set(session.deviceId, samples);
  }
  const prepared = candidates.flatMap((session): PreparedSession[] => {
    const correction = getClockCorrection(session, samplesByDevice);
    const clockTrusted = correction !== undefined;
    const correctedStart = session.startedAtClient + (correction ?? 0);
    const clippedStart = Math.max(startAt, correctedStart);
    const clippedEnd = Math.min(endAt, correctedStart + session.durationMs);
    if (clippedEnd <= clippedStart) return [];
    return [{
      session,
      startAt: clippedStart,
      endAt: clippedEnd,
      clockTrusted,
      // Uncalibrated devices remain separate clock domains. This avoids
      // silently deleting sequential reading because two wall clocks happen to
      // overlap; the summary exposes that cross-device dedup is uncertain.
      clockDomain: clockTrusted ? 'trusted-server-clock' : `device:${session.deviceId}`,
    }];
  });
  const byClockDomain = new Map<string, PreparedSession[]>();
  for (const item of prepared) {
    const domain = byClockDomain.get(item.clockDomain) ?? [];
    domain.push(item);
    byClockDomain.set(item.clockDomain, domain);
  }
  const slices = [...byClockDomain.values()]
    .flatMap(buildDomainTimeline)
    .flatMap(splitSliceAtLocalMidnights)
    .filter((slice) => {
      const localDate = getReadingSessionLocalDate(
        slice.startAt,
        slice.session.timezoneOffsetMinutes,
      );
      return isLocalDateWithinBounds(localDate, bounds);
    });
  const validPrepared = prepared.filter((item) => preparedTouchesLocalDateBounds(item, bounds));
  const valid = validPrepared.map(({ session }) => session);

  const books = new Map<string, ReadingBookStatistics>();
  const bookTimelines = new Map<string, { firstAt: number; lastAt: number }>();
  const days = new Map<string, ReadingDayStatistics>();
  const countedSessionIds = new Set<string>();
  let totalMs = 0;
  let screenMs = 0;
  let ttsMs = 0;

  // Progress, completion and reading dates are facts, not time allocation.
  // Preserve them even when another device/mode wins every overlapping slice.
  for (const preparedSession of validPrepared) {
    const { session } = preparedSession;
    const existingBook = books.get(session.bookId) ?? {
      bookId: session.bookId,
      bookTitle: session.bookTitle,
      totalMs: 0,
      screenMs: 0,
      ttsMs: 0,
      readDates: [],
      startProgressPercent: session.startProgressPercent,
      endProgressPercent: session.endProgressPercent,
      completed: false,
    };
    const timeline = bookTimelines.get(session.bookId) ?? {
      firstAt: preparedSession.startAt,
      lastAt: preparedSession.endAt,
    };
    const readDates = splitSliceAtLocalMidnights({
      session,
      startAt: preparedSession.startAt,
      endAt: preparedSession.endAt,
    }).map((slice) => getReadingSessionLocalDate(
      slice.startAt,
      session.timezoneOffsetMinutes,
    )).filter((localDate) => isLocalDateWithinBounds(localDate, bounds));
    for (const localDate of readDates) {
      if (!existingBook.readDates.includes(localDate)) existingBook.readDates.push(localDate);
    }
    if (preparedSession.startAt < timeline.firstAt) {
      timeline.firstAt = preparedSession.startAt;
      existingBook.startProgressPercent = session.startProgressPercent;
    }
    if (preparedSession.endAt > timeline.lastAt) {
      timeline.lastAt = preparedSession.endAt;
      existingBook.endProgressPercent = session.endProgressPercent;
      existingBook.bookTitle = session.bookTitle;
    }
    existingBook.completed ||= session.completed;
    books.set(session.bookId, existingBook);
    bookTimelines.set(session.bookId, timeline);
  }

  for (const slice of slices) {
    const durationMs = slice.endAt - slice.startAt;
    const { session } = slice;
    countedSessionIds.add(session.sessionId);
    totalMs += durationMs;
    if (session.mode === 'tts') ttsMs += durationMs;
    else screenMs += durationMs;

    const existingBook = books.get(session.bookId);
    if (!existingBook) continue;
    existingBook.totalMs += durationMs;
    if (session.mode === 'tts') existingBook.ttsMs += durationMs;
    else existingBook.screenMs += durationMs;
    books.set(session.bookId, existingBook);

    const sliceLocalDate = getReadingSessionLocalDate(
      slice.startAt,
      session.timezoneOffsetMinutes,
    );
    const existingDay = days.get(sliceLocalDate) ?? {
      localDate: sliceLocalDate,
      totalMs: 0,
      screenMs: 0,
      ttsMs: 0,
    };
    existingDay.totalMs += durationMs;
    if (session.mode === 'tts') existingDay.ttsMs += durationMs;
    else existingDay.screenMs += durationMs;
    days.set(sliceLocalDate, existingDay);
  }

  const bookRows = [...books.values()].map((book) => ({
    ...book,
    readDates: [...book.readDates].sort(),
  })).sort((left, right) => right.totalMs - left.totalMs || (
    left.bookTitle.localeCompare(right.bookTitle, 'ko')
  ));

  return {
    totalMs,
    screenMs,
    ttsMs,
    sourceSessionCount: valid.length,
    countedSessionCount: countedSessionIds.size,
    completedBookCount: bookRows.filter(({ completed }) => completed).length,
    uncertainClockSessionCount: validPrepared.filter(({ clockTrusted }) => !clockTrusted).length,
    books: bookRows,
    days: [...days.values()].sort((left, right) => (
      right.localDate.localeCompare(left.localDate)
    )),
  };
};

export const formatReadingDuration = (durationMs: number) => {
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  if (minutes > 0) return `${minutes}분`;
  return durationMs > 0 ? '1분 미만' : '0분';
};

export const getReadingTrackingMode = ({
  isLoaded,
  suspended,
  visibilityState,
  ttsTrackingPhase,
  hasFocus,
  lastActivityAt,
  now,
}: {
  isLoaded: boolean;
  suspended: boolean;
  visibilityState: DocumentVisibilityState;
  ttsTrackingPhase: ReadingTtsTrackingPhase;
  hasFocus: boolean;
  lastActivityAt: number;
  now: number;
}): ReadingSessionMode | null => {
  if (!isLoaded || suspended || visibilityState !== 'visible') return null;
  if (ttsTrackingPhase === 'active-run') return 'tts';
  if (ttsTrackingPhase !== 'inactive') return null;
  if (
    !hasFocus
    || lastActivityAt <= 0
    || now - lastActivityAt > READING_SESSION_IDLE_TIMEOUT_MS
  ) return null;
  return 'screen';
};

export const getNextReadingTtsTrackingPhase = (
  previous: ReadingTtsTrackingPhase,
  status: string,
): ReadingTtsTrackingPhase => {
  if (status === 'playing') return 'active-run';
  if (status === 'starting' || status === 'loading') {
    return previous === 'active-run' || previous === 'active-gap'
      ? 'active-gap'
      : 'awaiting-first-start';
  }
  if (status === 'paused') return 'paused';
  return 'inactive';
};

export const getReadingTrackingEndAt = ({
  mode,
  now,
  lastActivityAt,
}: {
  mode: ReadingSessionMode;
  now: number;
  lastActivityAt: number;
}) => mode === 'screen'
  ? Math.min(now, lastActivityAt + READING_SESSION_IDLE_TIMEOUT_MS)
  : now;
