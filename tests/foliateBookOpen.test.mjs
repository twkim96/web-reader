import test from 'node:test';
import assert from 'node:assert/strict';

import { openFoliateBook } from '../src/hooks/foliate/openFoliateBook.ts';

test('configures the Foliate renderer before opening a new book at the beginning', async () => {
  const calls = [];
  const source = { sections: [] };
  const view = {
    open: async (openedSource) => {
      assert.equal(openedSource, source);
      calls.push('open');
    },
    init: async ({ lastLocation }) => {
      assert.equal(lastLocation, null);
      calls.push('init');
    },
  };

  await openFoliateBook(
    view,
    source,
    undefined,
    async (openedView) => {
      assert.equal(openedView, view);
      calls.push('style');
    },
  );

  assert.deepEqual(calls, ['open', 'style', 'init']);
});

test('resume stays pending until saved-position pagination has settled', async () => {
  const calls = [];
  let finishNavigation;
  const navigation = new Promise(resolve => { finishNavigation = resolve; });
  let navigationStarted;
  const started = new Promise(resolve => { navigationStarted = resolve; });
  const view = {
    open: async () => calls.push('open'),
    init: async () => assert.fail('resume must not fall back to first-page init'),
    goTo: async () => assert.fail('resume must wait for stable pagination'),
    goToStable: async (target) => {
      assert.equal(target, 'epubcfi(/6/12)');
      calls.push('restore');
      navigationStarted();
      return navigation;
    },
  };
  let completed = false;
  const opened = openFoliateBook(view, { sections: [] }, 'epubcfi(/6/12)', async () => {
    calls.push('style');
  }).then(() => { completed = true; });
  await started;
  assert.equal(completed, false);
  assert.deepEqual(calls, ['open', 'style', 'restore']);
  finishNavigation({ index: 5 });
  await opened;
  assert.equal(completed, true);
});

test('resume uses the saved anchor when the primary location cannot be restored', async () => {
  const targets = [];
  const view = {
    open: async () => {},
    init: async () => assert.fail('saved progress must not fall back to the beginning'),
    goToStable: async (target) => {
      targets.push(target);
      return target === 'saved-anchor' ? { index: 5 } : false;
    },
  };
  await openFoliateBook(view, { sections: [] }, 'unusable-location', undefined, 'saved-anchor');
  assert.deepEqual(targets, ['unusable-location', 'saved-anchor']);
});

test('refused resume rejects the open instead of reporting a successful first page', async () => {
  const targets = [];
  const view = {
    open: async () => {},
    init: async () => assert.fail('failed resume must not reset to the beginning'),
    goToStable: async (target) => {
      targets.push(target);
      return false;
    },
  };
  await assert.rejects(
    openFoliateBook(view, { sections: [] }, 'saved-location', undefined, 'saved-location'),
    /저장된 읽기 위치를 복원하지 못했습니다/,
  );
  assert.deepEqual(targets, ['saved-location']);
});
