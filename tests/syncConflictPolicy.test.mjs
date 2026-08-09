import test from 'node:test';
import assert from 'node:assert/strict';
import {
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

test('quietly adopts a valid newer remote position for an unchanged previous-session event', () => {
  assert.equal(reason(conflict()), 'previous-session');
  assert.equal(reason(conflict(), { activeBookId: 'book-2' }), null);
  assert.equal(reason(conflict(), { currentSessionId: 'previous-session' }), null);
  assert.equal(reason(conflict({
    remoteHead: remoteHead({ revision: 2 }),
  })), null);
  assert.equal(reason(conflict({ blockedEventIds: ['later-local-event'] })), null);
  assert.equal(reason(conflict({
    latestLocalPosition: { cfi: 'new-local-cfi', anchorCfi: null, progressPercent: 31 },
  })), null);
});

test('quietly adopts equivalent positions and a strictly newer same-device position', () => {
  const currentSessionEvent = progressEvent({ sessionId: 'current-session' });
  assert.equal(reason(conflict({
    event: currentSessionEvent,
    remoteHead: remoteHead({
      position: { cfi: 'local-cfi', anchorCfi: 'local-cfi', progressPercent: 31 },
      occurredAtClient: 5,
    }),
  })), 'equivalent-position');
  assert.equal(reason(conflict({
    event: currentSessionEvent,
    remoteHead: remoteHead({ acceptedDeviceId: 'device-1', occurredAtClient: 11 }),
  })), 'newer-same-device');
  assert.equal(reason(conflict({
    event: currentSessionEvent,
    remoteHead: remoteHead({ acceptedDeviceId: 'device-1', occurredAtClient: 9 }),
  })), null);
  assert.equal(reason(conflict({ event: currentSessionEvent })), null);
});

test('quietly adopts a negligible current-session position race across devices', () => {
  const currentSessionEvent = progressEvent({
    sessionId: 'current-session',
    payload: { cfi: 'local-cfi', anchorCfi: null, progressPercent: 30 },
  });
  assert.equal(reason(conflict({
    event: currentSessionEvent,
    remoteHead: remoteHead({
      position: { cfi: 'nearby-remote-cfi', anchorCfi: null, progressPercent: 30.02 },
    }),
  })), 'nearby-position');
  assert.equal(reason(conflict({
    event: currentSessionEvent,
    remoteHead: remoteHead({
      position: { cfi: 'meaningful-remote-cfi', anchorCfi: null, progressPercent: 30.04 },
    }),
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
