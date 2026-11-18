import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { useReaderProgressSave } from '../src/hooks/reader/useReaderProgressSave.ts';

for (const completion of ['navigation', 'explicit-ignore', 'newer-explicit-ignore']) {
  test(`failed remote viewport movement blocks saves until ${completion}`, async () => {
    const old = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
    const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const writes = [];
    const progress = { bookId: 'book-1', cfi: 'remote', anchorCfi: 'remote', progressPercent: 70, lastRead: 10, bookmarks: [], syncRevision: 2, acceptedEventId: 'remote-2' };
    let controls;
    const options = {
      bookId: 'book-1', initialCfi: 'old', initialPercent: 10, initialRevision: 1,
      onSaveProgress: async (...args) => { writes.push(args); return true; },
      onAdoptRemoteProgress: async () => ({ status: 'adopted', progress }),
    };
    function Harness() {
      const state = useReaderProgressSave(options);
      React.useEffect(() => { controls = state; }, [state]);
      return null;
    }
    const root = createRoot(window.document.getElementById('app'));
    try {
      await act(async () => root.render(React.createElement(Harness)));
      await act(async () => {
        assert.equal((await controls.adoptRemoteProgressBeforeNavigation({ ...progress, operation: 'set' })).status, 'adopted');
        const id = controls.prepareRemoteJump();
        controls.cancelRemoteJump(id);
        controls.markUserProgressChange();
        assert.equal(await controls.saveProgressIfChanged('old-next', 11, []), false);
        assert.equal(await controls.saveCurrentProgress({ force: true }), false);
        assert.equal(writes.length, 0);
        if (completion === 'navigation') controls.finishRemoteJump(controls.prepareRemoteJump());
        else assert.equal(controls.allowCurrentViewportAfterIgnoringRemote(completion === 'newer-explicit-ignore' ? 3 : 2, completion === 'newer-explicit-ignore' ? 'remote-3' : 'remote-2')(), true);
        controls.markUserProgressChange();
        assert.equal(await controls.saveProgressIfChanged('chosen-next', 71, []), true);
        assert.equal(writes.length, 1);
        assert.equal(writes[0][3].causalRevision, completion === 'navigation' ? 2 : 1);
        assert.equal(writes[0][3].causalAcceptedEventId, completion === 'navigation' ? 'remote-2' : undefined);
        if (completion !== 'navigation') assert.equal(writes[0][3].causalIgnoredRevision, completion === 'newer-explicit-ignore' ? 3 : 2);
      });
    } finally {
      await act(async () => root.unmount());
      globalThis.window = old.window;
      globalThis.document = old.document;
      globalThis.IS_REACT_ACT_ENVIRONMENT = old.act;
    }
  });
}

test('causal state is mount scoped and a stale ignore cannot release a newer adoption', async () => {
  const old = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const writes = [];
  let controls;
  const head = revision => ({ operation: 'set', bookId: 'book', cfi: `r${revision}`, progressPercent: 70, lastRead: revision, syncRevision: revision, acceptedEventId: `e${revision}` });
  const options = { bookId: 'book', initialCfi: 'local', initialPercent: 10,
    onSaveProgress: async (...args) => { writes.push(args); return true; },
    onAdoptRemoteProgress: async progress => ({ status: 'adopted', progress }) };
  function Harness(props) { const state = useReaderProgressSave({ ...options, ...props }); React.useEffect(() => { controls = state; }, [state]); return null; }
  const root = createRoot(document.getElementById('app'));
  try {
    await act(async () => root.render(React.createElement(Harness, { initialRevision: 1, ignoredRemoteRevision: 0 })));
    await act(async () => { controls.markUserProgressChange(); assert.equal(await controls.saveProgressIfChanged('local-1', 11, []), true); });
    await act(async () => root.render(React.createElement(Harness, { initialRevision: 9, ignoredRemoteRevision: 9 })));
    await act(async () => { controls.markUserProgressChange(); assert.equal(await controls.saveProgressIfChanged('local-2', 12, []), true); });
    assert.equal(writes[0][3].causalRevision, 1);
    assert.equal(writes[1][3].causalRevision, 1);
    assert.equal(writes[1][3].causalIgnoredRevision, 0);
    assert.equal(writes[0][3].causalViewportId, writes[1][3].causalViewportId);
    assert.ok(writes[0][3].causalViewportId);
    await act(async () => {
      const attempt2 = controls.beginRemoteNavigationAttempt();
      await controls.adoptRemoteProgressBeforeNavigation(head(2), attempt2.signal);
      const oldRelease = controls.allowCurrentViewportAfterIgnoringRemote(2, 'e2');
      const attempt3 = controls.beginRemoteNavigationAttempt();
      await controls.adoptRemoteProgressBeforeNavigation(head(3), attempt3.signal);
      assert.equal(oldRelease(), false);
      controls.allowCurrentViewportAfterIgnoringRemote(2, 'e2')();
      controls.allowCurrentViewportAfterIgnoringRemote(3, 'other-event')();
      controls.markUserProgressChange();
      assert.equal(await controls.saveProgressIfChanged('old', 13, []), false);
      const beforeNewAttempt = controls.allowCurrentViewportAfterIgnoringRemote(3, 'e3');
      controls.beginRemoteNavigationAttempt();
      assert.equal(beforeNewAttempt(), false);
      assert.equal(await controls.saveProgressIfChanged('still-blocked', 13, []), false);
      assert.equal(controls.allowCurrentViewportAfterIgnoringRemote(3, 'e3')(), true);
      assert.equal(await controls.saveProgressIfChanged('chosen', 14, []), true);
    });
    assert.equal(writes.at(-1)[3].causalRevision, 1);
    assert.equal(writes.at(-1)[3].causalIgnoredRevision, 3);
  } finally { await act(async () => root.unmount()); Object.assign(globalThis, { window: old.window, document: old.document, IS_REACT_ACT_ENVIRONMENT: old.act }); }
});

test('two live reader instances sharing IndexedDB keep independent viewport revisions', async () => {
  await import('fake-indexeddb/auto');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { ownerRuntime } = require('../src/lib/ownerRuntime.ts');
  const { closeLocalDB, initDB } = require('../src/lib/localDB.ts');
  const { LOCAL_DB_NAME } = require('../src/lib/localDBSchema.ts');
  const { enqueueProgressMutationBatchV5, getOutboxEventsV5 } = require('../src/lib/syncOutboxV5.ts');
  const { decideProgressTransaction } = require('../src/lib/progressSyncTransaction.ts');
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT, customEvent: globalThis.CustomEvent, broadcast: globalThis.BroadcastChannel };
  const { window } = parseHTML('<html><body><div id="a"></div><div id="b"></div></body></html>');
  globalThis.window = window; globalThis.document = window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true; globalThis.CustomEvent = window.CustomEvent; globalThis.BroadcastChannel = undefined;
  const ownerKey = 'firebase:two-reader|library:local'; ownerRuntime.activate(ownerKey);
  await closeLocalDB();
  await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase(LOCAL_DB_NAME); r.onsuccess = resolve; r.onerror = () => reject(r.error); });
  const db = await initDB();
  const serverHead = { schemaVersion: 2, bookId: 'book', revision: 2, acceptedEventId: 'b-adopted', operation: 'set',
    position: { cfi: 'new-b', anchorCfi: 'new-b', progressPercent: 80 }, acceptedDeviceId: 'device', occurredAtClient: 20, updatedAtServer: {}, deletedAtServer: null };
  await db.put('progress-v5', { ownerKey, bookId: 'book', cfi: 'new-b', anchorCfi: 'new-b', progressPercent: 80, lastRead: 20, bookmarks: [], syncRevision: 2, acceptedEventId: 'b-adopted' });
  const controls = {}; const writes = [];
  function Harness({ id, revision }) {
    const state = useReaderProgressSave({ ownerKey, bookId: 'book', initialCfi: id === 'a' ? 'old-a' : 'new-b', initialPercent: id === 'a' ? 20 : 80,
      initialRevision: revision, onAdoptRemoteProgress: async () => ({ status: 'cancelled' }),
      onSaveProgress: async (cfi, pct, bookmarks, options) => {
        writes.push({ id, ...options });
        await enqueueProgressMutationBatchV5(ownerKey, { progress: { bookId: 'book', cfi, anchorCfi: cfi, progressPercent: pct, lastRead: 25, bookmarks,
          syncRevision: options.causalRevision, ignoredRemoteRevision: options.causalIgnoredRevision },
          progressEvent: { bookId: 'book', operation: 'progress.set', position: { cfi, anchorCfi: cfi, progressPercent: pct },
            deviceId: 'device', sessionId: 'same-process-tab', eventId: `reader-${id}`, ...options }, bookmarkEvents: [] });
        return true;
      } });
    React.useEffect(() => { controls[id] = state; }, [id, state]);
    return null;
  }
  const a = createRoot(window.document.getElementById('a')); const b = createRoot(window.document.getElementById('b'));
  try {
    await act(async () => { a.render(React.createElement(Harness, { id: 'a', revision: 1 })); b.render(React.createElement(Harness, { id: 'b', revision: 2 })); });
    // A receives newer props while its visible page remains old. Props alone are not adoption.
    await act(async () => a.render(React.createElement(Harness, { id: 'a', revision: 2 })));
    await act(async () => { controls.a.markUserProgressChange(); assert.equal(await controls.a.saveProgressIfChanged('old-a-next', 21, []), true); });
    await act(async () => { controls.b.markUserProgressChange(); assert.equal(await controls.b.saveProgressIfChanged('new-b-next', 81, []), true); });
    const events = await getOutboxEventsV5(ownerKey);
    const old = events.find(x => x.eventId === 'reader-a'); const fresh = events.find(x => x.eventId === 'reader-b');
    assert.equal(old.baseRevision, 1); assert.equal(fresh.baseRevision, 2);
    assert.notEqual(writes[0].causalViewportId, writes[1].causalViewportId);
    assert.equal(decideProgressTransaction({ event: old, storedHead: serverHead, storedReceipt: undefined, serverTime: {} }).status, 'conflict');
    assert.equal(decideProgressTransaction({ event: fresh, storedHead: serverHead, storedReceipt: undefined, serverTime: {} }).status, 'apply');
  } finally {
    await act(async () => { a.unmount(); b.unmount(); }); ownerRuntime.clear(); await closeLocalDB();
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act; globalThis.CustomEvent = previous.customEvent; globalThis.BroadcastChannel = previous.broadcast;
  }
});
