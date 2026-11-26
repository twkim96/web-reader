import type { PublicBookCatalogTag } from '../../lib/publicBookCatalogSchema.ts';
import { getHangulInitials, isHangulInitialQuery, normalizeHangulSearchText } from '../../lib/hangulSearch.ts';
import type { PreparedShelfBook } from './bookUtils.ts';
import { getShelfTagTitleCounts, type ShelfPopularTag } from './filterTags.ts';

export const normalizeShelfTagQuery = normalizeHangulSearchText;

const rankTag = (label: string, query: string) => {
  if (!query || label === query) return 0;
  if (label.startsWith(query)) return 1;
  return 2;
};

export const searchPublicBookCatalogTags = (
  tags: Iterable<PublicBookCatalogTag>,
  rawQuery: string,
  limit = 8,
) => {
  const query = normalizeShelfTagQuery(rawQuery);
  const isInitialQuery = isHangulInitialQuery(query);
  return [...tags]
    .flatMap((tag) => {
      const label = normalizeShelfTagQuery(tag.label);
      const matches = isInitialQuery ? getHangulInitials(label).startsWith(query) : label.includes(query);
      if (!matches) return [];
      return [{ tag, rank: isInitialQuery ? 0 : rankTag(label, query) }];
    })
    .sort((left, right) => (
      left.rank - right.rank
      || right.tag.titleCount - left.tag.titleCount
      || left.tag.label.localeCompare(right.tag.label, 'ko-KR')
      || left.tag.id - right.tag.id
    ))
    .slice(0, Math.max(0, limit))
    .map(({ tag }) => tag);
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
      rankTag(normalizeShelfTagQuery(left.label), query) - rankTag(normalizeShelfTagQuery(right.label), query)
      || Number(right.shelfTitleCount > 0) - Number(left.shelfTitleCount > 0)
      || right.shelfTitleCount - left.shelfTitleCount
      || right.titleCount - left.titleCount
      || left.label.localeCompare(right.label, 'ko-KR')
      || left.id - right.id
    ))
    .slice(0, Math.max(0, limit));
};
