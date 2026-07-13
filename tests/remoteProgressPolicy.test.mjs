import test from 'node:test';
import assert from 'node:assert/strict';

import { decideRemoteProgressAction } from '../src/hooks/reader/remoteProgressPolicy.ts';

const decide = (overrides = {}) => decideRemoteProgressAction({
  isInitialSync: false,
  remoteAnchorCfi: 'remote-cfi',
  currentAnchorCfi: 'current-cfi',
  remoteTime: 200,
  lastSaveTime: 100,
  remotePercent: 50,
  currentPercent: 10,
  isQuietResumeEligible: true,
  ...overrides,
});

test('silently jumps to a newer remote position on the first sync', () => {
  assert.equal(decide({ isInitialSync: true }), 'jump');
});

test('does not silently override the user or a pending local save on first sync', () => {
  assert.equal(decide({
    isInitialSync: true,
    isQuietResumeEligible: false,
  }), 'prompt');
});

test('prompts for a meaningful newer remote update after initial sync', () => {
  assert.equal(decide(), 'prompt');
});

test('ignores a negligible remote movement after initial sync', () => {
  assert.equal(decide({ remotePercent: 10.02 }), 'ignore');
});

test('ignores equal positions and non-newer remote updates', () => {
  assert.equal(decide({ currentAnchorCfi: 'remote-cfi' }), 'ignore');
  assert.equal(decide({ remoteTime: 100 }), 'ignore');
});
