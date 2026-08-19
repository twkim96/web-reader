import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hashReaderTraceValue,
  readReaderBootstrapTrace,
  readReaderOpenPerformanceTrace,
  traceReaderBootstrap,
  traceReaderOpenPerformance,
} from '../src/lib/readerBootstrapTrace.ts';

const installWindow = ({ enabled = true } = {}) => {
  const storage = new Map(enabled ? [['reader_bootstrap_trace_v1', '1']] : []);
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
