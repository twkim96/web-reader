import type { PublicBookPlatformId } from './publicBookMetadataSchema';
import { groupPublicBookWorks, platformWorkKey } from './readBooks';
import { finishDiscoveryTiming, startDiscoveryTiming } from './myPagePerformance';
import { discoveryRotationWeight, weightDiscoveryPlatformMix } from './discoveryCandidateWeights';

export type DiscoveryBook = {
  id: string;
  title: string;
  coverUrl: string | null;
  platforms: Array<{ id: PublicBookPlatformId; label: string; url: string }>;
  genre: string | null;
  tags: string[];
  popularity: number | null;
  sourceCount: number | null;
};

export const DISCOVERY_INDEX_PATH = '/catalog/discovery.v1.json';

const platformLabels: Record<PublicBookPlatformId, string> = {
  series: '네이버 시리즈',
  kakao: '카카오페이지',
  novelpia: '노벨피아',
};

const isObject = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);
const isText = (value: unknown, max: number): value is string => (
  typeof value === 'string' && value.trim().length > 0 && value.length <= max
);
const isHttps = (value: unknown, max: number): value is string => {
  if (!isText(value, max) || !value.startsWith('https://')) return false;
  try { return Boolean(new URL(value).hostname); } catch { return false; }
};
const isMetric = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number | null => (
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max)
);
const isIndex = (value: unknown, total: number): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < total
);
const isDictionary = (value: unknown, max: number): value is string[] => (
  Array.isArray(value) && value.every((item) => isText(item, max)) && new Set(value).size === value.length
);
const isPlatformId = (value: unknown): value is PublicBookPlatformId => (
  value === 'series' || value === 'kakao' || value === 'novelpia'
);
const invalidIndex = (): never => { throw new Error('Invalid discovery index'); };

export function parseDiscoveryIndex(value: unknown): DiscoveryBook[] {
  if (!isObject(value) || value.schemaVersion !== 1 || !isText(value.generation, 128)
    || !isDictionary(value.genres, 100) || !isDictionary(value.tags, 100)
    || !Array.isArray(value.books)) return invalidIndex();

  const { genres, tags, books } = value;
  const ids = new Set<string>();
  return books.map((row): DiscoveryBook => {
    if (!Array.isArray(row) || row.length !== 8) return invalidIndex();
    const [id, title, coverUrl, rawPlatforms, genre, rawTags, popularity, sourceCount] = row;
    if (!isText(id, 500) || ids.has(id) || !isText(title, 500)
      || (coverUrl !== null && !isHttps(coverUrl, 2000))
      || !Array.isArray(rawPlatforms) || !rawPlatforms.length || rawPlatforms.length > 3
      || (genre !== null && !isIndex(genre, genres.length))
      || !Array.isArray(rawTags) || rawTags.length > 64
      || !isMetric(popularity, 10_000) || !isMetric(sourceCount)) return invalidIndex();
    ids.add(id);

    const platformIds = new Set<PublicBookPlatformId>();
    const platforms = rawPlatforms.map((platform) => {
      if (!Array.isArray(platform) || platform.length !== 2
        || !isPlatformId(platform[0]) || !isHttps(platform[1], 1000)
        || platformIds.has(platform[0])) return invalidIndex();
      const [id, url] = platform;
      platformIds.add(id);
      return { id, label: platformLabels[id], url };
    });
    return {
      id, title, coverUrl, platforms,
      genre: genre === null ? null : genres[genre],
      tags: rawTags.map((index) => isIndex(index, tags.length) ? tags[index] : invalidIndex()),
      popularity, sourceCount,
    };
  });
}

export function groupDiscoveryBooks(rows: readonly DiscoveryBook[]) {
  const platformKeys = (book: DiscoveryBook) => book.platforms.map(({ id, url }) => platformWorkKey(id, url));
  const { findTitle } = groupPublicBookWorks(rows.map((book) => ({ titleKey: book.id, platformWorkKeys: platformKeys(book) })));
  const groups = new Map<string, DiscoveryBook[]>();
  for (const book of rows) {
    const root = findTitle(book.id);
    const group = groups.get(root);
    if (group) group.push(book);
    else groups.set(root, [book]);
  }

  const byId = new Map<string, DiscoveryBook>();
  const equivalents = new Map<string, string[]>();
  const platforms = new Map<string, string>();
  const books: DiscoveryBook[] = [];
  for (const [root, group] of groups) {
    const selected = group.find((book) => book.id === root)!;
    const links = new Map<string, DiscoveryBook['platforms'][number]>();
    for (const book of [selected, ...group.filter((book) => book !== selected)]) {
      book.platforms.forEach((platform) => {
        const key = platformWorkKey(platform.id, platform.url);
        links.set(key, platform);
        platforms.set(key, root);
      });
    }
    const canonical = { ...selected, platforms: [...links.values()] };
    books.push(canonical);
    equivalents.set(root, group.map((book) => book.id).sort());
    for (const book of group) byId.set(book.id, canonical);
  }
  return { books, byId, equivalents, platforms };
}

const groupedDiscoveryCache = new WeakMap<readonly DiscoveryBook[], ReturnType<typeof groupDiscoveryBooks>>();

export function getGroupedBookDiscovery(rows: readonly DiscoveryBook[]) {
  const cached = groupedDiscoveryCache.get(rows);
  if (cached) return cached;
  const started = startDiscoveryTiming();
  const grouped = groupDiscoveryBooks(rows);
  finishDiscoveryTiming('grouping', started);
  groupedDiscoveryCache.set(rows, grouped);
  return grouped;
}

const discoveryBooksByTag = new WeakMap<readonly DiscoveryBook[], Map<string, DiscoveryBook[]>>();

export function getRelatedDiscoveryBooks(books: readonly DiscoveryBook[], current: DiscoveryBook, rotationSeed = 0) {
  if (!current.tags.length) return [];

  let booksByTag = discoveryBooksByTag.get(books);
  if (!booksByTag) {
    booksByTag = new Map();
    for (const book of books) for (const tag of new Set(book.tags)) {
      const matches = booksByTag.get(tag);
      if (matches) matches.push(book);
      else booksByTag.set(tag, [book]);
    }
    discoveryBooksByTag.set(books, booksByTag);
  }

  const scores = new Map<DiscoveryBook, number>();
  for (const tag of new Set(current.tags)) {
    const matches = booksByTag.get(tag);
    if (!matches) continue;
    const weight = 1 / Math.log2(matches.length + 1);
    for (const book of matches) {
      if (book.id !== current.id) scores.set(book, (scores.get(book) ?? 0) + weight);
    }
  }

  const sameGenre = (book: DiscoveryBook) => Number(current.genre !== null && book.genre === current.genre);
  const ranked = [...scores].sort(([a, scoreA], [b, scoreB]) => (
    scoreB - scoreA || sameGenre(b) - sameGenre(a) || (b.popularity ?? -1) - (a.popularity ?? -1)
    || a.id.localeCompare(b.id)
  ));
  const shown = 12;
  const cutoff = (ranked[Math.min(shown, ranked.length) - 1]?.[1] ?? 0) * 0.8;
  // Squared relevance and bounded variation keep strong tag matches near the top.
  const weighted = weightDiscoveryPlatformMix(ranked.filter(([, score]) => score >= cutoff)
    .map(([book, score]) => [book, score ** 2]));
  if (!weighted) return ranked.slice(0, shown).map(([book]) => book);
  return weighted.map(([book, score]) => ({
    book, score: score * (1 + 0.25 * discoveryRotationWeight(book.id, rotationSeed)),
  })).sort((a, b) => b.score - a.score).slice(0, shown).map(({ book }) => book);
}

export function resolveReadBookDiscovery(
  catalog: ReturnType<typeof groupDiscoveryBooks>,
  book: { id: string; equivalentTitleKeys?: string[]; platformWorkKeys?: string[] },
) {
  const links = book.platformWorkKeys ?? [];
  const platformIds = new Set(links.flatMap((key) => {
    const id = catalog.platforms.get(key);
    return id === undefined ? [] : [id];
  }));
  if (platformIds.size === 1) return { book: catalog.byId.get([...platformIds][0]), blocked: false };
  if (links.length) return { blocked: true };
  const titles = new Set([book.id, ...(book.equivalentTitleKeys ?? [])].flatMap((id) => {
    const entry = catalog.byId.get(id);
    return entry ? [entry] : [];
  }));
  if (titles.size > 1) return { blocked: true };
  return { book: [...titles][0], blocked: false };
}

export function createDiscoveryLoader(fetchIndex: (retry: boolean) => Promise<unknown>) {
  let pending: Promise<DiscoveryBook[]> | undefined;
  let retry = false;
  return () => {
    pending ??= Promise.resolve().then(() => fetchIndex(retry)).then((value) => {
      const started = startDiscoveryTiming();
      const result = parseDiscoveryIndex(value);
      finishDiscoveryTiming('validation', started);
      return result;
    }).catch((error) => {
      retry = true;
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

export const loadBookDiscovery = createDiscoveryLoader(async (retry) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(DISCOVERY_INDEX_PATH, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: retry ? 'reload' : 'default',
    });
    if (!response.ok) throw new Error(`Discovery index unavailable: ${response.status}`);
    const started = startDiscoveryTiming();
    const result = await response.json();
    finishDiscoveryTiming('json', started);
    return result;
  } finally {
    clearTimeout(timer);
  }
});
