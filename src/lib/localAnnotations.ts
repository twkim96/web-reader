import type { Annotation, AnnotationAnchorState } from '../types';
import type { OwnerKey } from './ownerIdentity';
import {
  ANNOTATION_BOOK_LIMIT,
  ANNOTATION_COLOR_LIMIT,
  isAnnotation,
} from './annotationPolicy';
import { initDB } from './localDB';
import { V8_ANNOTATIONS_STORE } from './localDBSchema';
import { trackLocalCommit } from './localCommitTracker';

export type StoredAnnotationV8 = Annotation & { ownerKey: OwnerKey };

export type SaveLocalAnnotationResult =
  | { status: 'saved'; annotation: Annotation }
  | { status: 'book-limit' }
  | { status: 'color-limit' }
  | { status: 'duplicate-range'; annotation: Annotation };

const withoutOwner = ({ ownerKey, ...annotation }: StoredAnnotationV8): Annotation => {
  void ownerKey;
  return annotation;
};

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

export const saveLocalAnnotationV8 = (
  ownerKey: OwnerKey,
  annotation: Annotation,
): Promise<SaveLocalAnnotationResult> => trackLocalCommit((async () => {
  if (!isAnnotation(annotation)) throw new TypeError('Invalid local annotation');

  const db = await initDB();
  const tx = db.transaction(V8_ANNOTATIONS_STORE, 'readwrite');
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

  await store.put({ ...annotation, ownerKey });
  await tx.done;
  return { status: 'saved', annotation };
})());

export const deleteLocalAnnotationV8 = (
  ownerKey: OwnerKey,
  bookId: string,
  annotationId: string,
) => trackLocalCommit((async () => {
  const db = await initDB();
  const tx = db.transaction(V8_ANNOTATIONS_STORE, 'readwrite');
  const store = tx.objectStore(V8_ANNOTATIONS_STORE);
  const key = [ownerKey, bookId, annotationId];
  const existing = await store.get(key) as StoredAnnotationV8 | undefined;
  if (existing) await store.delete(key);
  await tx.done;
  return existing ? withoutOwner(existing) : null;
})());

export const deleteLocalAnnotationsForBookV8 = (
  ownerKey: OwnerKey,
  bookId: string,
) => trackLocalCommit((async () => {
  const db = await initDB();
  const tx = db.transaction(V8_ANNOTATIONS_STORE, 'readwrite');
  const store = tx.objectStore(V8_ANNOTATIONS_STORE);
  const keys = await store.index('by-owner-book').getAllKeys([ownerKey, bookId]);
  await Promise.all(keys.map((key) => store.delete(key)));
  await tx.done;
  return keys.length;
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
