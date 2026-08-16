export type PublicBookCatalogPlatformId = 'series' | 'kakao' | 'novelpia';

export const PUBLIC_BOOK_CATALOG_PLATFORM_BITS = {
  series: 1,
  kakao: 2,
  novelpia: 4,
} as const;

export const PUBLIC_BOOK_CATALOG_PLATFORMS = [
  'series',
  'kakao',
  'novelpia',
] as const satisfies readonly PublicBookCatalogPlatformId[];

export type PublicBookCatalogManifest = {
  schemaVersion: 1;
  generation: string;
  publishedAt: string;
  normalizerVersion: string;
  genrePolicyVersion: string;
  popularityFormulaVersion: 1;
  aliasDocuments: string[];
  catalogDocuments: string[];
  aliasCount: number;
  titleCount: number;
  tagCount: number;
  genreCount: number;
  excludedAliasCollisionCount: number;
  checksums: Record<string, string>;
};

export type PublicBookCatalogRecord = {
  id: number;
  platformMask: number;
  canonicalGenreId: number | null;
  tagIds: number[];
  popularityScore: number | null;
  sourceRanks: [number | null, number | null, number | null];
  sourceCounts: [number | null, number | null, number | null];
};

export type PublicBookCatalogTag = {
  id: number;
  label: string;
  titleCount: number;
};

export type PublicBookCatalogAliasShard = {
  schemaVersion: 1;
  generation: string;
  kind: 'alias';
  shard: number;
  entries: Record<string, number>;
};

export type PublicBookCatalogDataShard = {
  schemaVersion: 1;
  generation: string;
  kind: 'catalog';
  shard: number;
  records: PublicBookCatalogRecord[];
  tags: PublicBookCatalogTag[];
  genres: Map<number, string>;
};

export type PublicBookCatalogBook = {
  record: PublicBookCatalogRecord;
  genreLabel: string | null;
  tags: PublicBookCatalogTag[];
};

export type PublicBookCatalogSnapshot = {
  manifest: PublicBookCatalogManifest;
  aliases: Map<string, number>;
  records: Map<number, PublicBookCatalogRecord>;
  tags: Map<number, PublicBookCatalogTag>;
  genres: Map<number, string>;
  popularTags: PublicBookCatalogTag[];
};

const isObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const boundedString = (value: unknown, maxLength: number) => (
  typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : null
);

const boundedInteger = (value: unknown, min: number, max: number) => (
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
    ? Number(value)
    : null
);

const nullableInteger = (value: unknown, min: number, max: number) => (
  value === null ? null : boundedInteger(value, min, max)
);

const parseDocumentIds = (
  value: unknown,
  expectedLength: number,
  pattern: RegExp,
) => {
  if (!Array.isArray(value) || value.length !== expectedLength) return null;
  const result = value.map((candidate) => (
    typeof candidate === 'string' && pattern.test(candidate) ? candidate : null
  ));
  return result.some((candidate) => candidate === null)
    ? null
    : result as string[];
};

export const parsePublicBookCatalogManifest = (
  value: unknown,
): PublicBookCatalogManifest | null => {
  if (!isObject(value) || value.schemaVersion !== 1) return null;
  const generation = boundedString(value.generation, 40);
  if (!generation || !/^[0-9a-f]{20}$/.test(generation)) return null;
  const publishedAt = boundedString(value.publishedAt, 40);
  const normalizerVersion = boundedString(value.normalizerVersion, 32);
  const genrePolicyVersion = boundedString(value.genrePolicyVersion, 64);
  const aliasDocuments = parseDocumentIds(
    value.aliasDocuments,
    16,
    new RegExp(`^${generation}_alias_[0-9a-f]$`),
  );
  const catalogDocuments = parseDocumentIds(
    value.catalogDocuments,
    8,
    new RegExp(`^${generation}_catalog_[0-7]$`),
  );
  const aliasCount = boundedInteger(value.aliasCount, 0, 1_000_000);
  const titleCount = boundedInteger(value.titleCount, 0, 1_000_000);
  const tagCount = boundedInteger(value.tagCount, 0, 100_000);
  const genreCount = boundedInteger(value.genreCount, 0, 1_000);
  const excludedAliasCollisionCount = boundedInteger(
    value.excludedAliasCollisionCount,
    0,
    1_000_000,
  );
  if (
    !publishedAt
    || !normalizerVersion
    || !genrePolicyVersion
    || value.popularityFormulaVersion !== 1
    || !aliasDocuments
    || !catalogDocuments
    || aliasCount === null
    || titleCount === null
    || tagCount === null
    || genreCount === null
    || excludedAliasCollisionCount === null
    || !isObject(value.checksums)
  ) return null;
  const documentIds = [...aliasDocuments, ...catalogDocuments];
  const checksums: Record<string, string> = {};
  for (const documentId of documentIds) {
    const digest = value.checksums[documentId];
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return null;
    checksums[documentId] = digest;
  }
  if (Object.keys(value.checksums).length !== documentIds.length) return null;
  return {
    schemaVersion: 1,
    generation,
    publishedAt,
    normalizerVersion,
    genrePolicyVersion,
    popularityFormulaVersion: 1,
    aliasDocuments,
    catalogDocuments,
    aliasCount,
    titleCount,
    tagCount,
    genreCount,
    excludedAliasCollisionCount,
    checksums,
  };
};

export const parsePublicBookCatalogAliasShard = (
  value: unknown,
  manifest: PublicBookCatalogManifest,
): PublicBookCatalogAliasShard | null => {
  if (
    !isObject(value)
    || value.schemaVersion !== 1
    || value.generation !== manifest.generation
    || value.kind !== 'alias'
    || !isObject(value.entries)
  ) return null;
  const shard = boundedInteger(value.shard, 0, 15);
  if (shard === null) return null;
  const entries: Record<string, number> = {};
  for (const [alias, rawTitleId] of Object.entries(value.entries)) {
    const titleId = boundedInteger(rawTitleId, 0, Math.max(0, manifest.titleCount - 1));
    if (!/^[0-9a-f]{64}$/.test(alias) || titleId === null) return null;
    entries[alias] = titleId;
  }
  return {
    schemaVersion: 1,
    generation: manifest.generation,
    kind: 'alias',
    shard,
    entries,
  };
};

const parseNullableTuple = (
  value: unknown,
  max: number,
): [number | null, number | null, number | null] | null => {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const parsed = value.map((candidate) => nullableInteger(candidate, 0, max));
  if (parsed.some((candidate, index) => candidate === null && value[index] !== null)) return null;
  return parsed as [number | null, number | null, number | null];
};

const parseRecord = (
  idText: string,
  value: unknown,
  manifest: PublicBookCatalogManifest,
): PublicBookCatalogRecord | null => {
  if (!isObject(value) || !/^\d+$/.test(idText)) return null;
  const id = boundedInteger(Number(idText), 0, Math.max(0, manifest.titleCount - 1));
  const platformMask = boundedInteger(value.p, 1, 7);
  const canonicalGenreId = nullableInteger(
    value.g,
    0,
    Math.max(0, manifest.genreCount - 1),
  );
  const popularityScore = nullableInteger(value.s, 0, 10_000);
  const sourceRanks = parseNullableTuple(value.r, 10_000);
  const sourceCounts = parseNullableTuple(value.c, Number.MAX_SAFE_INTEGER);
  if (
    id === null
    || platformMask === null
    || (canonicalGenreId === null && value.g !== null)
    || (popularityScore === null && value.s !== null)
    || !sourceRanks
    || !sourceCounts
    || !Array.isArray(value.t)
    || value.t.length > 64
  ) return null;
  const tagIds = value.t.map((candidate) => boundedInteger(
    candidate,
    0,
    Math.max(0, manifest.tagCount - 1),
  ));
  if (tagIds.some((tagId) => tagId === null) || new Set(tagIds).size !== tagIds.length) {
    return null;
  }
  const sourceBits = [1, 2, 4];
  if (sourceBits.some((bit, index) => (
    !(platformMask & bit)
    && (sourceRanks[index] !== null || sourceCounts[index] !== null)
  ))) return null;
  const presentRanks = sourceRanks.flatMap((rank) => rank === null ? [] : [rank]);
  const expectedScore = presentRanks.length > 0
    ? Math.round(presentRanks.reduce((sum, rank) => sum + rank, 0) / presentRanks.length)
    : null;
  if (popularityScore !== expectedScore) return null;
  return {
    id,
    platformMask,
    canonicalGenreId,
    tagIds: tagIds as number[],
    popularityScore,
    sourceRanks,
    sourceCounts,
  };
};

export const parsePublicBookCatalogDataShard = (
  value: unknown,
  manifest: PublicBookCatalogManifest,
): PublicBookCatalogDataShard | null => {
  if (
    !isObject(value)
    || value.schemaVersion !== 1
    || value.generation !== manifest.generation
    || value.kind !== 'catalog'
    || !isObject(value.records)
  ) return null;
  const shard = boundedInteger(value.shard, 0, 7);
  if (shard === null) return null;
  const records = Object.entries(value.records).map(([id, record]) => (
    parseRecord(id, record, manifest)
  ));
  if (records.some((record) => record === null)) return null;

  const tags: PublicBookCatalogTag[] = [];
  const genres = new Map<number, string>();
  if (shard === 0) {
    if (!isObject(value.tags) || !isObject(value.genres)) return null;
    for (const [idText, rawTag] of Object.entries(value.tags)) {
      if (!/^\d+$/.test(idText) || !isObject(rawTag)) return null;
      const id = boundedInteger(Number(idText), 0, Math.max(0, manifest.tagCount - 1));
      const label = boundedString(rawTag.l, 100);
      const titleCount = boundedInteger(rawTag.n, 1, manifest.titleCount);
      if (id === null || !label || titleCount === null) return null;
      tags.push({ id, label, titleCount });
    }
    for (const [idText, rawLabel] of Object.entries(value.genres)) {
      if (!/^\d+$/.test(idText)) return null;
      const id = boundedInteger(Number(idText), 0, Math.max(0, manifest.genreCount - 1));
      const label = boundedString(rawLabel, 100);
      if (id === null || !label) return null;
      genres.set(id, label);
    }
  } else if (value.tags !== undefined || value.genres !== undefined) {
    return null;
  }
  return {
    schemaVersion: 1,
    generation: manifest.generation,
    kind: 'catalog',
    shard,
    records: records as PublicBookCatalogRecord[],
    tags,
    genres,
  };
};

export const stablePublicBookCatalogJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stablePublicBookCatalogJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stablePublicBookCatalogJson(record[key])}`
  )).join(',')}}`;
};
