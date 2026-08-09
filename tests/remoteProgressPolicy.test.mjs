import test from 'node:test';
import assert from 'node:assert/strict';

import { decideRemoteProgressAction } from '../src/hooks/reader/remoteProgressPolicy.ts';
import { executeRemoteProgressJump } from '../src/hooks/reader/remoteProgressJump.ts';

const decide = (overrides = {}) => decideRemoteProgressAction({
  isInitialSync: false,
  operation: 'set',
  hasLocalProgress: true,
  remoteAnchorCfi: 'remote-cfi',
  currentAnchorCfi: 'current-cfi',
  remoteTime: 200,
  lastSaveTime: 100,
  remotePercent: 50,
  currentPercent: 10,
  isQuietResumeEligible: true,
  remoteRevision: undefined,
  localRevision: undefined,
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

test('prefers comparable revisions over skewed timestamps', () => {
  assert.equal(decide({
    isInitialSync: true,
    remoteRevision: 4,
    localRevision: 3,
    remoteTime: 1,
    lastSaveTime: 999_999,
  }), 'jump');
  assert.equal(decide({
    remoteRevision: 3,
    localRevision: 4,
    remoteTime: 999_999,
    lastSaveTime: 1,
  }), 'ignore');
});

test('treats an authoritative remote reset as a first-class update', () => {
  assert.equal(decide({
    operation: 'reset',
    remoteAnchorCfi: '',
  }), 'prompt');
  assert.equal(decide({
    isInitialSync: true,
    operation: 'reset',
    hasLocalProgress: false,
    remoteAnchorCfi: '',
  }), 'jump');
  assert.equal(decide({
    isInitialSync: true,
    operation: 'reset',
    hasLocalProgress: false,
    isQuietResumeEligible: false,
    remoteAnchorCfi: '',
  }), 'prompt');
  assert.equal(decide({
    isInitialSync: true,
    operation: 'reset',
    hasLocalProgress: true,
    remoteAnchorCfi: '',
  }), 'prompt');
  assert.equal(decide({
    operation: 'reset',
    remoteAnchorCfi: '',
    remoteRevision: 3,
    localRevision: 4,
  }), 'ignore');
});

test('quiet resume adopts before navigation and does not move when adoption is blocked', async () => {
  const blockedCalls = [];
  assert.equal(await executeRemoteProgressJump({
    claimDevice: false,
    isCurrent: () => true,
    prepare: () => blockedCalls.push('prepare'),
    navigate: async () => { blockedCalls.push('navigate'); },
    complete: async () => {
      blockedCalls.push('adopt');
      return false;
    },
  }), false);
  assert.deepEqual(blockedCalls, ['adopt']);

  const successCalls = [];
  assert.equal(await executeRemoteProgressJump({
    claimDevice: false,
    isCurrent: () => true,
    prepare: () => successCalls.push('prepare'),
    navigate: async () => { successCalls.push('navigate'); },
    complete: async () => {
      successCalls.push('adopt');
      return true;
    },
  }), true);
  assert.deepEqual(successCalls, ['adopt', 'prepare', 'navigate']);
});
