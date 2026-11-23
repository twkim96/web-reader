import { getGroupedBookDiscovery, resolveReadBookDiscovery, type DiscoveryBook } from './bookDiscovery';
import { MY_PAGE_DASHBOARD_BOOK_LIMIT } from './myPageSocial';
import { platformWorkKey, type ReadBook } from './readBooks';

const minimumPopularity = 4_300;

const tagAliases = new Map([
  ['성장물', '성장'], ['성장판무', '성장'],
  ['회귀물', '회귀'], ['판무회귀물', '회귀'],
  ['빙의물', '빙의'],
  ['환생물', '환생'], ['환생판무', '환생'],
  ['복수물', '복수'], ['복수극', '복수'],
  ['차원이동물', '차원이동'],
  ['전문직물', '전문직'], ['전문직판무', '전문직'],
  ['귀환물', '귀환'], ['재벌물', '재벌'], ['영지물', '영지'], ['힐링물', '힐링'],
]);

function normalizeTag(tag: string) {
  const key = tag.normalize('NFKC').toLowerCase().replace(/\s+/g, '').replace(/^#+/, '');
  return tagAliases.get(key) ?? key;
}

function recommendationTags(book: DiscoveryBook, normalize = normalizeTag) {
  return new Set(book.tags.map(normalize).filter(Boolean));
}

type TagEntry = { frequency: number; candidates: DiscoveryBook[] };
const tagIndexCache = new WeakMap<readonly DiscoveryBook[], Map<string, TagEntry>>();

function getTagIndex(books: readonly DiscoveryBook[]) {
  const cached = tagIndexCache.get(books);
  if (cached) return cached;

  const tags = new Map<string, TagEntry>();
  const normalized = new Map<string, string>();
  const normalize = (raw: string) => {
    const cached = normalized.get(raw);
    if (cached !== undefined) return cached;
    const tag = normalizeTag(raw);
    normalized.set(raw, tag);
    return tag;
  };
  for (const book of books) {
    const eligible = book.popularity !== null && book.popularity >= minimumPopularity;
    for (const tag of recommendationTags(book, normalize)) {
      const entry = tags.get(tag) ?? { frequency: 0, candidates: [] };
      entry.frequency += 1;
      if (eligible) entry.candidates.push(book);
      tags.set(tag, entry);
    }
  }
  tagIndexCache.set(books, tags);
  return tags;
}

export function recommendDiscoveryBooks(
  catalog: readonly DiscoveryBook[], wishlist: readonly DiscoveryBook[], readBooks: readonly ReadBook[],
) {
  if (!wishlist.length && !readBooks.length) return [];

  const grouped = getGroupedBookDiscovery(catalog);
  const saved = wishlist.flatMap((book) => {
    const canonical = grouped.byId.get(book.id) ?? resolveReadBookDiscovery(grouped, {
      id: book.id, platformWorkKeys: book.platforms.map(({ id, url }) => platformWorkKey(id, url)),
    }).book;
    return canonical ? [canonical] : [];
  });
  const read = readBooks.flatMap((book) => {
    const canonical = resolveReadBookDiscovery(grouped, book).book;
    return canonical ? [canonical] : [];
  });
  const excluded = new Set([...saved, ...read]);
  const seeds = new Set([
    ...[...new Set(saved)].slice(0, MY_PAGE_DASHBOARD_BOOK_LIMIT),
    ...[...new Set(read)].slice(0, MY_PAGE_DASHBOARD_BOOK_LIMIT),
  ]);
  const interests = new Map<string, number>();
  for (const book of seeds) for (const tag of recommendationTags(book)) {
    interests.set(tag, (interests.get(tag) ?? 0) + 1);
  }
  if (!interests.size) return [];

  const tags = getTagIndex(grouped.books);
  const scores = new Map<DiscoveryBook, number>();
  for (const [tag, count] of interests) {
    const entry = tags.get(tag);
    if (!entry) continue;
    const weight = Math.sqrt(count) / Math.log2(entry.frequency + 1);
    for (const book of entry.candidates) {
      if (!excluded.has(book)) scores.set(book, (scores.get(book) ?? 0) + weight);
    }
  }
  return [...scores].sort(([a, scoreA], [b, scoreB]) => (
    scoreB - scoreA || (b.popularity ?? 0) - (a.popularity ?? 0) || a.id.localeCompare(b.id)
  )).slice(0, MY_PAGE_DASHBOARD_BOOK_LIMIT).map(([book]) => book);
}
