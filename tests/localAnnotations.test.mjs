import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { getPendingLocalCommitCount } = await import('../src/lib/localCommitTracker.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const {
  deleteLocalAnnotationV8,
  deleteLocalAnnotationsForBookV8,
  getLocalAnnotationsV8,
  saveLocalAnnotationV8,
  updateLocalAnnotationAnchorStateV8,
  updateLocalAnnotationResolutionV8,
} = await import('../src/lib/localAnnotations.ts');
const { makeFirebaseOwnerKey, makeOwnerKey } = await import('../src/lib/ownerIdentity.ts');

const ownerA = makeOwnerKey(makeFirebaseOwnerKey('alice'), 'library:local');
const ownerB = makeOwnerKey(makeFirebaseOwnerKey('bob'), 'library:local');
const colors = ['yellow', 'green', 'blue', 'pink', 'purple'];

const makeAnnotation = (id, colorId = 'yellow', overrides = {}) => ({
  id,
  bookId: 'book-1',
  type: 'highlight',
  sectionIndex: 0,
  rangeCfi: `epubcfi(/6/2!/4/2,/1:${id.length},/1:${id.length + 1})`,
  quote: `quote ${id}`,
  prefix: 'before',
  suffix: 'after',
  colorId,
  note: '',
  progressPercent: 10,
  chapter: 'Chapter 1',
  createdAtClient: 100,
  updatedAtClient: 100,
  anchorState: 'active',
  ...overrides,
});

const deleteDatabase = async () => {
  await closeLocalDB();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('test database deletion was blocked'));
  });
};

test.beforeEach(deleteDatabase);
test.after(deleteDatabase);

test('isolates local annotations by owner and book with atomic update and delete', async () => {
  const first = makeAnnotation('first');
  const saving = saveLocalAnnotationV8(ownerA, first);
  assert.equal(getPendingLocalCommitCount(), 1);
  assert.equal((await saving).status, 'saved');
  assert.equal(getPendingLocalCommitCount(), 0);
  assert.equal((await saveLocalAnnotationV8(ownerB, {
    ...first,
    colorId: 'blue',
  })).status, 'saved');
  assert.equal((await saveLocalAnnotationV8(ownerA, {
    ...first,
    colorId: 'green',
    updatedAtClient: 101,
  })).status, 'saved');

  assert.deepEqual((await getLocalAnnotationsV8(ownerA, 'book-1')).map(({ colorId }) => colorId), ['green']);
  assert.deepEqual((await getLocalAnnotationsV8(ownerB, 'book-1')).map(({ colorId }) => colorId), ['blue']);
  assert.deepEqual(await getLocalAnnotationsV8(ownerA, 'book-2'), []);

  assert.equal((await deleteLocalAnnotationV8(ownerA, 'book-1', first.id))?.id, first.id);
  assert.deepEqual(await getLocalAnnotationsV8(ownerA, 'book-1'), []);
  assert.equal((await getLocalAnnotationsV8(ownerB, 'book-1')).length, 1);
});

test('rejects a duplicate exact range instead of creating a second annotation', async () => {
  const first = makeAnnotation('first');
  await saveLocalAnnotationV8(ownerA, first);
  const duplicate = await saveLocalAnnotationV8(ownerA, makeAnnotation('second', 'blue', {
    rangeCfi: first.rangeCfi,
  }));
  assert.equal(duplicate.status, 'duplicate-range');
  assert.equal(duplicate.annotation.id, first.id);
  assert.equal((await getLocalAnnotationsV8(ownerA, 'book-1')).length, 1);
});

test('keeps distinct overlapping or containing range CFIs as separate annotations', async () => {
  const first = makeAnnotation('first');
  const overlapping = makeAnnotation('overlapping', 'green', {
    rangeCfi: 'epubcfi(/6/2!/4/2,/1:2,/1:8)',
  });
  assert.equal((await saveLocalAnnotationV8(ownerA, first)).status, 'saved');
  assert.equal((await saveLocalAnnotationV8(ownerA, overlapping)).status, 'saved');
  assert.deepEqual(
    (await getLocalAnnotationsV8(ownerA, 'book-1')).map(({ id }) => id),
    ['first', 'overlapping'],
  );
});

test('deletes only one owner and book annotation partition', async () => {
  await saveLocalAnnotationV8(ownerA, makeAnnotation('owner-a-book-1'));
  await saveLocalAnnotationV8(ownerA, makeAnnotation('owner-a-book-2', 'green', {
    bookId: 'book-2',
  }));
  await saveLocalAnnotationV8(ownerB, makeAnnotation('owner-b-book-1', 'blue'));

  assert.equal(await deleteLocalAnnotationsForBookV8(ownerA, 'book-1'), 1);
  assert.deepEqual(await getLocalAnnotationsV8(ownerA, 'book-1'), []);
  assert.equal((await getLocalAnnotationsV8(ownerA, 'book-2')).length, 1);
  assert.equal((await getLocalAnnotationsV8(ownerB, 'book-1')).length, 1);
});

test('updates only anchor state without overwriting a concurrent user color edit', async () => {
  const first = makeAnnotation('first');
  await saveLocalAnnotationV8(ownerA, first);
  await saveLocalAnnotationV8(ownerA, {
    ...first,
    colorId: 'blue',
    updatedAtClient: 101,
  });
  await updateLocalAnnotationAnchorStateV8(ownerA, 'book-1', first.id, 'unresolved');
  const [saved] = await getLocalAnnotationsV8(ownerA, 'book-1');
  assert.equal(saved.colorId, 'blue');
  assert.equal(saved.updatedAtClient, 101);
  assert.equal(saved.anchorState, 'unresolved');
});

test('updates only resolved section index without overwriting user fields', async () => {
  const first = makeAnnotation('first', 'blue', {
    note: 'preserve me',
    updatedAtClient: 101,
  });
  await saveLocalAnnotationV8(ownerA, first);
  await updateLocalAnnotationResolutionV8(ownerA, 'book-1', first.id, 3);
  const [saved] = await getLocalAnnotationsV8(ownerA, 'book-1');
  assert.equal(saved.sectionIndex, 3);
  assert.equal(saved.colorId, 'blue');
  assert.equal(saved.note, 'preserve me');
  assert.equal(saved.updatedAtClient, 101);
  assert.equal(saved.anchorState, 'active');
  await assert.rejects(
    updateLocalAnnotationResolutionV8(ownerA, 'book-1', first.id, -1),
    /Invalid annotation section index/,
  );
});

test('enforces twenty highlights per color and one hundred per book without eviction', async () => {
  for (const colorId of colors) {
    for (let index = 0; index < 20; index += 1) {
      const id = `${colorId}-${String(index).padStart(2, '0')}`;
      assert.equal((await saveLocalAnnotationV8(
        ownerA,
        makeAnnotation(id, colorId, {
          rangeCfi: `epubcfi(/6/${colors.indexOf(colorId) + 2}!/4/2,/1:${index},/1:${index + 1})`,
        }),
      )).status, 'saved');
    }
    if (colorId === 'yellow') {
      assert.equal((await saveLocalAnnotationV8(
        ownerA,
        makeAnnotation('yellow-overflow', 'yellow', {
          rangeCfi: 'epubcfi(/6/50!/4/2,/1:0,/1:1)',
        }),
      )).status, 'color-limit');
    }
  }

  assert.equal((await getLocalAnnotationsV8(ownerA, 'book-1')).length, 100);
  assert.equal((await saveLocalAnnotationV8(
    ownerA,
    makeAnnotation('overflow', 'yellow', {
      rangeCfi: 'epubcfi(/6/999!/4/2,/1:0,/1:1)',
    }),
  )).status, 'book-limit');
});

test('rejects invalid records before opening a write transaction', async () => {
  await assert.rejects(
    saveLocalAnnotationV8(ownerA, makeAnnotation('bad', 'orange')),
    /Invalid local annotation/,
  );
  assert.deepEqual(await getLocalAnnotationsV8(ownerA, 'book-1'), []);
});
