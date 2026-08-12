import test from 'node:test';
import assert from 'node:assert/strict';

class FakeBroadcastChannel extends EventTarget {
  static instances = new Map();

  posted = [];

  constructor(name) {
    super();
    this.name = name;
    FakeBroadcastChannel.instances.set(name, this);
  }

  postMessage(value) {
    this.posted.push(value);
  }
}

test('delivers explicit statistics refresh requests locally and across tabs by owner', async () => {
  const originalWindow = globalThis.window;
  const originalBroadcastChannel = globalThis.BroadcastChannel;
  const fakeWindow = new EventTarget();
  globalThis.window = fakeWindow;
  globalThis.BroadcastChannel = FakeBroadcastChannel;
  try {
    const moduleUrl = new URL('../src/lib/readingStatisticsWake.ts', import.meta.url);
    moduleUrl.searchParams.set('test', String(Date.now()));
    const {
      notifyReadingStatisticsServerCheck,
      requestReadingStatisticsRefresh,
      subscribeReadingStatisticsRefreshRequests,
      subscribeReadingStatisticsServerChecks,
    } = await import(moduleUrl.href);
    let refreshes = 0;
    const unsubscribe = subscribeReadingStatisticsRefreshRequests('owner-a', () => {
      refreshes += 1;
    });

    requestReadingStatisticsRefresh('owner-a');
    assert.equal(refreshes, 1);
    const channel = FakeBroadcastChannel.instances.get('twreader-reading-statistics-refresh-v1');
    assert.deepEqual(channel.posted, [{ ownerKey: 'owner-a' }]);

    channel.dispatchEvent(new MessageEvent('message', { data: { ownerKey: 'owner-b' } }));
    channel.dispatchEvent(new MessageEvent('message', { data: { ownerKey: 'owner-a' } }));
    assert.equal(refreshes, 2);

    const checks = [];
    const unsubscribeChecks = subscribeReadingStatisticsServerChecks('owner-a', (checkedAt) => {
      checks.push(checkedAt);
    });
    notifyReadingStatisticsServerCheck('owner-a', 123);
    const checkChannel = FakeBroadcastChannel.instances
      .get('twreader-reading-statistics-server-check-v1');
    assert.deepEqual(checkChannel.posted, [{ ownerKey: 'owner-a', checkedAt: 123 }]);
    checkChannel.dispatchEvent(new MessageEvent('message', {
      data: { ownerKey: 'owner-b', checkedAt: 456 },
    }));
    checkChannel.dispatchEvent(new MessageEvent('message', {
      data: { ownerKey: 'owner-a', checkedAt: 789 },
    }));
    checkChannel.dispatchEvent(new MessageEvent('message', {
      data: { ownerKey: 'owner-a', checkedAt: null },
    }));
    assert.deepEqual(checks, [123, 789, null]);
    unsubscribeChecks();
    unsubscribe();
  } finally {
    globalThis.window = originalWindow;
    globalThis.BroadcastChannel = originalBroadcastChannel;
  }
});
