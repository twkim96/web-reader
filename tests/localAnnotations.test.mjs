import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { getPendingLocalCommitCount } = await import('../src/lib/localCommitTracker.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const {
  deleteLocalAnnotationV8,
  deleteLocalAnnotationsIfUnchangedV8,
  deleteLocalAnnotationsV8,
  deleteLocalAnnotationsForBookV8,
  getAllLocalAnnotationsV8,
  getLocalAnnotationsV8,
  restoreLocalAnnotationFieldsV8,
  restoreLocalAnnotationsV8,
  saveLocalAnnotationV8,
  updateLocalAnnotationFieldsV8,
  updateLocalAnnotationColorsV8,
  updateLocalAnnotationAnchorStateV8,
  updateLocalAnnotationNoteV8,
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

test('reads every book annotation for one owner without crossing owner boundaries', async () => {
  await saveLocalAnnotationV8(ownerA, makeAnnotation('book-2', 'green', {
    bookId: 'book-2',
  }));
  await saveLocalAnnotationV8(ownerA, makeAnnotation('book-1'));
  await saveLocalAnnotationV8(ownerB, makeAnnotation('other-owner', 'blue'));
  assert.deepEqual(
    (await getAllLocalAnnotationsV8(ownerA)).map(({ bookId, id }) => `${bookId}:${id}`),
    ['book-1:book-1', 'book-2:book-2'],
  );
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

test('updates a note without overwriting color or anchor state', async () => {
  const first = makeAnnotation('first', 'blue', { anchorState: 'unresolved' });
  await saveLocalAnnotationV8(ownerA, first);
  const updated = await updateLocalAnnotationNoteV8(
    ownerA,
    'book-1',
    first.id,
    '긴 메모\n두 번째 줄',
  );
  assert.equal(updated.note, '긴 메모\n두 번째 줄');
  assert.equal(updated.colorId, 'blue');
  assert.equal(updated.anchorState, 'unresolved');
  assert.equal(updated.updatedAtClient > first.updatedAtClient, true);
  await assert.rejects(
    updateLocalAnnotationNoteV8(ownerA, 'book-1', first.id, 'x'.repeat(4001)),
    /Invalid annotation note/,
  );
});

test('updates only selected fields on the latest record from another tab', async () => {
  const first = makeAnnotation('first');
  await saveLocalAnnotationV8(ownerA, first);
  await saveLocalAnnotationV8(ownerA, {
    ...first,
    note: 'newer note from another tab',
    anchorState: 'unresolved',
    updatedAtClient: 101,
  });

  const result = await updateLocalAnnotationFieldsV8(
    ownerA,
    'book-1',
    first.id,
    { colorId: 'blue', quote: 'reselected quote', anchorState: 'active' },
  );
  assert.equal(result.status, 'saved');
  assert.equal(result.before.note, 'newer note from another tab');
  const [saved] = await getLocalAnnotationsV8(ownerA, 'book-1');
  assert.equal(saved.colorId, 'blue');
  assert.equal(saved.quote, 'reselected quote');
  assert.equal(saved.note, 'newer note from another tab');
  assert.equal(saved.anchorState, 'active');
});

test('field undo preserves unrelated concurrent fields and rejects same-field conflicts', async () => {
  const first = makeAnnotation('first', 'blue', { note: 'original note' });
  await saveLocalAnnotationV8(ownerA, first);
  const changed = await updateLocalAnnotationFieldsV8(
    ownerA,
    'book-1',
    first.id,
    { colorId: 'green' },
  );
  assert.equal(changed.status, 'saved');
  await updateLocalAnnotationNoteV8(
    ownerA,
    'book-1',
    first.id,
    'newer note from another tab',
  );

  const undone = await restoreLocalAnnotationFieldsV8(ownerA, 'book-1', [{
    id: first.id,
    fields: { colorId: 'blue' },
    expected: { colorId: 'green' },
  }]);
  assert.equal(undone.status, 'saved');
  assert.equal(undone.annotations[0].colorId, 'blue');
  assert.equal(undone.annotations[0].note, 'newer note from another tab');

  const conflict = await restoreLocalAnnotationFieldsV8(ownerA, 'book-1', [{
    id: first.id,
    fields: { note: 'original note' },
    expected: { note: 'stale expected note' },
  }]);
  assert.equal(conflict.status, 'conflict');
  assert.equal((await getLocalAnnotationsV8(ownerA, 'book-1'))[0].note, 'newer note from another tab');
});

test('creation undo does not delete a record changed by another tab', async () => {
  const created = makeAnnotation('created');
  await saveLocalAnnotationV8(ownerA, created);
  await updateLocalAnnotationNoteV8(
    ownerA,
    'book-1',
    created.id,
    'note added from another tab',
  );

  const result = await deleteLocalAnnotationsIfUnchangedV8(
    ownerA,
    'book-1',
    [created],
  );
  assert.equal(result.status, 'conflict');
  assert.equal((await getLocalAnnotationsV8(ownerA, 'book-1'))[0].note, 'note added from another tab');
});

test('creation undo ignores internal anchor and section resolution changes', async () => {
  const anchorAdjusted = makeAnnotation('anchor-adjusted');
  const sectionAdjusted = makeAnnotation('section-adjusted', 'green', {
    rangeCfi: 'epubcfi(/6/8!/4/2,/1:0,/1:1)',
  });
  await saveLocalAnnotationV8(ownerA, anchorAdjusted);
  await saveLocalAnnotationV8(ownerA, sectionAdjusted);
  await updateLocalAnnotationAnchorStateV8(
    ownerA,
    'book-1',
    anchorAdjusted.id,
    'unresolved',
  );
  await updateLocalAnnotationResolutionV8(
    ownerA,
    'book-1',
    sectionAdjusted.id,
    7,
  );

  const result = await deleteLocalAnnotationsIfUnchangedV8(
    ownerA,
    'book-1',
    [anchorAdjusted, sectionAdjusted],
  );
  assert.equal(result.status, 'deleted');
  assert.deepEqual(
    result.annotations.map(({ anchorState, sectionIndex }) => ({ anchorState, sectionIndex })),
    [
      { anchorState: 'unresolved', sectionIndex: 0 },
      { anchorState: 'active', sectionIndex: 7 },
    ],
  );
  assert.deepEqual(await getLocalAnnotationsV8(ownerA, 'book-1'), []);
});

test('creation undo still rejects a newer color edit', async () => {
  const created = makeAnnotation('created-color');
  await saveLocalAnnotationV8(ownerA, created);
  const recolored = await updateLocalAnnotationColorsV8(
    ownerA,
    'book-1',
    [created.id],
    'purple',
  );
  assert.equal(recolored.status, 'saved');

  const result = await deleteLocalAnnotationsIfUnchangedV8(
    ownerA,
    'book-1',
    [created],
  );
  assert.equal(result.status, 'conflict');
  assert.equal((await getLocalAnnotationsV8(ownerA, 'book-1'))[0].colorId, 'purple');
});

test('field undo validates the whole batch before applying any inverse write', async () => {
  for (let index = 0; index < 19; index += 1) {
    await saveLocalAnnotationV8(ownerA, makeAnnotation(`yellow-${index}`, 'yellow', {
      rangeCfi: `epubcfi(/6/10!/4/2,/1:${index},/1:${index + 1})`,
    }));
  }
  const first = makeAnnotation('first-blue', 'blue', {
    rangeCfi: 'epubcfi(/6/12!/4/2,/1:0,/1:1)',
  });
  const second = makeAnnotation('second-blue', 'blue', {
    rangeCfi: 'epubcfi(/6/14!/4/2,/1:0,/1:1)',
  });
  await saveLocalAnnotationV8(ownerA, first);
  await saveLocalAnnotationV8(ownerA, second);

  const result = await restoreLocalAnnotationFieldsV8(ownerA, 'book-1', [first, second].map(({ id }) => ({
    id,
    fields: { colorId: 'yellow' },
    expected: { colorId: 'blue' },
  })));
  assert.equal(result.status, 'color-limit');
  const saved = await getLocalAnnotationsV8(ownerA, 'book-1');
  assert.deepEqual(
    saved.filter(({ id }) => id === first.id || id === second.id).map(({ colorId }) => colorId),
    ['blue', 'blue'],
  );
});

test('deleted batch restore is atomic when a limit would be exceeded', async () => {
  for (let index = 0; index < 20; index += 1) {
    await saveLocalAnnotationV8(ownerA, makeAnnotation(`yellow-${index}`, 'yellow', {
      rangeCfi: `epubcfi(/6/20!/4/2,/1:${index},/1:${index + 1})`,
    }));
  }
  const deletedGreen = makeAnnotation('restore-green', 'green', {
    rangeCfi: 'epubcfi(/6/22!/4/2,/1:0,/1:1)',
  });
  const deletedYellow = makeAnnotation('restore-yellow', 'yellow', {
    rangeCfi: 'epubcfi(/6/24!/4/2,/1:0,/1:1)',
  });
  const result = await restoreLocalAnnotationsV8(
    ownerA,
    'book-1',
    [deletedGreen, deletedYellow],
  );
  assert.equal(result.status, 'color-limit');
  const saved = await getLocalAnnotationsV8(ownerA, 'book-1');
  assert.equal(saved.some(({ id }) => id === deletedGreen.id), false);
  assert.equal(saved.some(({ id }) => id === deletedYellow.id), false);
});

test('changes and deletes multiple annotations in one owner and book partition', async () => {
  const first = makeAnnotation('first');
  const second = makeAnnotation('second', 'green', {
    rangeCfi: 'epubcfi(/6/2!/4/2,/1:3,/1:4)',
  });
  await saveLocalAnnotationV8(ownerA, first);
  await saveLocalAnnotationV8(ownerA, second);
  await saveLocalAnnotationV8(ownerB, makeAnnotation('first', 'purple'));

  const recolored = await updateLocalAnnotationColorsV8(
    ownerA,
    'book-1',
    [first.id, second.id, second.id],
    'blue',
  );
  assert.equal(recolored.status, 'saved');
  assert.deepEqual(recolored.annotations.map(({ colorId }) => colorId), ['blue', 'blue']);

  const deleted = await deleteLocalAnnotationsV8(ownerA, 'book-1', [first.id, second.id]);
  assert.equal(deleted.length, 2);
  assert.deepEqual(await getLocalAnnotationsV8(ownerA, 'book-1'), []);
  assert.equal((await getLocalAnnotationsV8(ownerB, 'book-1'))[0].colorId, 'purple');
});

test('rejects a batch recolor that would exceed the target color limit', async () => {
  for (let index = 0; index < 20; index += 1) {
    await saveLocalAnnotationV8(ownerA, makeAnnotation(`blue-${index}`, 'blue', {
      rangeCfi: `epubcfi(/6/4!/4/2,/1:${index},/1:${index + 1})`,
    }));
  }
  const green = makeAnnotation('green', 'green', {
    rangeCfi: 'epubcfi(/6/6!/4/2,/1:0,/1:1)',
  });
  await saveLocalAnnotationV8(ownerA, green);
  const result = await updateLocalAnnotationColorsV8(ownerA, 'book-1', [green.id], 'blue');
  assert.equal(result.status, 'color-limit');
  assert.equal((await getLocalAnnotationsV8(ownerA, 'book-1')).find(({ id }) => id === green.id).colorId, 'green');
  await assert.rejects(
    updateLocalAnnotationColorsV8(ownerA, 'book-1', [green.id], 'orange'),
    /Invalid highlight color/,
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
