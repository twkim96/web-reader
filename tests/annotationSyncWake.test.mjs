import test from 'node:test';
import assert from 'node:assert/strict';

class FakeBroadcastChannel extends EventTarget {
  static instance;

  constructor() {
    super();
    FakeBroadcastChannel.instance = this;
  }

  postMessage() {}
}

test('replays every hidden-tab annotation target when the tab becomes visible', async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalBroadcastChannel = globalThis.BroadcastChannel;
  const fakeWindow = new EventTarget();
  const fakeDocument = new EventTarget();
  Object.defineProperty(fakeDocument, 'visibilityState', {
    value: 'hidden',
    writable: true,
    configurable: true,
  });
  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument;
  globalThis.BroadcastChannel = FakeBroadcastChannel;
  try {
    const { subscribeAnnotationSyncChanges } = await import('../src/lib/annotationSyncWake.ts');
    const received = [];
    const unsubscribe = subscribeAnnotationSyncChanges('owner-1', (change) => {
      received.push(change);
    });
    FakeBroadcastChannel.instance.dispatchEvent(new MessageEvent('message', {
      data: { ownerKey: 'owner-1', bookId: 'book-a' },
    }));
    FakeBroadcastChannel.instance.dispatchEvent(new MessageEvent('message', {
      data: { ownerKey: 'owner-1', bookId: 'book-b' },
    }));
    FakeBroadcastChannel.instance.dispatchEvent(new MessageEvent('message', {
      data: { ownerKey: 'owner-1', palette: [] },
    }));
    assert.equal(received.length, 0);

    fakeDocument.visibilityState = 'visible';
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual(received, [
      { ownerKey: 'owner-1', bookId: 'book-a' },
      { ownerKey: 'owner-1', bookId: 'book-b' },
      { ownerKey: 'owner-1', palette: [] },
    ]);
    unsubscribe();
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.BroadcastChannel = originalBroadcastChannel;
  }
});
