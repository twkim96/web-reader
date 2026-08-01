import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isQuietReaderResumeEligible,
  isReaderProgressPersistenceSettled,
  updatePersistableReaderLocation,
} from '../src/hooks/reader/progress.ts';

test('force-save baseline ignores selection relocates and follows normal relocates', () => {
  const positionA = {
    cfi: 'epubcfi(/6/2[A])',
    anchorCfi: 'epubcfi(/6/2[A])',
    percent: 10,
  };

  const afterSelectionB = updatePersistableReaderLocation(positionA, {
    cfi: 'epubcfi(/6/4[B])',
    anchorCfi: 'epubcfi(/6/4[B])',
    progressPercent: 20,
    reason: 'selection-page',
  }, 20);
  assert.equal(afterSelectionB, positionA);

  const afterNormalC = updatePersistableReaderLocation(afterSelectionB, {
    cfi: 'epubcfi(/6/6[C])',
    anchorCfi: 'epubcfi(/6/6[C])',
    progressPercent: 30,
    reason: 'page',
  }, 30);
  assert.deepEqual(afterNormalC, {
    cfi: 'epubcfi(/6/6[C])',
    anchorCfi: 'epubcfi(/6/6[C])',
    percent: 30,
  });
});

test('initial and remote-jump relocates refresh the force-save baseline before save gating', () => {
  const empty = { cfi: '', anchorCfi: '', percent: 0 };
  assert.deepEqual(updatePersistableReaderLocation(empty, {
    cfi: 'epubcfi(/6/2[start])',
    fraction: 0.125,
  }, 0), {
    cfi: 'epubcfi(/6/2[start])',
    anchorCfi: 'epubcfi(/6/2[start])',
    percent: 12.5,
  });
});

test('separates startup quiet resume from a settled active-reader save state', () => {
  const settledAfterInteraction = {
    hasUserInteracted: true,
    hasUnsavedUserChange: false,
    hasPendingRelocateSave: false,
    inFlightCommitCount: 0,
  };
  assert.equal(isQuietReaderResumeEligible(settledAfterInteraction), false);
  assert.equal(isReaderProgressPersistenceSettled(settledAfterInteraction), true);

  for (const unsettled of [
    { ...settledAfterInteraction, hasUnsavedUserChange: true },
    { ...settledAfterInteraction, hasPendingRelocateSave: true },
    { ...settledAfterInteraction, inFlightCommitCount: 1 },
  ]) {
    assert.equal(isReaderProgressPersistenceSettled(unsettled), false);
  }
});
