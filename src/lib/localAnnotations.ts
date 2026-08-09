import type { Annotation, AnnotationAnchorState } from '../types';
import type { OwnerKey } from './ownerIdentity';
import {
  ANNOTATION_BOOK_LIMIT,
  ANNOTATION_COLOR_LIMIT,
  ANNOTATION_NOTE_MAX_LENGTH,
  isAnnotation,
  isHighlightColorId,
} from './annotationPolicy';
import type { HighlightColorId } from '../types';
import { initDB } from './localDB';
import {
  V5_OUTBOX_STORE,
  V5_REMOTE_HEADS_STORE,
  V5_SYNC_CONFLICTS_STORE,
  V5_SYNC_META_STORE,
  V8_ANNOTATIONS_STORE,
  V10_ANNOTATION_BOOK_DELETIONS_STORE,
} from './localDBSchema';
import { trackLocalCommit } from './localCommitTracker';
import { toAnnotationSyncPayloadV1 } from './annotationSyncSchema';
import {
  appendAnnotationEventsToTransactionV5,
  type AnnotationSyncContextV5,
  type EnqueueAnnotationInputV5,
} from './syncOutboxV5';
import { notifyProgressSyncWork } from './progressSyncWake';
import { broadcastAnnotationSyncChange } from './annotationSyncWake';

export type StoredAnnotationV8 = Annotation & { ownerKey: OwnerKey };
export type LocalAnnotationSyncContext = AnnotationSyncContextV5;

const mutationStoreNames = [
  V8_ANNOTATIONS_STORE,
  V5_OUTBOX_STORE,
  V5_SYNC_META_STORE,
  V5_SYNC_CONFLICTS_STORE,
  V5_REMOTE_HEADS_STORE,
  V10_ANNOTATION_BOOK_DELETIONS_STORE,
];

const toUpsertInput = (annotation: Annotation): EnqueueAnnotationInputV5 => ({
  bookId: annotation.bookId,
  annotationId: annotation.id,
  operation: 'annotation.upsert',
  payload: toAnnotationSyncPayloadV1(annotation),
  occurredAtClient: annotation.updatedAtClient,
});

const toDeleteInput = (annotation: Annotation): EnqueueAnnotationInputV5 => ({
  bookId: annotation.bookId,
  annotationId: annotation.id,
  operation: 'annotation.delete',
  payload: null,
  occurredAtClient: Math.max(Date.now(), annotation.updatedAtClient + 1),
});

const appendSyncEvents = async (
  tx: Parameters<typeof appendAnnotationEventsToTransactionV5>[0],
  ownerKey: OwnerKey,
  inputs: ReadonlyArray<EnqueueAnnotationInputV5>,
  syncContext?: LocalAnnotationSyncContext,
) => syncContext
  ? appendAnnotationEventsToTransactionV5(tx, ownerKey, inputs, syncContext)
  : [];

const notifyCommittedMutation = (
  ownerKey: OwnerKey,
  bookId: string,
  eventCount: number,
) => {
  if (eventCount > 0) notifyProgressSyncWork(ownerKey);
  broadcastAnnotationSyncChange({ ownerKey, bookId });
};

export type SaveLocalAnnotationResult =
  | { status: 'saved'; annotation: Annotation }
  | { status: 'book-limit' }
  | { status: 'color-limit' }
  | { status: 'duplicate-range'; annotation: Annotation };

export type AnnotationMutableFields = Pick<
  Annotation,
  | 'sectionIndex'
  | 'rangeCfi'
  | 'quote'
  | 'prefix'
  | 'suffix'
  | 'colorId'
  | 'note'
  | 'progressPercent'
  | 'chapter'
  | 'anchorState'
>;

export type AnnotationFieldPatchV8 = {
  id: string;
  fields: Partial<AnnotationMutableFields>;
  expected?: Partial<AnnotationMutableFields>;
};

export type UpdateLocalAnnotationFieldsResult =
  | { status: 'saved'; before: Annotation; annotation: Annotation }
  | { status: 'unchanged'; annotation: Annotation }
  | { status: 'missing' }
  | { status: 'color-limit' }
  | { status: 'duplicate-range'; annotation: Annotation };

export type RestoreLocalAnnotationFieldsResult =
  | { status: 'saved'; annotations: Annotation[] }
  | { status: 'conflict' }
  | { status: 'color-limit' }
  | { status: 'duplicate-range' };

export type RestoreLocalAnnotationsResult =
  | { status: 'saved'; annotations: Annotation[] }
  | { status: 'conflict' }
  | { status: 'book-limit' }
  | { status: 'color-limit' }
  | { status: 'duplicate-range' };

export type DeleteLocalAnnotationsIfUnchangedResult =
  | { status: 'deleted'; annotations: Annotation[] }
  | { status: 'conflict' };

const withoutOwner = ({ ownerKey, ...annotation }: StoredAnnotationV8): Annotation => {
  void ownerKey;
  return annotation;
};

const fieldEntries = (fields: Partial<AnnotationMutableFields>) => (
  Object.entries(fields) as Array<[
    keyof AnnotationMutableFields,
    AnnotationMutableFields[keyof AnnotationMutableFields],
  ]>
);

const hasExpectedFields = (
  annotation: StoredAnnotationV8,
  expected: Partial<AnnotationMutableFields> | undefined,
) => !expected || fieldEntries(expected).every(([field, value]) => annotation[field] === value);

const validateAnnotationSet = (annotations: ReadonlyArray<Annotation>) => {
  if (annotations.some((annotation) => !isAnnotation(annotation))) return 'conflict' as const;
  if (annotations.length > ANNOTATION_BOOK_LIMIT) return 'book-limit' as const;
  const ranges = new Set<string>();
  const colorCounts = new Map<HighlightColorId, number>();
  for (const annotation of annotations) {
    if (ranges.has(annotation.rangeCfi)) return 'duplicate-range' as const;
    ranges.add(annotation.rangeCfi);
    const colorCount = (colorCounts.get(annotation.colorId) ?? 0) + 1;
    if (colorCount > ANNOTATION_COLOR_LIMIT) return 'color-limit' as const;
    colorCounts.set(annotation.colorId, colorCount);
  }
  return null;
};

// Creation undo must ignore renderer-owned resolution fields. They can change
// immediately after save without representing a newer user decision.
const sameUserManagedAnnotation = (left: Annotation, right: Annotation) => (
  left.id === right.id
  && left.bookId === right.bookId
  && left.type === right.type
  && left.rangeCfi === right.rangeCfi
  && left.quote === right.quote
  && left.prefix === right.prefix
  && left.suffix === right.suffix
  && left.colorId === right.colorId
  && left.note === right.note
  && left.progressPercent === right.progressPercent
  && left.chapter === right.chapter
  && left.createdAtClient === right.createdAtClient
  && left.updatedAtClient === right.updatedAtClient
);

export const getLocalAnnotationsV8 = async (
  ownerKey: OwnerKey,
  bookId: string,
) => {
  const db = await initDB();
  const records = await db.getAllFromIndex(
    V8_ANNOTATIONS_STORE,
    'by-owner-book',
    [ownerKey, bookId],
  ) as StoredAnnotationV8[];
  return records
    .filter(isAnnotation)
    .map(withoutOwner)
    .sort((a, b) => a.createdAtClient - b.createdAtClient);
};

export const getAllLocalAnnotationsV8 = async (ownerKey: OwnerKey) => {
  const db = await initDB();
  const records = await db.getAllFromIndex(
    V8_ANNOTATIONS_STORE,
    'by-owner',
    ownerKey,
  ) as StoredAnnotationV8[];
  return records
    .filter(isAnnotation)
    .map(withoutOwner)
    .sort((left, right) => (
      left.bookId.localeCompare(right.bookId)
      || left.createdAtClient - right.createdAtClient
      || left.id.localeCompare(right.id)
    ));
};

export const saveLocalAnnotationV8 = (
  ownerKey: OwnerKey,
  annotation: Annotation,
  syncContext?: LocalAnnotationSyncContext,
): Promise<SaveLocalAnnotationResult> => trackLocalCommit((async () => {
  if (!isAnnotation(annotation)) throw new TypeError('Invalid local annotation');

  const db = await initDB();
  const tx = db.transaction(mutationStoreNames, 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V8_ANNOTATIONS_STORE);
  const key = [ownerKey, annotation.bookId, annotation.id];
  const existing = await store.get(key) as StoredAnnotationV8 | undefined;
  const duplicate = await store.index('by-owner-book-range').get([
    ownerKey,
    annotation.bookId,
    annotation.rangeCfi,
  ]) as StoredAnnotationV8 | undefined;

  if (duplicate && duplicate.id !== annotation.id) {
    await tx.done;
    return { status: 'duplicate-range', annotation: withoutOwner(duplicate) };
  }

  if (!existing) {
    const total = await store.index('by-owner-book').count([ownerKey, annotation.bookId]);
    if (total >= ANNOTATION_BOOK_LIMIT) {
      await tx.done;
      return { status: 'book-limit' };
    }
  }

  if (!existing || existing.colorId !== annotation.colorId) {
    const colorTotal = await store.index('by-owner-book-color').count([
      ownerKey,
      annotation.bookId,
      annotation.colorId,
    ]);
    if (colorTotal >= ANNOTATION_COLOR_LIMIT) {
      await tx.done;
      return { status: 'color-limit' };
    }
  }

  const events = await appendSyncEvents(tx, ownerKey, [toUpsertInput(annotation)], syncContext);
  if (!existing) {
    await tx.objectStore(V10_ANNOTATION_BOOK_DELETIONS_STORE).delete([
      ownerKey,
      annotation.bookId,
    ]);
  }
  await store.put({ ...annotation, ownerKey });
  await tx.done;
  notifyCommittedMutation(ownerKey, annotation.bookId, events.length);
  return { status: 'saved', annotation };
})());

export const updateLocalAnnotationFieldsV8 = (
  ownerKey: OwnerKey,
  bookId: string,
  annotationId: string,
  fields: Partial<AnnotationMutableFields>,
  syncContext?: LocalAnnotationSyncContext,
): Promise<UpdateLocalAnnotationFieldsResult> => trackLocalCommit((async () => {
  const db = await initDB();
  const tx = db.transaction(mutationStoreNames, 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V8_ANNOTATIONS_STORE);
  const key = [ownerKey, bookId, annotationId];
  const existing = await store.get(key) as StoredAnnotationV8 | undefined;
  if (!existing || !isAnnotation(existing)) {
    await tx.done;
    return { status: 'missing' };
  }
  if (fieldEntries(fields).every(([field, value]) => existing[field] === value)) {
    await tx.done;
    return { status: 'unchanged', annotation: withoutOwner(existing) };
  }
  const next: StoredAnnotationV8 = {
    ...existing,
    ...fields,
    updatedAtClient: Math.max(Date.now(), existing.updatedAtClient + 1),
  };
  if (!isAnnotation(next)) throw new TypeError('Invalid local annotation field update');
  const duplicate = await store.index('by-owner-book-range').get([
    ownerKey,
    bookId,
    next.rangeCfi,
  ]) as StoredAnnotationV8 | undefined;
  if (duplicate && duplicate.id !== annotationId) {
    await tx.done;
    return { status: 'duplicate-range', annotation: withoutOwner(duplicate) };
  }
  if (existing.colorId !== next.colorId) {
    const targetCount = await store.index('by-owner-book-color').count([
      ownerKey,
      bookId,
      next.colorId,
    ]);
    if (targetCount >= ANNOTATION_COLOR_LIMIT) {
      await tx.done;
      return { status: 'color-limit' };
    }
  }
  const events = await appendSyncEvents(
    tx,
    ownerKey,
    [toUpsertInput(withoutOwner(next))],
    syncContext,
  );
  await store.put(next);
  await tx.done;
  notifyCommittedMutation(ownerKey, bookId, events.length);
  return {
    status: 'saved',
    before: withoutOwner(existing),
    annotation: withoutOwner(next),
  };
})());

export const restoreLocalAnnotationFieldsV8 = (
  ownerKey: OwnerKey,
  bookId: string,
  patches: ReadonlyArray<AnnotationFieldPatchV8>,
  syncContext?: LocalAnnotationSyncContext,
): Promise<RestoreLocalAnnotationFieldsResult> => trackLocalCommit((async () => {
  const uniquePatches = new Map(patches.filter(({ id }) => Boolean(id)).map((patch) => [patch.id, patch]));
  if (uniquePatches.size === 0) return { status: 'saved', annotations: [] };
  const db = await initDB();
  const tx = db.transaction(mutationStoreNames, 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V8_ANNOTATIONS_STORE);
  const stored = await store.index('by-owner-book').getAll([ownerKey, bookId]) as StoredAnnotationV8[];
  const records = stored.filter(isAnnotation);
  const recordsById = new Map(records.map((annotation) => [annotation.id, annotation]));
  const now = Date.now();
  const updated: StoredAnnotationV8[] = [];
  let offset = 0;
  for (const patch of uniquePatches.values()) {
    const existing = recordsById.get(patch.id);
    if (!existing || !hasExpectedFields(existing, patch.expected)) {
      await tx.done;
      return { status: 'conflict' };
    }
    const next: StoredAnnotationV8 = {
      ...existing,
      ...patch.fields,
      updatedAtClient: Math.max(now + offset, existing.updatedAtClient + 1),
    };
    offset += 1;
    recordsById.set(next.id, next);
    updated.push(next);
  }
  const validation = validateAnnotationSet([...recordsById.values()].map(withoutOwner));
  if (validation) {
    await tx.done;
    return { status: validation === 'book-limit' ? 'conflict' : validation };
  }
  const events = await appendSyncEvents(
    tx,
    ownerKey,
    updated.map((annotation) => toUpsertInput(withoutOwner(annotation))),
    syncContext,
  );
  for (const annotation of updated) await store.put(annotation);
  await tx.done;
  notifyCommittedMutation(ownerKey, bookId, events.length);
  return { status: 'saved', annotations: updated.map(withoutOwner) };
})());

export const restoreLocalAnnotationsV8 = (
  ownerKey: OwnerKey,
  bookId: string,
  annotations: ReadonlyArray<Annotation>,
  syncContext?: LocalAnnotationSyncContext,
): Promise<RestoreLocalAnnotationsResult> => trackLocalCommit((async () => {
  const unique = new Map(annotations.map((annotation) => [annotation.id, annotation]));
  if (unique.size === 0) return { status: 'saved', annotations: [] };
  if ([...unique.values()].some((annotation) => (
    annotation.bookId !== bookId || !isAnnotation(annotation)
  ))) throw new TypeError('Invalid local annotations to restore');
  const db = await initDB();
  const tx = db.transaction(mutationStoreNames, 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V8_ANNOTATIONS_STORE);
  const stored = await store.index('by-owner-book').getAll([ownerKey, bookId]) as StoredAnnotationV8[];
  const current = stored.filter(isAnnotation).map(withoutOwner);
  const currentIds = new Set(current.map(({ id }) => id));
  const currentRanges = new Set(current.map(({ rangeCfi }) => rangeCfi));
  if ([...unique.values()].some(({ id, rangeCfi }) => (
    currentIds.has(id) || currentRanges.has(rangeCfi)
  ))) {
    await tx.done;
    return { status: 'conflict' };
  }
  const now = Date.now();
  const restored = [...unique.values()].map((annotation, index) => ({
    ...annotation,
    updatedAtClient: Math.max(now + index, annotation.updatedAtClient + 1),
  }));
  const validation = validateAnnotationSet([...current, ...restored]);
  if (validation) {
    await tx.done;
    return { status: validation };
  }
  const events = await appendSyncEvents(
    tx,
    ownerKey,
    restored.map(toUpsertInput),
    syncContext,
  );
  for (const annotation of restored) await store.put({ ...annotation, ownerKey });
  await tx.done;
  notifyCommittedMutation(ownerKey, bookId, events.length);
  return { status: 'saved', annotations: restored };
})());

export const deleteLocalAnnotationV8 = (
  ownerKey: OwnerKey,
  bookId: string,
  annotationId: string,
  syncContext?: LocalAnnotationSyncContext,
) => trackLocalCommit((async () => {
  const db = await initDB();
  const tx = db.transaction(mutationStoreNames, 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V8_ANNOTATIONS_STORE);
  const key = [ownerKey, bookId, annotationId];
  const existing = await store.get(key) as StoredAnnotationV8 | undefined;
  const events = existing && isAnnotation(existing)
    ? await appendSyncEvents(
      tx,
      ownerKey,
      [toDeleteInput(withoutOwner(existing))],
      syncContext,
    )
    : [];
  if (existing) await store.delete(key);
  await tx.done;
  if (existing) notifyCommittedMutation(ownerKey, bookId, events.length);
  return existing ? withoutOwner(existing) : null;
})());

export const deleteLocalAnnotationsV8 = (
  ownerKey: OwnerKey,
  bookId: string,
  annotationIds: ReadonlyArray<string>,
  syncContext?: LocalAnnotationSyncContext,
) => trackLocalCommit((async () => {
  const ids = [...new Set(annotationIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const db = await initDB();
  const tx = db.transaction(mutationStoreNames, 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V8_ANNOTATIONS_STORE);
  const deleted: Annotation[] = [];
  for (const annotationId of ids) {
    const key = [ownerKey, bookId, annotationId];
    const existing = await store.get(key) as StoredAnnotationV8 | undefined;
    if (!existing || !isAnnotation(existing)) continue;
    deleted.push(withoutOwner(existing));
  }
  const events = await appendSyncEvents(
    tx,
    ownerKey,
    deleted.map(toDeleteInput),
    syncContext,
  );
  for (const annotation of deleted) {
    await store.delete([ownerKey, bookId, annotation.id]);
  }
  await tx.done;
  if (deleted.length > 0) notifyCommittedMutation(ownerKey, bookId, events.length);
  return deleted;
})());

export const deleteLocalAnnotationsIfUnchangedV8 = (
  ownerKey: OwnerKey,
  bookId: string,
  expectedAnnotations: ReadonlyArray<Annotation>,
  syncContext?: LocalAnnotationSyncContext,
): Promise<DeleteLocalAnnotationsIfUnchangedResult> => trackLocalCommit((async () => {
  const unique = new Map(expectedAnnotations.map((annotation) => [annotation.id, annotation]));
  if (unique.size === 0) return { status: 'deleted', annotations: [] };
  const db = await initDB();
  const tx = db.transaction(mutationStoreNames, 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V8_ANNOTATIONS_STORE);
  const current: StoredAnnotationV8[] = [];
  for (const expected of unique.values()) {
    const existing = await store.get([ownerKey, bookId, expected.id]) as StoredAnnotationV8 | undefined;
    if (
      !existing
      || !isAnnotation(existing)
      || !sameUserManagedAnnotation(withoutOwner(existing), expected)
    ) {
      await tx.done;
      return { status: 'conflict' };
    }
    current.push(existing);
  }
  const deleted = current.map(withoutOwner);
  const events = await appendSyncEvents(
    tx,
    ownerKey,
    deleted.map(toDeleteInput),
    syncContext,
  );
  for (const annotation of current) {
    await store.delete([ownerKey, bookId, annotation.id]);
  }
  await tx.done;
  notifyCommittedMutation(ownerKey, bookId, events.length);
  return { status: 'deleted', annotations: deleted };
})());

export const updateLocalAnnotationNoteV8 = (
  ownerKey: OwnerKey,
  bookId: string,
  annotationId: string,
  note: string,
  syncContext?: LocalAnnotationSyncContext,
) => trackLocalCommit((async () => {
  if (typeof note !== 'string' || note.length > ANNOTATION_NOTE_MAX_LENGTH) {
    throw new TypeError('Invalid annotation note');
  }
  const db = await initDB();
  const tx = db.transaction(mutationStoreNames, 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V8_ANNOTATIONS_STORE);
  const key = [ownerKey, bookId, annotationId];
  const existing = await store.get(key) as StoredAnnotationV8 | undefined;
  if (!existing || !isAnnotation(existing)) {
    await tx.done;
    return null;
  }
  const next: StoredAnnotationV8 = {
    ...existing,
    note,
    updatedAtClient: Math.max(Date.now(), existing.updatedAtClient + 1),
  };
  const events = await appendSyncEvents(
    tx,
    ownerKey,
    [toUpsertInput(withoutOwner(next))],
    syncContext,
  );
  await store.put(next);
  await tx.done;
  notifyCommittedMutation(ownerKey, bookId, events.length);
  return withoutOwner(next);
})());

export type UpdateLocalAnnotationColorsResult =
  | { status: 'saved'; before: Annotation[]; annotations: Annotation[] }
  | { status: 'color-limit' };

export const updateLocalAnnotationColorsV8 = (
  ownerKey: OwnerKey,
  bookId: string,
  annotationIds: ReadonlyArray<string>,
  colorId: HighlightColorId,
  syncContext?: LocalAnnotationSyncContext,
): Promise<UpdateLocalAnnotationColorsResult> => trackLocalCommit((async () => {
  if (!isHighlightColorId(colorId)) throw new TypeError('Invalid highlight color');
  const ids = [...new Set(annotationIds.filter(Boolean))];
  if (ids.length === 0) return { status: 'saved', before: [], annotations: [] };
  const db = await initDB();
  const tx = db.transaction(mutationStoreNames, 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V8_ANNOTATIONS_STORE);
  const records: StoredAnnotationV8[] = [];
  for (const annotationId of ids) {
    const existing = await store.get([ownerKey, bookId, annotationId]) as StoredAnnotationV8 | undefined;
    if (existing && isAnnotation(existing)) records.push(existing);
  }
  const movingRecords = records.filter((annotation) => annotation.colorId !== colorId);
  const movingCount = movingRecords.length;
  if (movingCount > 0) {
    const targetCount = await store.index('by-owner-book-color').count([
      ownerKey,
      bookId,
      colorId,
    ]);
    if (targetCount + movingCount > ANNOTATION_COLOR_LIMIT) {
      await tx.done;
      return { status: 'color-limit' };
    }
  }
  const now = Date.now();
  const updated = movingRecords.map((annotation, index) => ({
    ...annotation,
    colorId,
    updatedAtClient: Math.max(now + index, annotation.updatedAtClient + 1),
  }));
  const events = await appendSyncEvents(
    tx,
    ownerKey,
    updated.map((annotation) => toUpsertInput(withoutOwner(annotation))),
    syncContext,
  );
  for (const annotation of updated) await store.put(annotation);
  await tx.done;
  if (updated.length > 0) notifyCommittedMutation(ownerKey, bookId, events.length);
  return {
    status: 'saved',
    before: movingRecords.map(withoutOwner),
    annotations: updated.map(withoutOwner),
  };
})());

export const deleteLocalAnnotationsForBookV8 = (
  ownerKey: OwnerKey,
  bookId: string,
  syncContext?: LocalAnnotationSyncContext,
) => trackLocalCommit((async () => {
  const db = await initDB();
  const tx = db.transaction(mutationStoreNames, 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V8_ANNOTATIONS_STORE);
  const records = await store.index('by-owner-book').getAll([
    ownerKey,
    bookId,
  ]) as StoredAnnotationV8[];
  const validRecords = records.filter(isAnnotation);
  const events = await appendSyncEvents(
    tx,
    ownerKey,
    validRecords.map((annotation) => toDeleteInput(withoutOwner(annotation))),
    syncContext,
  );
  await Promise.all(validRecords.map((annotation) => (
    store.delete([ownerKey, bookId, annotation.id])
  )));
  await tx.done;
  if (validRecords.length > 0) notifyCommittedMutation(ownerKey, bookId, events.length);
  return validRecords.length;
})());

export const updateLocalAnnotationAnchorStateV8 = (
  ownerKey: OwnerKey,
  bookId: string,
  annotationId: string,
  anchorState: AnnotationAnchorState,
) => trackLocalCommit((async () => {
  const db = await initDB();
  const tx = db.transaction(V8_ANNOTATIONS_STORE, 'readwrite');
  const store = tx.objectStore(V8_ANNOTATIONS_STORE);
  const key = [ownerKey, bookId, annotationId];
  const existing = await store.get(key) as StoredAnnotationV8 | undefined;
  if (!existing || !isAnnotation(existing)) {
    await tx.done;
    return null;
  }
  const next = { ...existing, anchorState };
  await store.put(next);
  await tx.done;
  return withoutOwner(next);
})());

export const updateLocalAnnotationResolutionV8 = (
  ownerKey: OwnerKey,
  bookId: string,
  annotationId: string,
  sectionIndex: number,
) => trackLocalCommit((async () => {
  if (!Number.isSafeInteger(sectionIndex) || sectionIndex < 0) {
    throw new TypeError('Invalid annotation section index');
  }
  const db = await initDB();
  const tx = db.transaction(V8_ANNOTATIONS_STORE, 'readwrite');
  const store = tx.objectStore(V8_ANNOTATIONS_STORE);
  const key = [ownerKey, bookId, annotationId];
  const existing = await store.get(key) as StoredAnnotationV8 | undefined;
  if (!existing || !isAnnotation(existing)) {
    await tx.done;
    return null;
  }
  const next = { ...existing, sectionIndex };
  await store.put(next);
  await tx.done;
  return withoutOwner(next);
})());
