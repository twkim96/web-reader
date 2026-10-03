import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hashReaderTraceValue,
  readReaderBootstrapTrace,
  readReaderOpenPerformanceTrace,
  readReaderResumeFailures,
  recordReaderResumeFailure,
  traceReaderBootstrap,
  traceReaderOpenPerformance,
} from '../src/lib/readerBootstrapTrace.ts';

const installWindow = ({ enabled = true, storage = new Map() } = {}) => {
  if (enabled && !storage.has('reader_bootstrap_trace_v1')) storage.set('reader_bootstrap_trace_v1', '1');
  globalThis.window = {
    location: { search: '' },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  };
};

test.afterEach(() => {
  delete globalThis.window;
});

test('keeps a bounded debug-only bootstrap trace without exposing raw identity values', () => {
  installWindow();
  const rawIdentity = 'epubcfi(/6/4!/4/2:0):private-event-id';
  const identityHash = hashReaderTraceValue(rawIdentity);
  assert.notEqual(identityHash, rawIdentity);

  for (let index = 0; index < 170; index += 1) {
    traceReaderBootstrap({
      event: 'remote-navigation-result',
      identityHash,
      revision: index + 1,
      status: 'navigated',
    });
  }
  const trace = readReaderBootstrapTrace();
  assert.equal(trace.length, 160);
  assert.equal(trace[0].revision, 11);
  assert.equal(trace.at(-1).revision, 170);
  assert.equal(JSON.stringify(trace).includes(rawIdentity), false);
});

test('does not allocate trace data unless the debug flag is enabled', () => {
  installWindow({ enabled: false });
  traceReaderBootstrap({ event: 'listener-attached', listener: 'progress' });
  assert.deepEqual(readReaderBootstrapTrace(), []);
  assert.equal(window.__readerBootstrapTrace, undefined);
});

test('always keeps a bounded reader-open performance trace without private location data', () => {
  installWindow({ enabled: false });
  for (let index = 0; index < 100; index += 1) {
    traceReaderOpenPerformance({
      phase: 'foliate-section-load',
      durationMs: index,
      sectionIndex: index,
      sectionSize: 30_000,
    });
  }
  const trace = readReaderOpenPerformanceTrace();
  assert.equal(trace.length, 96);
  assert.equal(trace[0].sectionIndex, 4);
  assert.equal(trace.at(-1).durationMs, 99);
  assert.equal('cfi' in trace.at(-1), false);
  assert.equal(window.__readerBootstrapTrace, undefined);
});

test('persists only compact resume failure records across windows and keeps the latest eight', () => {
  const storage = new Map();
  installWindow({ storage });
  for (let attempts = 1; attempts <= 10; attempts += 1) {
    recordReaderResumeFailure({
      status: attempts === 10 ? 'recovered' : 'failed',
      attempts,
      targetHash: '0123abcd',
      actualPage: attempts,
      actualPages: 20,
      targetRectCount: 2,
      viewportWidth: 1024,
      viewportHeight: 768,
      reason: 'navigation-rejected',
      bookId: 'private-book-id',
      bookTitle: 'private title',
      cfi: 'epubcfi(/6/4!/4/2:0)',
    });
  }

  installWindow({ storage });
  const records = readReaderResumeFailures();
  assert.equal(records.length, 8);
  assert.equal(records[0].attempts, 3);
  assert.equal(records.at(-1).status, 'recovered');
  assert.equal(records.at(-1).targetHash, '0123abcd');
  assert.deepEqual(
    Object.keys(records.at(-1)).sort(),
    ['actualPage', 'actualPages', 'at', 'attempts', 'reason', 'status', 'targetHash', 'targetRectCount', 'viewportHeight', 'viewportWidth'].sort(),
  );
  const serialized = storage.get('reader_resume_failures_v1');
  assert.ok(serialized.length <= 8192);
  assert.equal(serialized.includes('private-book-id'), false);
  assert.equal(serialized.includes('private title'), false);
  assert.equal(serialized.includes('epubcfi'), false);
});

test('ignores corrupt or oversized resume records and tolerates unavailable storage', () => {
  const storage = new Map([['reader_resume_failures_v1', '{not json']]);
  installWindow({ storage });
  assert.deepEqual(readReaderResumeFailures(), []);
  recordReaderResumeFailure({ status: 'failed', attempts: 1 });
  assert.equal(readReaderResumeFailures().length, 1);

  storage.set('reader_resume_failures_v1', ' '.repeat(8193));
  assert.deepEqual(readReaderResumeFailures(), []);

  globalThis.window = {
    get localStorage() {
      throw new Error('storage disabled');
    },
  };
  assert.deepEqual(readReaderResumeFailures(), []);
  assert.doesNotThrow(() => recordReaderResumeFailure({ status: 'failed', attempts: 1 }));

  globalThis.window = {
    localStorage: {
      getItem: () => null,
      setItem: () => { throw new Error('storage quota exceeded'); },
    },
  };
  assert.doesNotThrow(() => recordReaderResumeFailure({ status: 'failed', attempts: 1 }));
});

test('sanitizes persisted resume records before returning them', () => {
  const storage = new Map([[
    'reader_resume_failures_v1',
    JSON.stringify([{
      at: 123,
      status: 'failed',
      attempts: 2,
      targetHash: 'not-a-safe-hash',
      actualPage: 4,
      reason: 'navigation-rejected',
      bookId: 'private-book-id',
      title: 'private title',
      cfi: 'epubcfi(/6/4!/4/2:0)',
    }]),
  ]]);
  installWindow({ storage });

  const records = readReaderResumeFailures();
  assert.deepEqual(records, [{ at: 123, status: 'failed', attempts: 2, actualPage: 4, reason: 'navigation-rejected' }]);
  assert.equal(JSON.stringify(records).includes('private-book-id'), false);
  assert.equal(JSON.stringify(records).includes('epubcfi'), false);
});
