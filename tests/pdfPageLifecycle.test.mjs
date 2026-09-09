import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PDF_CANVAS_DIMENSION,
  MAX_PDF_CANVAS_PIXELS,
  cleanupPDFPageAfter,
  getPDFRenderMetrics,
} from '../public/foliate-js/pdf-page-lifecycle.js';

test('keeps ordinary PDF rendering at the requested device scale', () => {
  const metrics = getPDFRenderMetrics({
    width: 612,
    height: 792,
    zoom: 1.25,
    pixelRatio: 2,
  });

  assert.equal(metrics.renderScale, 2.5);
  assert.equal(metrics.displayScale, 0.5);
  assert.equal(metrics.canvasWidth, 1530);
  assert.equal(metrics.canvasHeight, 1980);
});

test('caps PDF canvas area while preserving its displayed size', () => {
  const metrics = getPDFRenderMetrics({
    width: 20_000,
    height: 20_000,
    zoom: 2,
    pixelRatio: 4,
  });

  assert.ok(metrics.canvasWidth * metrics.canvasHeight <= MAX_PDF_CANVAS_PIXELS);
  assert.ok(metrics.canvasWidth <= MAX_PDF_CANVAS_DIMENSION);
  assert.ok(metrics.canvasHeight <= MAX_PDF_CANVAS_DIMENSION);
  assert.ok(Math.abs(
    metrics.canvasWidth * metrics.displayScale - 40_000,
  ) < metrics.displayScale);
});

test('caps an extreme PDF page dimension independently of pixel area', () => {
  const metrics = getPDFRenderMetrics({
    width: 100_000,
    height: 10,
    zoom: 1,
    pixelRatio: 2,
  });

  assert.equal(metrics.canvasWidth, MAX_PDF_CANVAS_DIMENSION);
  assert.ok(metrics.canvasHeight >= 1);
  assert.ok(metrics.canvasWidth * metrics.canvasHeight <= MAX_PDF_CANVAS_PIXELS);
});

test('retries PDF page cleanup once after active rendering settles', async () => {
  let resolveIdle;
  const idle = new Promise((resolve) => {
    resolveIdle = resolve;
  });
  let cleanupCalls = 0;
  const page = {
    cleanup() {
      cleanupCalls += 1;
      return cleanupCalls > 1;
    },
  };

  const cleanup = cleanupPDFPageAfter(page, idle);
  assert.equal(cleanupCalls, 1);
  resolveIdle();

  assert.equal(await cleanup, true);
  assert.equal(cleanupCalls, 2);
});

test('does not wait when PDF page cleanup succeeds immediately', async () => {
  let cleanupCalls = 0;
  let idleRead = false;
  const idle = {
    then() {
      idleRead = true;
    },
  };
  const page = {
    cleanup() {
      cleanupCalls += 1;
      return true;
    },
  };

  assert.equal(await cleanupPDFPageAfter(page, idle), true);
  assert.equal(cleanupCalls, 1);
  assert.equal(idleRead, false);
});


test('PDF collection compatibility preserves cached undefined and computes each missing key once', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../public/foliate-js/pdfjs-compat.js', import.meta.url), 'utf8');
  const context = { assert };
  runInNewContext('delete Map.prototype.getOrInsertComputed; delete WeakMap.prototype.getOrInsertComputed;', context);
  runInNewContext(source, context);
  runInNewContext(`
    for (const Collection of [Map, WeakMap]) {
      const cache = new Collection();
      const key = {};
      let calls = 0;
      const compute = received => { assert.equal(received, key); calls++; return undefined; };
      assert.equal(cache.getOrInsertComputed(key, compute), undefined);
      assert.equal(cache.getOrInsertComputed(key, compute), undefined);
      assert.equal(calls, 1);
      assert.equal(cache.has(key), true);
      assert.equal(Object.getOwnPropertyDescriptor(Collection.prototype, 'getOrInsertComputed').enumerable, false);
      const failedKey = {};
      assert.throws(() => cache.getOrInsertComputed(failedKey, () => { throw new Error('failed'); }));
      assert.equal(cache.has(failedKey), false);
    }
    globalThis.mapMethod = Map.prototype.getOrInsertComputed;
    globalThis.weakMethod = WeakMap.prototype.getOrInsertComputed;
  `, context);
  runInNewContext(source, context);
  runInNewContext('assert.equal(Map.prototype.getOrInsertComputed, mapMethod); assert.equal(WeakMap.prototype.getOrInsertComputed, weakMethod);', context);
});
