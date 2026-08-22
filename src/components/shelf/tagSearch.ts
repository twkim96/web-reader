import type { PublicBookCatalogTag } from '../../lib/publicBookCatalogSchema.ts';
import type { PreparedShelfBook } from './bookUtils.ts';
import { getShelfTagTitleCounts, type ShelfPopularTag } from './filterTags.ts';

export const normalizeShelfTagQuery = (value: string) => value
  .normalize('NFKC')
  .replace(/\s+/g, '')
  .toLowerCase();

const rankTag = (tag: PublicBookCatalogTag, query: string) => {
  const label = normalizeShelfTagQuery(tag.label);
  if (!query || label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (label.includes(query)) return 2;
  return 3;
};

export const searchPublicBookCatalogTags = (
  tags: Iterable<PublicBookCatalogTag>,
  rawQuery: string,
  limit = 8,
) => {
  const query = normalizeShelfTagQuery(rawQuery);
  return [...tags]
    .filter((tag) => !query || normalizeShelfTagQuery(tag.label).includes(query))
    .sort((left, right) => (
      rankTag(left, query) - rankTag(right, query)
      || right.titleCount - left.titleCount
      || left.label.localeCompare(right.label, 'ko-KR')
      || left.id - right.id
    ))
    .slice(0, Math.max(0, limit));
};

export const searchShelfCatalogTags = (
  books: readonly PreparedShelfBook[],
  tags: Iterable<PublicBookCatalogTag>,
  rawQuery: string,
  limit = 8,
): ShelfPopularTag[] => {
  const query = normalizeShelfTagQuery(rawQuery);
  const shelfCounts = getShelfTagTitleCounts(books);

  return [...tags]
    .filter((tag) => !query || normalizeShelfTagQuery(tag.label).includes(query))
    .map((tag) => ({ ...tag, shelfTitleCount: shelfCounts.get(tag.id) ?? 0 }))
    .sort((left, right) => (
      rankTag(left, query) - rankTag(right, query)
      || Number(right.shelfTitleCount > 0) - Number(left.shelfTitleCount > 0)
      || right.shelfTitleCount - left.shelfTitleCount
      || right.titleCount - left.titleCount
      || left.label.localeCompare(right.label, 'ko-KR')
      || left.id - right.id
    ))
    .slice(0, Math.max(0, limit));
};
