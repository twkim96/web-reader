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
