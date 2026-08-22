import type { PublicBookCatalogSnapshot, PublicBookCatalogTag } from '../../lib/publicBookCatalogSchema.ts';
import type { PreparedShelfBook } from './bookUtils.ts';

export const SHELF_TAG_PAGE_SIZE = 15;

export type ShelfPopularTag = PublicBookCatalogTag & {
  shelfTitleCount: number;
};

export const getShelfTagTitleCounts = (
  books: readonly PreparedShelfBook[],
) => {
  const shelfCounts = new Map<number, number>();
  for (const prepared of books) {
    const tagIds = new Set(prepared.catalog?.record.tagIds ?? []);
    for (const tagId of tagIds) {
      shelfCounts.set(tagId, (shelfCounts.get(tagId) ?? 0) + 1);
    }
  }
  return shelfCounts;
};

export const getShelfPopularTags = (
  books: readonly PreparedShelfBook[],
  catalog: PublicBookCatalogSnapshot | null,
): ShelfPopularTag[] => {
  if (!catalog) return [];
  const popularTagRank = new Map(catalog.popularTags.map((tag, index) => [tag.id, index]));
  const shelfCounts = getShelfTagTitleCounts(books);
  return catalog.popularTags
    .map((tag) => ({ ...tag, shelfTitleCount: shelfCounts.get(tag.id) ?? 0 }))
    .sort((left, right) => (
      Number(right.shelfTitleCount > 0) - Number(left.shelfTitleCount > 0)
      || (
        left.shelfTitleCount > 0 && right.shelfTitleCount > 0
          ? right.shelfTitleCount - left.shelfTitleCount
          : 0
      )
      || (popularTagRank.get(left.id) ?? Number.MAX_SAFE_INTEGER)
        - (popularTagRank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || left.label.localeCompare(right.label, 'ko-KR')
    ));
};

export const getNextShelfTagCount = (current: number, total: number) => (
  Math.min(total, Math.max(SHELF_TAG_PAGE_SIZE, current + SHELF_TAG_PAGE_SIZE))
);
