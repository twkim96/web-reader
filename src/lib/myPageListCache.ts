import type { MyPageOwnReviews, MyPageSavedBook } from './myPageSocial';
import type { OwnerKey } from './ownerIdentity';
import { ownerRuntime, type OwnerSnapshot } from './ownerRuntime';

export type MyPageListSnapshot<T> = Readonly<{
  data?: T;
  error: string;
  writeVersion: number;
}>;

type Entry<T> = {
  snapshot: MyPageListSnapshot<T>;
  checkedAt?: number;
  pending?: { controller: AbortController; promise: Promise<void> };
  writes: number;
  writeSequence?: number;
  unregister?: () => void;
};

export function createListCache<T>(freshnessMs = 60_000) {
  const empty: MyPageListSnapshot<T> = { error: '', writeVersion: 0 };
  const entries = new WeakMap<OwnerSnapshot, Entry<T>>();
  const listeners = new Set<() => void>();
  const publish = (entry: Entry<T>, snapshot: MyPageListSnapshot<T>) => {
    entry.snapshot = snapshot;
    listeners.forEach((listener) => listener());
  };
  const invalidate = (entry: Entry<T>) => {
    entry.checkedAt = undefined;
    entry.pending?.controller.abort();
    entry.pending = undefined;
  };
  const scope = (owner: OwnerKey) => {
    const session = ownerRuntime.capture();
    if (session?.ownerKey !== owner) return;
    let entry = entries.get(session);
    if (!entry) {
      entry = { snapshot: empty, writes: 0 };
      entries.set(session, entry);
      const scopedEntry = entry;
      entry.unregister = ownerRuntime.registerDisposer(() => invalidate(scopedEntry));
    }
    return { session, entry };
  };

  return {
    dispose(session: OwnerSnapshot) {
      const entry = entries.get(session);
      if (!entry) return;
      invalidate(entry);
      entry.unregister?.();
      entries.delete(session);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    empty: () => empty,
    read(owner: OwnerKey) {
      const session = ownerRuntime.capture();
      return (session?.ownerKey === owner ? entries.get(session)?.snapshot : undefined) ?? empty;
    },
    refresh(owner: OwnerKey, load: (signal: AbortSignal) => Promise<T>, force = false) {
      const state = scope(owner);
      if (!state || state.entry.writes > 0) return;
      const { entry, session } = state;
      if (entry.pending) return entry.pending.promise;
      if (!force && entry.checkedAt !== undefined) {
        const age = Date.now() - entry.checkedAt;
        if (age >= 0 && age < freshnessMs) return;
      }
      const controller = new AbortController();
      const isCurrent = () => ownerRuntime.isCurrent(session) && entry.pending?.controller === controller;
      const promise = Promise.resolve().then(() => load(controller.signal)).then((data) => {
        if (!isCurrent()) return;
        entry.checkedAt = Date.now();
        publish(entry, { ...entry.snapshot, data, error: '' });
      }).catch((error: Error) => {
        if (isCurrent()) publish(entry, { ...entry.snapshot, error: error.message });
      }).finally(() => {
        if (isCurrent()) entry.pending = undefined;
      });
      entry.pending = { controller, promise };
      return promise;
    },
    update(session: OwnerSnapshot | null, apply: (data: T) => T) {
      if (!session || !ownerRuntime.isCurrent(session)) return;
      const entry = entries.get(session);
      if (entry?.snapshot.data !== undefined) {
        publish(entry, { ...entry.snapshot, data: apply(entry.snapshot.data) });
      }
    },
    beginWrite(owner: OwnerKey) {
      const state = scope(owner);
      if (!state) return;
      const { entry, session } = state;
      const checkedAt = entry.checkedAt;
      const sequence = entry.writeSequence = (entry.writeSequence ?? 0) + 1;
      invalidate(entry);
      if (entry.writes++ === 0) publish(entry, { ...entry.snapshot, writeVersion: entry.snapshot.writeVersion + 1 });
      return (retainCheck = false) => {
        if (--entry.writes === 0 && ownerRuntime.isCurrent(session)) {
          if (retainCheck && sequence === entry.writeSequence && entry.snapshot.data !== undefined) {
            entry.checkedAt = checkedAt;
          }
          publish(entry, { ...entry.snapshot, writeVersion: entry.snapshot.writeVersion + 1 });
        }
      };
    },
    clear(session: OwnerSnapshot, error: string) {
      if (!ownerRuntime.isCurrent(session)) return;
      const entry = entries.get(session);
      if (!entry) return;
      invalidate(entry);
      publish(entry, { error, writeVersion: entry.snapshot.writeVersion });
    },
  };
}

export const wishlistListCache = createListCache<{ entries: MyPageSavedBook[] }>();
export const fullReviewListCache = createListCache<MyPageOwnReviews>();
export const previewReviewListCache = createListCache<MyPageOwnReviews>();
