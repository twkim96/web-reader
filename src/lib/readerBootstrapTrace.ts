export type ReaderBootstrapTraceEvent = {
  at: number;
  event:
    | 'listener-attached'
    | 'authoritative-snapshot'
    | 'listener-reconciled'
    | 'remote-decision'
    | 'remote-navigation-result'
    | 'font-ready'
    | 'style-applied'
    | 'layout-applied'
    | 'relocate';
  listener?: 'progress' | 'bookmark' | 'annotation' | 'palette';
  identityHash?: string;
  revision?: number;
  decision?: string;
  status?: string;
  page?: number;
  pages?: number;
  viewportWidth?: number;
  viewportHeight?: number;
};

export type ReaderOpenPerformanceEvent = {
  at: number;
  phase: string;
  durationMs?: number;
  sizeBytes?: number;
  entryCount?: number;
  sectionCount?: number;
  tocCount?: number;
  sectionIndex?: number;
  sectionSize?: number;
  status?: string;
  targetHash?: string;
  actualPage?: number;
  actualPages?: number;
  targetRectCount?: number;
  bookHash?: string;
  anchorHash?: string;
  expectedPercent?: number;
  actualPercent?: number;
};

const TRACE_STORAGE_KEY = 'reader_bootstrap_trace_v1';
const READER_RESUME_FAILURES_STORAGE_KEY = 'reader_resume_failures_v1';
const TRACE_LIMIT = 160;
const OPEN_PERFORMANCE_TRACE_LIMIT = 96;
const READER_RESUME_FAILURES_LIMIT = 8;
const READER_RESUME_FAILURES_MAX_LENGTH = 8192;

export type ReaderResumeFailureEvent = {
  at: number;
  status: 'recovered' | 'failed';
  attempts: number;
  targetHash?: string;
  actualPage?: number;
  actualPages?: number;
  targetRectCount?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  expectedPercent?: number;
  actualPercent?: number;
  reason?: 'missing-geometry' | 'navigation-rejected' | 'target-not-visible' | 'progress-mismatch';
};

export type ReaderResumeFailureInput = Omit<ReaderResumeFailureEvent, 'at'>;

type TraceWindow = Window & {
  __readerBootstrapTrace?: ReaderBootstrapTraceEvent[];
  __readerOpenPerformanceTrace?: ReaderOpenPerformanceEvent[];
};

const isTraceEnabled = () => {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('readerDebug') === '1') return true;
    return window.localStorage.getItem(TRACE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

export const hashReaderTraceValue = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const traceReaderBootstrap = (
  event: Omit<ReaderBootstrapTraceEvent, 'at'>,
) => {
  if (!isTraceEnabled()) return;
  const traceWindow = window as TraceWindow;
  const buffer = traceWindow.__readerBootstrapTrace ?? [];
  buffer.push({ at: Date.now(), ...event });
  if (buffer.length > TRACE_LIMIT) buffer.splice(0, buffer.length - TRACE_LIMIT);
  traceWindow.__readerBootstrapTrace = buffer;
};

export const readReaderBootstrapTrace = (): ReaderBootstrapTraceEvent[] => {
  if (typeof window === 'undefined') return [];
  const buffer = (window as TraceWindow).__readerBootstrapTrace;
  return Array.isArray(buffer) ? buffer.map((event) => ({ ...event })) : [];
};

// Reader-open timings are always kept in a small in-memory buffer so an iPad
// user can export them after reproducing a slow cold open without first
// enabling a hidden debug flag. The events intentionally contain only phase
// names, durations, counts and byte sizes; no book title, CFI or user identity.
export const traceReaderOpenPerformance = (
  event: Omit<ReaderOpenPerformanceEvent, 'at'>,
) => {
  if (typeof window === 'undefined') return;
  const traceWindow = window as TraceWindow;
  const buffer = traceWindow.__readerOpenPerformanceTrace ?? [];
  buffer.push({ at: Date.now(), ...event });
  if (buffer.length > OPEN_PERFORMANCE_TRACE_LIMIT) {
    buffer.splice(0, buffer.length - OPEN_PERFORMANCE_TRACE_LIMIT);
  }
  traceWindow.__readerOpenPerformanceTrace = buffer;
};

export const readReaderOpenPerformanceTrace = (): ReaderOpenPerformanceEvent[] => {
  if (typeof window === 'undefined') return [];
  const buffer = (window as TraceWindow).__readerOpenPerformanceTrace;
  return Array.isArray(buffer) ? buffer.map((event) => ({ ...event })) : [];
};

const sanitizeResumeFailureEvent = (value: unknown): ReaderResumeFailureEvent | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (
    (event.status !== 'recovered' && event.status !== 'failed')
    || typeof event.at !== 'number'
    || !Number.isFinite(event.at)
    || event.at < 0
    || typeof event.attempts !== 'number'
    || !Number.isFinite(event.attempts)
    || event.attempts < 0
  ) return null;

  const sanitized: ReaderResumeFailureEvent = {
    at: Math.floor(event.at),
    status: event.status,
    attempts: Math.min(1_000_000, Math.floor(event.attempts)),
  };
  if (typeof event.targetHash === 'string' && /^[a-f0-9]{8}$/i.test(event.targetHash)) {
    sanitized.targetHash = event.targetHash.toLowerCase();
  }
  for (const key of ['actualPage', 'actualPages', 'targetRectCount', 'viewportWidth', 'viewportHeight'] as const) {
    const field = event[key];
    if (typeof field === 'number' && Number.isFinite(field) && field >= 0) {
      sanitized[key] = Math.min(1_000_000, key.startsWith('viewport') ? field : Math.floor(field));
    }
  }
  for (const key of ['expectedPercent', 'actualPercent'] as const) {
    const field = event[key];
    if (typeof field === 'number' && Number.isFinite(field) && field >= 0 && field <= 100) {
      sanitized[key] = field;
    }
  }
  if (
    event.reason === 'missing-geometry'
    || event.reason === 'navigation-rejected'
    || event.reason === 'target-not-visible'
    || event.reason === 'progress-mismatch'
  ) {
    sanitized.reason = event.reason;
  }
  return sanitized;
};

export const readReaderResumeFailures = (): ReaderResumeFailureEvent[] => {
  if (typeof window === 'undefined') return [];
  try {
    const serialized = window.localStorage.getItem(READER_RESUME_FAILURES_STORAGE_KEY);
    if (!serialized || serialized.length > READER_RESUME_FAILURES_MAX_LENGTH) return [];
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(sanitizeResumeFailureEvent)
      .filter((event): event is ReaderResumeFailureEvent => event !== null)
      .slice(-READER_RESUME_FAILURES_LIMIT);
  } catch {
    return [];
  }
};

export const recordReaderResumeFailure = (event: ReaderResumeFailureInput) => {
  if (typeof window === 'undefined') return;
  try {
    const sanitized = sanitizeResumeFailureEvent({ ...event, at: Date.now() });
    if (!sanitized) return;
    const records = [...readReaderResumeFailures(), sanitized].slice(-READER_RESUME_FAILURES_LIMIT);
    const serialized = JSON.stringify(records);
    if (serialized.length > READER_RESUME_FAILURES_MAX_LENGTH) return;
    window.localStorage.setItem(READER_RESUME_FAILURES_STORAGE_KEY, serialized);
  } catch {
    // Diagnostics must never interfere with opening or reading a book.
  }
};
