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

test('completes a remote adoption only after navigation commits', async () => {
  const blockedCalls = [];
  assert.equal(await executeRemoteProgressJump({
    isCurrent: () => true,
    prepare: () => blockedCalls.push('prepare'),
    cancel: () => blockedCalls.push('cancel'),
    navigate: async () => {
      blockedCalls.push('navigate');
      return true;
    },
    complete: async () => {
      blockedCalls.push('adopt');
      return false;
    },
  }), false);
  assert.deepEqual(blockedCalls, ['prepare', 'navigate', 'adopt', 'cancel']);

  const successCalls = [];
  assert.equal(await executeRemoteProgressJump({
    isCurrent: () => true,
    prepare: () => successCalls.push('prepare'),
    cancel: () => successCalls.push('cancel'),
    navigate: async () => {
      successCalls.push('navigate');
      return true;
    },
    complete: async () => {
      successCalls.push('adopt');
      return true;
    },
  }), true);
  assert.deepEqual(successCalls, ['prepare', 'navigate', 'adopt']);
});

test('does not complete a remote jump superseded by newer user navigation', async () => {
  const calls = [];
  assert.equal(await executeRemoteProgressJump({
    isCurrent: () => true,
    prepare: () => calls.push('prepare'),
    cancel: () => calls.push('cancel'),
    navigate: async () => {
      calls.push('navigate-cancelled');
      return false;
    },
    complete: async () => {
      calls.push('complete');
      return true;
    },
  }), false);
  assert.deepEqual(calls, ['prepare', 'navigate-cancelled', 'cancel']);
});

test('cancels remote preparation when renderer navigation rejects', async () => {
  const calls = [];
  await assert.rejects(executeRemoteProgressJump({
    isCurrent: () => true,
    prepare: () => calls.push('prepare'),
    cancel: () => calls.push('cancel'),
    navigate: async () => {
      calls.push('navigate');
      throw new Error('renderer failed');
    },
    complete: async () => {
      calls.push('complete');
      return true;
    },
  }), /renderer failed/);
  assert.deepEqual(calls, ['prepare', 'navigate', 'cancel']);
});

test('rolls the viewport back before restoring pending state when finalize fails', async () => {
  const calls = [];
  assert.equal(await executeRemoteProgressJump({
    isCurrent: () => true,
    prepare: () => {
      calls.push('prepare');
      return 7;
    },
    cancel: (id) => calls.push(`restore:${id}`),
    finish: (id) => calls.push(`finish:${id}`),
    navigate: async () => {
      calls.push('navigate-remote');
      return true;
    },
    rollback: async (id) => {
      calls.push(`rollback:${id}`);
    },
    complete: async () => {
      calls.push('finalize');
      return false;
    },
  }), false);
  assert.deepEqual(calls, [
    'prepare',
    'navigate-remote',
    'finalize',
    'rollback:7',
    'restore:7',
  ]);
});
