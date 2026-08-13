import test from 'node:test';
import assert from 'node:assert/strict';

import { decideRemoteProgressAction } from '../src/hooks/reader/remoteProgressPolicy.ts';
import { executeRemoteProgressJump } from '../src/hooks/reader/remoteProgressJump.ts';
import {
  hasSameExpectedLocalProgressState,
  hasSameRemoteProgressHead,
  finalizeRemoteProgressCommand,
  shouldCancelRemoteProgressCommand,
} from '../src/hooks/reader/remoteProgressCommand.ts';

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

test('distinguishes a local move from a newer staged remote head', () => {
  const remoteHead = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 7,
    acceptedEventId: 'event-7',
    operation: 'set',
    position: {
      cfi: 'epubcfi(/7)',
      anchorCfi: 'epubcfi(/7)',
      progressPercent: 70,
    },
  };
  const staged = { remoteHead };
  assert.equal(hasSameRemoteProgressHead(staged, { remoteHead: { ...remoteHead } }), true);
  assert.equal(hasSameRemoteProgressHead(staged, {
    remoteHead: { ...remoteHead, revision: 8, acceptedEventId: 'event-8' },
  }), false);
  assert.equal(hasSameRemoteProgressHead(staged, {
    remoteHead: {
      ...remoteHead,
      position: { ...remoteHead.position, progressPercent: 80 },
    },
  }), false);
});

test('cancels a staged remote command outside its active reader book', () => {
  const base = { view: 'reader', activeBookId: 'book-1', commandBookId: 'book-1' };
  assert.equal(shouldCancelRemoteProgressCommand(base), false);
  assert.equal(shouldCancelRemoteProgressCommand({ ...base, view: 'shelf' }), true);
  assert.equal(shouldCancelRemoteProgressCommand({ ...base, activeBookId: 'book-2' }), true);
  assert.equal(shouldCancelRemoteProgressCommand({ ...base, activeBookId: undefined }), true);
});

test('does not finalize an already committed automatic remote command twice', async () => {
  let finalizeCalls = 0;
  const progress = { bookId: 'book-1', cfi: 'remote-cfi', progressPercent: 70 };
  assert.deepEqual(await finalizeRemoteProgressCommand(
    { committed: true, progress },
    async () => {
      finalizeCalls += 1;
      return { status: 'cancelled' };
    },
  ), { status: 'committed', progress });
  assert.equal(finalizeCalls, 0);

  assert.deepEqual(await finalizeRemoteProgressCommand(
    { progress },
    async () => {
      finalizeCalls += 1;
      return { status: 'committed', progress };
    },
  ), { status: 'committed', progress });
  assert.equal(finalizeCalls, 1);
});

test('moves once without rollback after automatic resolution already committed', async () => {
  const calls = [];
  const progress = { bookId: 'book-1', cfi: 'remote-cfi', progressPercent: 70 };
  assert.equal(await executeRemoteProgressJump({
    isCurrent: () => true,
    prepare: () => 3,
    cancel: () => calls.push('cancel'),
    finish: () => calls.push('finish'),
    navigate: async () => {
      calls.push('navigate');
      return true;
    },
    rollback: async () => calls.push('rollback'),
    complete: () => finalizeRemoteProgressCommand(
      { committed: true, progress },
      async () => {
        calls.push('finalize-again');
        return { status: 'cancelled' };
      },
    ).then(({ status }) => status === 'committed'),
  }), true);
  assert.deepEqual(calls, ['navigate', 'finish']);
});

test('does not restage a newer remote head over a changed local position', () => {
  const expected = {
    kind: 'position',
    position: { cfi: 'epubcfi(/7)', anchorCfi: 'epubcfi(/7)', progressPercent: 70 },
  };
  assert.equal(hasSameExpectedLocalProgressState(expected, structuredClone(expected)), true);
  assert.equal(hasSameExpectedLocalProgressState(expected, {
    ...expected,
    position: { ...expected.position, progressPercent: 71 },
  }), false);
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

test('treats a lower but newer remote position as deliberate cross-device reading', () => {
  assert.equal(decide({
    isInitialSync: true,
    currentPercent: 70,
    remotePercent: 30,
    remoteRevision: 8,
    localRevision: 7,
  }), 'jump');
  assert.equal(decide({
    isInitialSync: false,
    currentPercent: 70,
    remotePercent: 30,
    remoteTime: 999_999,
    lastSaveTime: 1,
  }), 'prompt');
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

test('rolls back a committed remote navigation superseded before finalize', async () => {
  const calls = [];
  assert.equal(await executeRemoteProgressJump({
    isCurrent: () => false,
    prepare: () => 11,
    cancel: (id) => calls.push(`cancel:${id}`),
    navigate: async () => {
      calls.push('navigate-committed');
      return true;
    },
    rollback: async (id) => calls.push(`rollback:${id}`),
    complete: async () => {
      calls.push('complete');
      return true;
    },
  }), false);
  assert.deepEqual(calls, [
    'navigate-committed',
    'rollback:11',
    'cancel:11',
  ]);
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

test('stages a refreshed remote command only after the stale viewport rolls back', async () => {
  const calls = [];
  assert.equal(await executeRemoteProgressJump({
    isCurrent: () => true,
    prepare: () => 9,
    cancel: () => calls.push('restore'),
    navigate: async () => {
      calls.push('navigate-stale');
      return true;
    },
    rollback: async () => {
      calls.push('rollback');
    },
    complete: async () => ({
      completed: false,
      afterRollback: () => calls.push('stage-latest'),
    }),
  }), false);
  assert.deepEqual(calls, [
    'navigate-stale',
    'rollback',
    'restore',
    'stage-latest',
  ]);
});
