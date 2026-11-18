import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAutomaticProgressConflictResolution,
  getQuietProgressConflictReason,
  isEquivalentProgressPosition,
} from '../src/lib/syncConflictPolicy.ts';

const {
  selectProgressSyncConflict,
  shouldShowSyncConflictDialog,
  shouldShowSyncReviewBadge,
} = await import('../src/lib/syncConflictPresentation.ts');

test('keeps startup and shelf conflicts non-blocking until review is requested', () => {
  const base = {
    hasConflict: true,
    explicitReview: false,
    conflictKind: 'progress',
    conflictBookId: 'book-1',
    activeBookId: undefined,
  };
  assert.equal(shouldShowSyncConflictDialog({ ...base, view: 'loading' }), false);
  assert.equal(shouldShowSyncConflictDialog({ ...base, view: 'shelf' }), false);
  assert.equal(shouldShowSyncReviewBadge({ ...base, view: 'loading' }), false);
  assert.equal(shouldShowSyncReviewBadge({ ...base, view: 'shelf' }), true);
  assert.equal(shouldShowSyncConflictDialog({
    ...base,
    explicitReview: true,
    view: 'shelf',
  }), true);
});

test('automatically presents only an active-book reading-position conflict', () => {
  const base = {
    hasConflict: true,
    explicitReview: false,
    view: 'reader',
    conflictKind: 'progress',
    activeBookId: 'book-1',
  };
  assert.equal(shouldShowSyncConflictDialog({
    ...base,
    conflictBookId: 'book-1',
  }), true);
  assert.equal(shouldShowSyncConflictDialog({
    ...base,
    conflictBookId: 'book-2',
  }), false);
  assert.equal(shouldShowSyncConflictDialog({
    ...base,
    conflictBookId: null,
  }), false);
  assert.equal(shouldShowSyncConflictDialog({
    ...base,
    conflictKind: 'bookmark',
    conflictBookId: 'book-1',
  }), false);
  assert.equal(shouldShowSyncConflictDialog({
    ...base,
    conflictKind: 'annotation',
    conflictBookId: 'book-1',
  }), false);
  assert.equal(shouldShowSyncReviewBadge({
    ...base,
    conflictKind: 'annotation',
    conflictBookId: 'book-1',
  }), true);
  assert.equal(shouldShowSyncReviewBadge({
    ...base,
    conflictBookId: 'book-1',
  }), false);
});

test('selects an active-book progress conflict ahead of older inactive work', () => {
  const inactiveBookmark = conflict({
    conflictId: 'old-bookmark',
    targetKey: 'bookmark:book-a:mark-1',
    event: {
      ...progressEvent(),
      eventId: 'old-bookmark',
      target: { kind: 'bookmark', bookId: 'book-a', bookmarkId: 'mark-1' },
      targetKey: 'bookmark:book-a:mark-1',
      operation: 'bookmark.delete',
      payload: null,
    },
  });
  const activeProgress = conflict({
    conflictId: 'active-progress',
    targetKey: 'progress:book-b',
    event: progressEvent({
      eventId: 'active-progress',
      target: { kind: 'progress', bookId: 'book-b' },
      targetKey: 'progress:book-b',
    }),
  });
  assert.equal(
    selectProgressSyncConflict([inactiveBookmark, activeProgress], 'book-b')?.conflictId,
    'active-progress',
  );
});

const progressEvent = (overrides = {}) => ({
  ownerKey: 'firebase:a|library:local',
  eventId: 'local-1',
  target: { kind: 'progress', bookId: 'book-1' },
  targetKey: 'progress:book-1',
  operation: 'progress.set',
  payload: { cfi: 'local-cfi', anchorCfi: null, progressPercent: 30 },
  deviceId: 'device-1',
  sessionId: 'previous-session',
  sequence: 1,
  baseRevision: 2,
  occurredAtClient: 10,
  status: 'conflict',
  attempts: 1,
  nextAttemptAt: null,
  lastErrorCode: null,
  claimedByTabId: null,
  claimedLeaseEpoch: null,
  claimToken: null,
  ...overrides,
});

const remoteHead = (overrides = {}) => ({
  schemaVersion: 2,
  bookId: 'book-1',
  revision: 3,
  acceptedEventId: 'remote-3',
  operation: 'set',
  position: { cfi: 'remote-cfi', anchorCfi: null, progressPercent: 70 },
  acceptedDeviceId: 'device-2',
  acceptedSessionId: 'remote-session',
  occurredAtClient: 20,
  updatedAtServer: {},
  deletedAtServer: null,
  ...overrides,
});

const conflict = (overrides = {}) => ({
  ownerKey: 'firebase:a|library:local',
  conflictId: 'local-1',
  targetKey: 'progress:book-1',
  state: 'open',
  event: progressEvent(),
  remoteHead: remoteHead(),
  latestLocalPosition: { cfi: 'local-cfi', anchorCfi: null, progressPercent: 30 },
  blockedEventIds: [],
  createdAt: 30,
  ...overrides,
});

const reason = (target, overrides = {}) => getQuietProgressConflictReason({
  conflict: target,
  activeBookId: 'book-1',
  currentSessionId: 'current-session',
  ...overrides,
});

test('keeps non-equivalent positions for review regardless of direction or session', () => {
  const cases = [
    { name: 'remote advanced', local: 30, remote: 70 },
    { name: 'remote reread or backward move', local: 80, remote: 30 },
    { name: 'old high local percent', local: 90, remote: 20 },
    { name: 'same percent, different anchor', local: 30, remote: 30 },
    { name: 'small percent difference', local: 30, remote: 30.02 },
  ];
  for (const { name, local, remote } of cases) {
    const target = conflict({
      event: progressEvent({ payload: { cfi: 'local-cfi', anchorCfi: null, progressPercent: local } }),
      latestLocalPosition: { cfi: 'local-cfi', anchorCfi: null, progressPercent: local },
      remoteHead: remoteHead({ position: { cfi: 'remote-cfi', anchorCfi: null, progressPercent: remote } }),
    });
    for (const context of [
      { activeBookId: 'book-1', currentSessionId: 'current-session' },
      { activeBookId: 'book-2', currentSessionId: 'current-session' },
      { activeBookId: undefined, currentSessionId: 'previous-session' },
    ]) {
      assert.equal(getAutomaticProgressConflictResolution({ conflict: target, ...context }), null, name);
      assert.equal(reason(target, context), null, name);
    }
  }
});

test('timestamps and device identity do not choose between different positions', () => {
  for (const acceptedDeviceId of ['device-1', 'device-2']) {
    for (const occurredAtClient of [5, 10, 20]) {
      const target = conflict({ remoteHead: remoteHead({ acceptedDeviceId, occurredAtClient }) });
      assert.equal(reason(target), null);
    }
  }
});

test('equivalent anchors adopt remote only when the revision conflict is eligible', () => {
  const equivalentHead = remoteHead({
    position: { cfi: 'page-cfi-b', anchorCfi: 'local-cfi', progressPercent: 31 },
    occurredAtClient: 5,
  });
  const equivalent = conflict({ remoteHead: equivalentHead });
  for (const context of [
    { activeBookId: 'book-1', currentSessionId: 'previous-session' },
    { activeBookId: 'book-2', currentSessionId: 'current-session' },
  ]) {
    assert.deepEqual(getAutomaticProgressConflictResolution({ conflict: equivalent, ...context }),
      { winner: 'remote', reason: 'equivalent-position' });
  }
  assert.equal(reason(conflict({ remoteHead: { ...equivalentHead, revision: 2 } })), null);
  assert.equal(reason(conflict({ remoteHead: equivalentHead, blockedEventIds: ['later-local-event'] })), null);
  assert.equal(reason(conflict({
    remoteHead: equivalentHead,
    latestLocalPosition: { cfi: 'new-local-cfi', anchorCfi: null, progressPercent: 31 },
  })), null);
});

test('compares the stable anchor instead of layout-dependent percentages', () => {
  assert.equal(isEquivalentProgressPosition(
    { cfi: 'page-cfi-a', anchorCfi: 'anchor-cfi', progressPercent: 30 },
    { cfi: 'page-cfi-b', anchorCfi: 'anchor-cfi', progressPercent: 31 },
  ), true);
  assert.equal(isEquivalentProgressPosition(
    { cfi: 'page-cfi-a', anchorCfi: null, progressPercent: 30 },
    { cfi: 'page-cfi-b', anchorCfi: null, progressPercent: 30 },
  ), false);
});

test('keeps destructive progress and bookmark conflicts user-visible', () => {
  assert.equal(reason(conflict({
    event: progressEvent({ operation: 'progress.reset', payload: null }),
  })), null);
  assert.equal(reason(conflict({
    remoteHead: remoteHead({ operation: 'reset', position: null }),
  })), null);
  assert.equal(reason(conflict({ remoteHead: null })), null);
  assert.equal(reason(conflict({
    event: {
      ...progressEvent(),
      target: { kind: 'bookmark', bookId: 'book-1', bookmarkId: 'mark-1' },
      targetKey: 'bookmark:book-1:mark-1',
      operation: 'bookmark.delete',
      payload: null,
    },
  })), null);
});
