import test from 'node:test';
import assert from 'node:assert/strict';

import { openFoliateBook } from '../src/hooks/foliate/openFoliateBook.ts';

test('configures the Foliate renderer before the first section is initialized', async () => {
  const calls = [];
  const source = { sections: [] };
  const view = {
    open: async (openedSource) => {
      assert.equal(openedSource, source);
      calls.push('open');
    },
    init: async ({ lastLocation }) => {
      assert.equal(lastLocation, 'epubcfi(/6/2)');
      calls.push('init');
    },
  };

  await openFoliateBook(
    view,
    source,
    'epubcfi(/6/2)',
    async (openedView) => {
      assert.equal(openedView, view);
      calls.push('style');
    },
  );

  assert.deepEqual(calls, ['open', 'style', 'init']);
});
