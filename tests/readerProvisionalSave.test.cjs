/* eslint-disable @typescript-eslint/no-require-imports -- Hook harness uses the existing CommonJS test boundary. */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { parseHTML } = require('linkedom');
const { createRoot } = require('react-dom/client');
const { useReaderProgressSave } = require('../src/hooks/reader/useReaderProgressSave.ts');

async function harness(run) {
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const dom = parseHTML('<html><body><div id="app"></div></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  let hook;
  const saves = [];
  let result = true;
  let adoptionCalls = 0;
  function Fixture() {
    hook = useReaderProgressSave({
      initialCfi: 'original', initialPercent: 10,
      onSaveProgress: async (...args) => { saves.push(args); return typeof result === 'function' ? result() : result; },
      onAdoptRemoteProgress: async () => { adoptionCalls++; return { status: 'cancelled' }; },
    });
    return null;
  }
  const root = createRoot(document.getElementById('app'));
  try {
    await React.act(async () => root.render(React.createElement(Fixture)));
    hook.updateSaveContext({ currentCfi: 'original', currentAnchorCfi: 'original', totalProgress: 10, bookmarks: [], hasSyncConflict: false });
    hook.handleRelocateForSave({ cfi: 'original', progressPercent: 10 });
    await run({ hook, saves, setResult: value => { result = value; }, adoptionCalls: () => adoptionCalls });
  } finally {
    await React.act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
}

test('multiple previews block all save entry points and remote adoption; cancel restores original', () => harness(async ({ hook, saves, adoptionCalls }) => {
  hook.beginProvisionalNavigation();
  for (const [cfi, progressPercent] of [['preview1', 30], ['preview2', 80]]) {
    hook.markUserProgressChange({ forceNextRelocateSave: true });
    hook.handleRelocateForSave({ cfi, progressPercent });
    assert.equal(await hook.saveCurrentProgress({ force: true }), false);
    assert.equal(await hook.saveProgressIfChanged(cfi, progressPercent, [], { force: true }), false);
    assert.equal(await hook.flushCurrentProgress(), false);
  }
  assert.equal(hook.isProgressConflictAutoResolveEligible(), false);
  assert.deepEqual(await hook.adoptRemoteProgressBeforeNavigation({}), { status: 'cancelled' });
  assert.equal(await hook.completeRemoteJump({}, []), false);
  assert.equal(await hook.completeRemoteReset({}, []), false);
  assert.equal(adoptionCalls(), 0);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(saves.length, 0);
  hook.handleRelocateForSave({ cfi: 'rollback-page', progressPercent: 11 });
  hook.cancelProvisionalNavigation();
  assert.equal(hook.isProvisionalNavigationActive(), false);
  assert.equal(await hook.saveCurrentProgress({ force: true }), true);
  assert.equal(saves[0][0], 'original');
  assert.equal(saves[0][1], 10);
}));

test('confirm persists latest observed location with staged bookmarks once and failure retains preview', () => harness(async ({ hook, saves, setResult }) => {
  hook.beginProvisionalNavigation();
  hook.handleRelocateForSave({ cfi: 'preview1', progressPercent: 20 });
  hook.handleRelocateForSave({ cfi: 'latest', anchorCfi: 'latest-anchor', progressPercent: 70 });
  setResult(false);
  assert.equal(await hook.confirmProvisionalNavigation([]), false);
  assert.equal(hook.isProvisionalNavigationActive(), true);
  let release;
  setResult(() => new Promise(resolve => { release = resolve; }));
  const bookmarks = [{ cfi: 'original', label: 'Before preview' }];
  const first = hook.confirmProvisionalNavigation(bookmarks);
  const second = hook.confirmProvisionalNavigation(bookmarks);
  assert.equal(first, second);
  assert.equal(await hook.saveCurrentProgress({ force: true }), false);
  release(true);
  assert.equal(await first, true);
  assert.equal(hook.isProvisionalNavigationActive(), false);
  assert.equal(saves.length, 2);
  assert.deepEqual(saves[1], ['latest', 70, bookmarks, { force: true, anchorCfi: 'latest-anchor' }]);
}));

test('cancel preserves a pending original user relocation', () => harness(async ({ hook, saves }) => {
  hook.markUserProgressChange();
  hook.handleRelocateForSave({ cfi: 'unsaved-original', progressPercent: 15 });
  hook.beginProvisionalNavigation();
  hook.handleRelocateForSave({ cfi: 'preview', progressPercent: 90 });
  hook.handleRelocateForSave({ cfi: 'unsaved-original', progressPercent: 15 });
  hook.cancelProvisionalNavigation();
  await hook.flushCurrentProgress();
  assert.equal(saves.length, 1);
  assert.equal(saves[0][0], 'unsaved-original');
}));

test('thrown confirmation keeps the transaction available for retry', () => harness(async ({ hook, setResult }) => {
  hook.beginProvisionalNavigation();
  hook.handleRelocateForSave({ cfi: 'preview', progressPercent: 60 });
  setResult(() => { throw new Error('storage failed'); });
  await assert.rejects(hook.confirmProvisionalNavigation(), /storage failed/);
  assert.equal(hook.isProvisionalNavigationActive(), true);
  setResult(true);
  assert.equal(await hook.confirmProvisionalNavigation(), true);
}));

test('provisional navigation aborts old remote attempts and rejects new attempts through rollback', () => harness(async ({ hook }) => {
  const before = hook.beginRemoteNavigationAttempt();
  assert.equal(hook.isRemoteNavigationAttemptCurrent(before), true);
  hook.beginProvisionalNavigation();
  assert.equal(before.signal.aborted, true);
  assert.equal(hook.isRemoteNavigationAttemptCurrent(before), false);
  const during = hook.beginRemoteNavigationAttempt();
  assert.equal(during.signal.aborted, true);
  assert.equal(hook.isRemoteNavigationAttemptCurrent(during), false);
  hook.handleRelocateForSave({ cfi: 'original', progressPercent: 10 });
  hook.cancelProvisionalNavigation();
  assert.equal(hook.isRemoteNavigationAttemptCurrent(during), false);
  const after = hook.beginRemoteNavigationAttempt();
  assert.equal(after.signal.aborted, false);
  assert.equal(hook.isRemoteNavigationAttemptCurrent(after), true);
}));
