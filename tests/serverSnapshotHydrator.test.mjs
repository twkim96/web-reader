import test from 'node:test';
import assert from 'node:assert/strict';

const { ServerSnapshotHydrator } = await import('../src/lib/serverSnapshotHydrator.ts');

const snapshot = ({ fromCache, docs, changes }) => ({
  metadata: { fromCache },
  docs,
  docChanges: () => changes,
});

test('ignores warm cache and hydrates all documents on the first server snapshot', () => {
  const hydrator = new ServerSnapshotHydrator();
  assert.equal(hydrator.select(snapshot({
    fromCache: true,
    docs: [{ id: 'cached' }],
    changes: [{ type: 'added', doc: { id: 'cached' } }],
  })), null);

  assert.deepEqual(hydrator.select(snapshot({
    fromCache: false,
    docs: [{ id: 'a' }, { id: 'b' }],
    changes: [],
  })), [
    { type: 'added', doc: { id: 'a' } },
    { type: 'added', doc: { id: 'b' } },
  ]);
});

test('uses incremental changes after the first server hydration', () => {
  const hydrator = new ServerSnapshotHydrator();
  hydrator.select(snapshot({ fromCache: false, docs: [], changes: [] }));
  const changes = [{ type: 'removed', doc: { id: 'a' } }];
  assert.equal(hydrator.select(snapshot({
    fromCache: false,
    docs: [{ id: 'ignored-full-doc' }],
    changes,
  })), changes);
});
