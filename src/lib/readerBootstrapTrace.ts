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
};

const TRACE_STORAGE_KEY = 'reader_bootstrap_trace_v1';
const TRACE_LIMIT = 160;
const OPEN_PERFORMANCE_TRACE_LIMIT = 96;

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
