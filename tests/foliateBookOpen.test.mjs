import test from 'node:test';
import assert from 'node:assert/strict';

import { readReaderOpenPerformanceTrace, readReaderResumeFailures } from '../src/lib/readerBootstrapTrace.ts';

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
  assert.deepEqual(targets, ['saved-location', 'saved-location']);
});


test('transient initial navigation failure retries once before revealing the reader', async () => {
  let attempts = 0;
  const view = {
    open: async () => {},
    init: async () => assert.fail('must not replace saved progress with first page'),
    goToStable: async () => ++attempts === 2 ? { index: 5 } : false,
  };
  await openFoliateBook(view, { sections: [] }, 'saved-location');
  assert.equal(attempts, 2);
});

test('closing the reader during a failed attempt prevents further retry', async () => {
  let attempts = 0;
  const view = {
    isConnected: true,
    open: async () => {},
    goToStable: async () => { attempts += 1; view.isConnected = false; return false; },
  };
  await assert.rejects(openFoliateBook(view, { sections: [] }, 'saved-location'), { name: 'AbortError' });
  assert.equal(attempts, 1);
});

test('truthy first-page resume is rejected when the saved progress was well into the book', async () => {
  let attempts = 0;
  const view = {
    open: async () => {},
    lastLocation: { fraction: 0 },
    goToStable: async () => { attempts++; return { index: 0 }; },
    init: async () => assert.fail('must not reset progress to the beginning'),
  };
  await assert.rejects(
    openFoliateBook(view, { sections: [] }, 'saved-location', undefined, undefined, 50),
    /저장된 읽기 위치를 복원하지 못했습니다/,
  );
  assert.equal(attempts, 2);
});

test('a saved anchor can recover a truthy but incorrect first-page primary target', async () => {
  const targets = [];
  const view = {
    open: async () => {},
    goToStable: async target => {
      targets.push(target);
      view.lastLocation = { fraction: target === 'saved-anchor' ? 0.5 : 0 };
      return { index: target === 'saved-anchor' ? 20 : 0 };
    },
  };
  await openFoliateBook(view, { sections: [] }, 'saved-location', undefined, 'saved-anchor', 50);
  assert.deepEqual(targets, ['saved-location', 'saved-anchor']);
  view.lastLocation = { fraction: 0 };
  await openFoliateBook(view, { sections: [] }, 'saved-location', undefined, undefined, 0);
});

test('open diagnostics compare expected and actual progress without exposing raw targets', async () => {
  const previousWindow = globalThis.window;
  const storage = new Map();
  globalThis.window = Object.assign(new EventTarget(), {
    innerWidth: 720, innerHeight: 760,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  });
  try {
    const view = {
      open: async () => {},
      lastLocation: { fraction: 0.5 },
      renderer: { page: 10, pages: 20 },
      goToStable: async () => ({ index: 5 }),
    };
    await openFoliateBook(view, { sections: [] }, 'private-cfi', undefined, 'private-anchor', 50);
    const trace = readReaderOpenPerformanceTrace();
    const resume = trace.find(event => event.phase === 'foliate-initial-navigation');
    assert.equal(resume.expectedPercent, 50);
    assert.equal(resume.actualPercent, 50);
    assert.equal(resume.actualPage, 10);
    assert.equal(typeof resume.targetHash, 'string');
    assert.equal(typeof resume.anchorHash, 'string');
    assert.equal(JSON.stringify(trace).includes('private-'), false);
    view.goToStable = async target => {
      view.lastLocation.fraction = target === 'private-anchor' ? 0.5 : 0;
      return { index: 0 };
    };
    await openFoliateBook(view, { sections: [] }, 'private-cfi', undefined, 'private-anchor', 50);
    const recovered = readReaderResumeFailures().at(-1);
    assert.equal(recovered.reason, 'progress-mismatch');
    assert.equal(recovered.status, 'recovered');
    assert.equal(recovered.expectedPercent, 50);
    assert.equal(recovered.actualPercent, 50);
    await assert.rejects(openFoliateBook(view, { sections: [] }, 'private-cfi', undefined, undefined, 50));
    const failed = readReaderResumeFailures().at(-1);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.actualPercent, 0);
    assert.equal(JSON.stringify([...storage.values()]).includes('private-'), false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});


test('failed and recovered opens persist only a compact diagnostic, successful opens write nothing', async () => {
  const previousWindow = globalThis.window;
  const storage = new Map();
  const target = new EventTarget();
  globalThis.window = Object.assign(target, {
    innerWidth: 720, innerHeight: 760,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  });
  try {
    const makeView = (failures) => {
      let attempts = 0;
      return {
        open: async () => {}, renderer: { page: 0, pages: 30 },
        goToStable: async () => ++attempts > failures ? { index: 0 } : false,
      };
    };
    await openFoliateBook(makeView(0), { sections: [] }, 'private-cfi');
    assert.equal(storage.size, 0);
    await openFoliateBook(makeView(1), { sections: [] }, 'private-cfi');
    assert.equal(readReaderResumeFailures()[0].status, 'recovered');
    assert.equal(readReaderResumeFailures()[0].attempts, 2);
    await assert.rejects(openFoliateBook(makeView(2), { sections: [] }, 'private-cfi'));
    const records = readReaderResumeFailures();
    assert.equal(records.at(-1).status, 'failed');
    assert.equal(records.at(-1).viewportWidth, 720);
    assert.equal(JSON.stringify([...storage.values()]).includes('private-cfi'), false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
