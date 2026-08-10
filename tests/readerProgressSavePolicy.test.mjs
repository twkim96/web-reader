import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isQuietReaderResumeEligible,
  isReaderProgressPersistenceSettled,
  startPendingReaderProgressCommitForTtsFence,
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

  const afterTtsNavigation = updatePersistableReaderLocation(positionA, {
    cfi: 'epubcfi(/6/5[tts])',
    anchorCfi: 'epubcfi(/6/5[tts])',
    progressPercent: 25,
    reason: 'tts-navigation',
  }, 25);
  assert.equal(afterTtsNavigation, positionA);

  const afterDerivedTtsAnchor = updatePersistableReaderLocation(positionA, {
    cfi: 'epubcfi(/6/5[tts-anchor])',
    anchorCfi: 'epubcfi(/6/5[tts-anchor])',
    progressPercent: 26,
    reason: 'anchor',
    navigationSource: 'tts',
  }, 26);
  assert.equal(afterDerivedTtsAnchor, positionA);

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

test('freezes every relocate while the TTS progress fence is active', () => {
  const current = {
    cfi: 'epubcfi(/6/2[before])',
    anchorCfi: 'epubcfi(/6/2[before])',
    percent: 12,
  };
  assert.equal(updatePersistableReaderLocation(current, {
    cfi: 'epubcfi(/6/4[unmarked-follow-up])',
    progressPercent: 75,
    reason: 'anchor',
  }, 75, true), current);
  assert.deepEqual(updatePersistableReaderLocation(current, {
    cfi: 'epubcfi(/6/6[user])',
    progressPercent: 80,
    reason: 'page',
  }, 80, false), {
    cfi: 'epubcfi(/6/6[user])',
    anchorCfi: 'epubcfi(/6/6[user])',
    percent: 80,
  });
});

test('commits the captured user relocate once when the TTS fence starts', async () => {
  const pendingUserLocation = {
    cfi: 'epubcfi(/6/4[user-before-tts])',
    percent: 40,
  };
  const committed = [];
  let releaseCommit;
  const firstCommit = startPendingReaderProgressCommitForTtsFence(
    pendingUserLocation,
    null,
    async (snapshot) => {
      committed.push(snapshot);
      await new Promise((resolve) => { releaseCommit = resolve; });
      return true;
    },
  );
  const repeatedFence = startPendingReaderProgressCommitForTtsFence(
    { cfi: 'epubcfi(/6/6[tts])', percent: 60 },
    firstCommit,
    async (snapshot) => {
      committed.push(snapshot);
      return true;
    },
  );

  assert.equal(repeatedFence, firstCommit);
  assert.deepEqual(committed, [pendingUserLocation]);
  releaseCommit();
  assert.equal(await firstCommit, true);
});

test('does not start a TTS fence commit without a pending user relocate', () => {
  assert.equal(startPendingReaderProgressCommitForTtsFence(
    null,
    null,
    () => true,
  ), null);
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
