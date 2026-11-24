import { getGroupedBookDiscovery, resolveReadBookDiscovery, type DiscoveryBook } from './bookDiscovery';
import { MY_PAGE_DASHBOARD_BOOK_LIMIT } from './myPageSocial';
import { platformWorkKey, type ReadBook } from './readBooks';

const minimumPopularity = 4_300;
const maximumRecommendationCandidates = 50;
const minimumRelativeScore = 0.8;
const tagFrequencySmoothing = 30;

const tagAliases = new Map([
  ['성장물', '성장'], ['성장판무', '성장'],
  ['회귀물', '회귀'], ['판무회귀물', '회귀'],
  ['빙의물', '빙의'],
  ['환생물', '환생'], ['환생판무', '환생'],
  ['복수물', '복수'], ['복수극', '복수'],
  ['차원이동물', '차원이동'],
  ['전문직물', '전문직'], ['전문직판무', '전문직'],
  ['탑등반물', '탑등반'],
  ['귀환물', '귀환'], ['재벌물', '재벌'], ['영지물', '영지'], ['힐링물', '힐링'],
]);

function normalizeTag(tag: string) {
  const key = tag.normalize('NFKC').toLowerCase().replace(/\s+/g, '').replace(/^#+/, '');
  return tagAliases.get(key) ?? key;
}

function recommendationTags(book: DiscoveryBook, normalize = normalizeTag) {
  return new Set(book.tags.map(normalize).filter(Boolean));
}

type Candidate = { book: DiscoveryBook; tagCountWeight: number };
type TagEntry = { specificity: number; candidates: Candidate[] };
const tagIndexCache = new WeakMap<readonly DiscoveryBook[], Map<string, TagEntry>>();

function getTagIndex(books: readonly DiscoveryBook[]) {
  const cached = tagIndexCache.get(books);
  if (cached) return cached;

  const counts = new Map<string, { frequency: number; candidates: Candidate[] }>();
  const normalized = new Map<string, string>();
  const normalize = (raw: string) => {
    const cached = normalized.get(raw);
    if (cached !== undefined) return cached;
    const tag = normalizeTag(raw);
    normalized.set(raw, tag);
    return tag;
  };
  let taggedBookCount = 0;
  for (const book of books) {
    const bookTags = recommendationTags(book, normalize);
    if (!bookTags.size) continue;
    taggedBookCount += 1;
    const extraTags = Math.max(0, bookTags.size - 6);
    // Discount extra matching opportunities without rewarding sparsely tagged books.
    const candidate = book.popularity !== null && book.popularity >= minimumPopularity
      ? { book, tagCountWeight: Math.max(2 / 3, Math.sqrt(12 / (12 + extraTags))) }
      : null;
    for (const tag of bookTags) {
      const entry = counts.get(tag) ?? { frequency: 0, candidates: [] };
      entry.frequency += 1;
      if (candidate) entry.candidates.push(candidate);
      counts.set(tag, entry);
    }
  }
  const tags = new Map<string, TagEntry>();
  for (const [tag, { frequency, candidates }] of counts) {
    // Smoothing caps the advantage of tags with very few examples.
    const specificity = 0.5 + Math.log((taggedBookCount + tagFrequencySmoothing) / (frequency + tagFrequencySmoothing));
    tags.set(tag, { specificity, candidates });
  }
  tagIndexCache.set(books, tags);
  return tags;
}

function rotationWeight(id: string, seed: number) {
  let hash = seed ^ 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (((hash ^ (hash >>> 16)) >>> 0) + 0.5) / 0x1_0000_0000;
}

export function recommendDiscoveryBooks(
  catalog: readonly DiscoveryBook[], wishlist: readonly DiscoveryBook[], readBooks: readonly ReadBook[], rotationSeed?: number,
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
  for (const book of seeds) {
    const tags = recommendationTags(book);
    if (!tags.size) continue;
    // A book with more labels should have less influence per tag.
    const contribution = 1 / Math.sqrt(tags.size);
    for (const tag of tags) interests.set(tag, (interests.get(tag) ?? 0) + contribution);
  }
  if (!interests.size) return [];

  const tags = getTagIndex(grouped.books);
  const scores = new Map<DiscoveryBook, number>();
  for (const [tag, count] of interests) {
    const entry = tags.get(tag);
    if (!entry) continue;
    const weight = Math.sqrt(count) * entry.specificity;
    for (const { book, tagCountWeight } of entry.candidates) {
      if (!excluded.has(book)) scores.set(book, (scores.get(book) ?? 0) + weight * tagCountWeight);
    }
  }
  const ranked = [...scores].sort(([a, scoreA], [b, scoreB]) => (
    scoreB - scoreA || (b.popularity ?? 0) - (a.popularity ?? 0) || a.id.localeCompare(b.id)
  ));
  const count = Math.min(ranked.length, MY_PAGE_DASHBOARD_BOOK_LIMIT);
  if (!count) return [];
  const cutoffScore = ranked[count - 1][1] * minimumRelativeScore;
  const candidates = ranked.slice(0, maximumRecommendationCandidates).filter(([, score]) => score >= cutoffScore);
  if (rotationSeed === undefined) return candidates.map(([book]) => book);

  // Exponential draws give each remaining book a chance proportional to its score.
  return candidates.map(([book, score]) => ({ book, draw: -Math.log(rotationWeight(book.id, rotationSeed)) / score }))
    .sort((a, b) => a.draw - b.draw)
    .map(({ book }) => book);
}
