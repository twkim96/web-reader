import test from 'node:test';
import assert from 'node:assert/strict';

import {
  executeCanonicalRemoteProgressNavigation,
  getRemoteProgressIdentity,
} from '../src/hooks/reader/remoteProgressAdoption.ts';

const progress = {
  bookId: 'book-1',
  cfi: 'range-b',
  anchorCfi: 'anchor-b',
  progressPercent: 70,
  lastRead: 20,
  bookmarks: [],
  syncRevision: 2,
  acceptedEventId: 'remote-2',
};

test('canonical remote navigation adopts before touching the viewport', async () => {
  const events = [];
  const result = await executeCanonicalRemoteProgressNavigation({
    isCurrent: () => true,
    adopt: async () => {
      events.push('adopt');
      return { status: 'adopted', progress };
    },
    prepare: () => {
      events.push('prepare');
      return 1;
    },
    cancel: () => events.push('cancel'),
    finish: () => events.push('finish'),
    navigate: async () => {
      events.push('navigate');
      return true;
    },
  });

  assert.equal(result.status, 'navigated');
  assert.deepEqual(events, ['adopt', 'prepare', 'navigate', 'finish']);
});

test('local target work blocks quiet resume without navigation or rollback', async () => {
  const events = [];
  const result = await executeCanonicalRemoteProgressNavigation({
    isCurrent: () => true,
    adopt: async () => {
      events.push('adopt');
      return {
        status: 'blocked-by-local-work',
        work: { pending: 1, inFlight: 0, blocked: 0, conflicts: 0, paused: 0 },
      };
    },
    prepare: () => {
      events.push('prepare');
      return 1;
    },
    cancel: () => events.push('cancel'),
    finish: () => events.push('finish'),
    navigate: async () => {
      events.push('navigate');
      return true;
    },
  });

  assert.equal(result.status, 'blocked-by-local-work');
  assert.deepEqual(events, ['adopt']);
});

test('stale authoritative identity is rejected before navigation', async () => {
  const events = [];
  const result = await executeCanonicalRemoteProgressNavigation({
    isCurrent: () => true,
    adopt: async () => {
      events.push('adopt');
      return { status: 'stale-remote' };
    },
    prepare: () => {
      events.push('prepare');
      return 1;
    },
    cancel: () => events.push('cancel'),
    navigate: async () => {
      events.push('navigate');
      return true;
    },
  });

  assert.equal(result.status, 'stale-remote');
  assert.deepEqual(events, ['adopt']);
});

test('a failed renderer navigation keeps canonical progress but remains retryable', async () => {
  const events = [];
  const result = await executeCanonicalRemoteProgressNavigation({
    isCurrent: () => true,
    adopt: async () => {
      events.push('adopt');
      return { status: 'adopted', progress };
    },
    prepare: () => {
      events.push('prepare');
      return 7;
    },
    cancel: (id) => events.push(`cancel:${id}`),
    finish: () => events.push('finish'),
    navigate: async () => {
      events.push('navigate');
      return false;
    },
  });

  assert.equal(result.status, 'adopted-navigation-failed');
  assert.equal(result.retryable, true);
  assert.deepEqual(events, ['adopt', 'prepare', 'navigate', 'cancel:7']);
});

test('a superseded navigation is distinct from renderer failure', async () => {
  let current = true;
  const events = [];
  const result = await executeCanonicalRemoteProgressNavigation({
    isCurrent: () => current,
    adopt: async () => ({ status: 'adopted', progress }),
    prepare: () => 9,
    cancel: (id) => events.push(`cancel:${id}`),
    navigate: async () => {
      current = false;
      return true;
    },
  });

  assert.equal(result.status, 'adopted-navigation-superseded');
  assert.deepEqual(events, ['cancel:9']);
});

test('revision and accepted event id are the stable remote identity', () => {
  const first = getRemoteProgressIdentity({
    operation: 'set',
    cfi: 'range-a',
    anchorCfi: 'anchor-a',
    lastRead: 10,
    syncRevision: 4,
    acceptedEventId: 'event-4',
  });
  const afterLayout = getRemoteProgressIdentity({
    operation: 'set',
    cfi: 'range-after-layout',
    anchorCfi: 'anchor-after-layout',
    lastRead: 999,
    syncRevision: 4,
    acceptedEventId: 'event-4',
  });
  const newer = getRemoteProgressIdentity({
    operation: 'set',
    cfi: 'range-after-layout',
    anchorCfi: 'anchor-after-layout',
    lastRead: 999,
    syncRevision: 5,
    acceptedEventId: 'event-5',
  });

  assert.equal(first, afterLayout);
  assert.notEqual(first, newer);
});
