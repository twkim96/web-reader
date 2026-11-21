import type { DiscoveryBook } from './bookDiscovery';
import { MY_PAGE_DASHBOARD_BOOK_LIMIT } from './myPageSocial';
import type { OwnerKey } from './ownerIdentity';
import { ownerRuntime, type OwnerSnapshot } from './ownerRuntime';

const previewLifetimeMs = 60_000;

type Preview<T> = {
  revision: number;
  writes: number;
  expiresAt: number;
  cards?: T;
};

function createPreviewStore<T>() {
  const entries = new WeakMap<OwnerSnapshot, Preview<T>>();
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  const scope = (owner: OwnerKey) => {
    const session = ownerRuntime.capture();
    if (!session || session.ownerKey !== owner) return;
    let entry = entries.get(session);
    if (!entry) {
      entry = { revision: 0, writes: 0, expiresAt: 0 };
      entries.set(session, entry);
    }
    return { session, entry };
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    read(owner: OwnerKey) {
      const session = ownerRuntime.capture();
      const entry = session?.ownerKey === owner ? entries.get(session) : undefined;
      return entry && entry.expiresAt > Date.now() ? entry.cards : undefined;
    },
    beginRead(owner: OwnerKey) {
      const state = scope(owner);
      if (!state) return;
      if (state.entry.writes > 0) return () => false;
      const { entry, session } = state;
      const revision = ++entry.revision;
      return (cards: T | undefined) => {
        if (!ownerRuntime.isCurrent(session) || entry.revision !== revision) return false;
        entry.cards = cards;
        entry.expiresAt = Date.now() + previewLifetimeMs;
        publish();
        return true;
      };
    },
    beginWrite(owner: OwnerKey) {
      const state = scope(owner);
      if (!state) return;
      const { entry } = state;
      entry.writes++;
      entry.revision++;
      entry.cards = undefined;
      publish();
      return () => { entry.writes--; };
    },
  };
}

export type DashboardReviewCard = {
  id: string;
  title: string;
  coverTitle: string | null;
  coverUrl: string | null;
  rating: number;
};

export const dashboardWishlistCache = createPreviewStore<DiscoveryBook[]>();
export const dashboardReviewCache = createPreviewStore<DashboardReviewCard[]>();

export function dashboardReviewCards(reviews: readonly {
  workId: string; title?: string | null; coverUrl?: string | null; rating: number;
}[]): DashboardReviewCard[] {
  return reviews.slice(0, MY_PAGE_DASHBOARD_BOOK_LIMIT).map((review) => ({
    id: review.workId,
    title: review.title ?? review.workId,
    coverTitle: review.title ?? null,
    coverUrl: review.coverUrl ?? null,
    rating: review.rating,
  }));
}
