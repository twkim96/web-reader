import type { DocumentData, DocumentSnapshot } from 'firebase/firestore';
import {
  stablePublicBookCatalogJson,
  type PublicBookCatalogRecord,
  type PublicBookCatalogSnapshot,
  type PublicBookCatalogTag,
} from './publicBookCatalogSchema.ts';

export const PUBLIC_BOOK_CATALOG_DELTA_COLLECTION = 'publicBookCatalogDeltaV1';

type Snapshot = Pick<DocumentSnapshot<DocumentData>, 'data' | 'exists'>;
export type PublicBookCatalogDeltaFirestoreApi = {
  getFromServer: (documentId: string) => Promise<Snapshot>;
  getFromCache: (documentId: string) => Promise<Snapshot>;
};

type DeltaRecord = {
  canonicalKey: string;
  queryTitle: string;
  platformMask: number;
  genre: string | null;
  tags: string[];
  sourceCounts: [number | null, number | null, number | null];
};

type DeltaManifest = {
  generation: string;
  documents: string[];
  recordCount: number;
  checksums: Record<string, string>;
};

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validCount = (value: unknown) => value === null || (Number.isSafeInteger(value) && Number(value) >= 0);

export const parsePublicBookCatalogDeltaManifest = (value: unknown): DeltaManifest | null => {
  if (!isObject(value) || value.schemaVersion !== 1 || typeof value.generation !== 'string' || !/^[0-9a-f]{20}$/.test(value.generation)) return null;
  if (!Array.isArray(value.documents) || value.documents.length !== 16 || !Number.isSafeInteger(value.recordCount) || Number(value.recordCount) < 0) return null;
  const documents = value.documents as unknown[];
  if (documents.some((id, shard) => id !== `${value.generation}_delta_${shard.toString(16)}`) || !isObject(value.checksums)) return null;
  const checksums: Record<string, string> = {};
  for (const id of documents as string[]) {
    const checksum = value.checksums[id];
    if (typeof checksum !== 'string' || !/^[0-9a-f]{64}$/.test(checksum)) return null;
    checksums[id] = checksum;
  }
  if (Object.keys(value.checksums).length !== 16) return null;
  return { generation: value.generation, documents: documents as string[], recordCount: Number(value.recordCount), checksums };
};

const parseDeltaRecord = (value: unknown): DeltaRecord | null => {
  if (!isObject(value) || typeof value.k !== 'string' || !/^[0-9a-f]{64}$/.test(value.k) || typeof value.q !== 'string' || value.q.length > 500) return null;
  if (!Number.isSafeInteger(value.p) || Number(value.p) < 1 || Number(value.p) > 7 || (value.g !== null && (typeof value.g !== 'string' || value.g.length > 80))) return null;
  if (!Array.isArray(value.t) || value.t.length > 64 || value.t.some((tag) => typeof tag !== 'string' || !tag || tag.length > 80) || new Set(value.t).size !== value.t.length) return null;
  if (!Array.isArray(value.c) || value.c.length !== 3 || value.c.some((count) => !validCount(count))) return null;
  return {
    canonicalKey: value.k,
    queryTitle: value.q,
    platformMask: Number(value.p),
    genre: value.g as string | null,
    tags: value.t as string[],
    sourceCounts: value.c as [number | null, number | null, number | null],
  };
};

export const parsePublicBookCatalogDeltaShard = (value: unknown, manifest: DeltaManifest, shard: number) => {
  if (!isObject(value) || value.schemaVersion !== 1 || value.generation !== manifest.generation || value.kind !== 'delta' || value.shard !== shard || !isObject(value.entries)) return null;
  const entries = new Map<string, DeltaRecord>();
  for (const [alias, raw] of Object.entries(value.entries)) {
    if (!/^[0-9a-f]{64}$/.test(alias) || Number.parseInt(alias[0], 16) !== shard) return null;
    const record = parseDeltaRecord(raw);
    if (!record) return null;
    entries.set(alias, record);
  }
  return entries;
};

const hex = (value: ArrayBuffer) => [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const checksum = async (value: unknown) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stablePublicBookCatalogJson(value))));

const readDocument = async (api: PublicBookCatalogDeltaFirestoreApi, id: string, expected: string) => {
  try {
    const cached = await api.getFromCache(id);
    if (cached.exists() && await checksum(cached.data()) === expected) return cached.data();
  } catch { /* server fallback */ }
  const remote = await api.getFromServer(id);
  if (!remote.exists() || await checksum(remote.data()) !== expected) throw new Error(`Public catalog delta checksum mismatch: ${id}`);
  return remote.data();
};

export const loadPublicBookCatalogDelta = async (api: PublicBookCatalogDeltaFirestoreApi) => {
  let manifestSnapshot: Snapshot;
  try { manifestSnapshot = await api.getFromServer('manifest'); } catch { manifestSnapshot = await api.getFromCache('manifest'); }
  if (!manifestSnapshot.exists()) return null;
  const manifest = parsePublicBookCatalogDeltaManifest(manifestSnapshot.data());
  if (!manifest) throw new Error('Public catalog delta manifest is invalid');
  const raw = await Promise.all(manifest.documents.map((id) => readDocument(api, id, manifest.checksums[id])));
  const entries = new Map<string, DeltaRecord>();
  raw.forEach((value, shard) => {
    const parsed = parsePublicBookCatalogDeltaShard(value, manifest, shard);
    if (!parsed) throw new Error(`Public catalog delta shard is invalid: ${shard}`);
    for (const [alias, record] of parsed) {
      if (entries.has(alias)) throw new Error(`Duplicate public catalog delta alias: ${alias}`);
      entries.set(alias, record);
    }
  });
  if (entries.size !== manifest.recordCount) throw new Error('Public catalog delta record count mismatch');
  return { manifest, entries };
};

const midranks = (values: number[]) => {
  const counts = new Map<number, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  let less = 0;
  const ranks = new Map<number, number>();
  [...counts].sort(([left], [right]) => left - right).forEach(([value, equal]) => {
    ranks.set(value, Math.floor(10_000 * (less + 0.5 * equal) / values.length + 0.5));
    less += equal;
  });
  return ranks;
};

const rerank = (records: Map<number, PublicBookCatalogRecord>, activeIds: Set<number>) => {
  const rankMaps = [0, 1, 2].map((index) => midranks([...activeIds].flatMap((id) => {
    const count = records.get(id)?.sourceCounts[index];
    return count === null || count === undefined ? [] : [count];
  })));
  for (const id of activeIds) {
    const record = records.get(id);
    if (!record) continue;
    const sourceRanks = record.sourceCounts.map((count, index) => count === null ? null : rankMaps[index].get(count) ?? null) as [number | null, number | null, number | null];
    const present = sourceRanks.flatMap((rank) => rank === null ? [] : [rank]);
    records.set(id, { ...record, sourceRanks, popularityScore: present.length ? Math.round(present.reduce((sum, rank) => sum + rank, 0) / present.length) : null });
  }
};

const hasAuthoritativeBaseMetadata = (record: PublicBookCatalogRecord | undefined) => Boolean(
  record
  && (
    record.canonicalGenreId !== null
    || record.tagIds.length > 0
    || record.sourceCounts.some((count) => count !== null)
  )
);

export const mergePublicBookCatalogDelta = (
  base: PublicBookCatalogSnapshot,
  delta: Awaited<ReturnType<typeof loadPublicBookCatalogDelta>>,
): PublicBookCatalogSnapshot => {
  if (!delta || delta.entries.size === 0) return base;
  const aliases = new Map(base.aliases);
  const records = new Map(base.records);
  const tags = new Map<number, PublicBookCatalogTag>([...base.tags].map(([id, tag]) => [id, { ...tag }]));
  const genres = new Map(base.genres);
  const aliasesByBaseId = new Map<number, string[]>();
  for (const [alias, id] of base.aliases) aliasesByBaseId.set(id, [...(aliasesByBaseId.get(id) ?? []), alias]);
  const groups = new Map<string, { record: DeltaRecord; aliases: string[]; baseId: number | null }>();
  for (const [alias, record] of delta.entries) {
    const baseId = base.aliases.get(alias) ?? null;
    if (baseId !== null && hasAuthoritativeBaseMetadata(base.records.get(baseId))) continue;
    const key = baseId === null ? `new:${record.canonicalKey}` : `base:${baseId}`;
    const group = groups.get(key);
    if (group) group.aliases.push(alias);
    else groups.set(key, { record, aliases: [alias], baseId });
  }
  if (groups.size === 0) return { ...base, deltaGeneration: delta.manifest.generation };
  const tagIdByLabel = new Map([...tags.values()].map((tag) => [tag.label, tag.id]));
  const genreIdByLabel = new Map([...genres].map(([id, label]) => [label, id]));
  let nextTagId = Math.max(-1, ...tags.keys()) + 1;
  let nextGenreId = Math.max(-1, ...genres.keys()) + 1;
  let nextRecordId = Math.max(-1, ...records.keys()) + 1;
  const activeIds = new Set(records.keys());
  for (const group of groups.values()) {
    if (group.baseId !== null) {
      activeIds.delete(group.baseId);
      const old = records.get(group.baseId);
      old?.tagIds.forEach((id) => {
        const tag = tags.get(id);
        if (tag) tags.set(id, { ...tag, titleCount: Math.max(0, tag.titleCount - 1) });
      });
    }
    const tagIds = group.record.tags.map((label) => {
      let id = tagIdByLabel.get(label);
      if (id === undefined) {
        id = nextTagId++;
        tagIdByLabel.set(label, id);
        tags.set(id, { id, label, titleCount: 0 });
      }
      const tag = tags.get(id)!;
      tags.set(id, { ...tag, titleCount: tag.titleCount + 1 });
      return id;
    });
    let genreId: number | null = null;
    if (group.record.genre) {
      genreId = genreIdByLabel.get(group.record.genre) ?? nextGenreId++;
      genreIdByLabel.set(group.record.genre, genreId);
      genres.set(genreId, group.record.genre);
    }
    const id = nextRecordId++;
    records.set(id, { id, platformMask: group.record.platformMask, canonicalGenreId: genreId, tagIds, popularityScore: null, sourceRanks: [null, null, null], sourceCounts: group.record.sourceCounts });
    activeIds.add(id);
    const targetAliases = group.baseId === null ? group.aliases : [...new Set([...(aliasesByBaseId.get(group.baseId) ?? []), ...group.aliases])];
    targetAliases.forEach((alias) => aliases.set(alias, id));
  }
  rerank(records, activeIds);
  const genreLabels = new Set(genres.values());
  const popularTags = [...tags.values()].filter((tag) => tag.titleCount > 0 && !genreLabels.has(tag.label)).sort((a, b) => b.titleCount - a.titleCount || a.label.localeCompare(b.label, 'ko-KR') || a.id - b.id);
  return { ...base, aliases, records, tags, genres, popularTags, deltaGeneration: delta.manifest.generation };
};
