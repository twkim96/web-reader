import type { DocumentData, DocumentSnapshot } from 'firebase/firestore';
import type { Book } from '../types.ts';
import { normalizePublicBookMetadataAlias } from './publicBookMetadataSchema.ts';
import {
  parsePublicBookCatalogAliasShard,
  parsePublicBookCatalogDataShard,
  parsePublicBookCatalogManifest,
  stablePublicBookCatalogJson,
  type PublicBookCatalogBook,
  type PublicBookCatalogRecord,
  type PublicBookCatalogSnapshot,
  type PublicBookCatalogTag,
} from './publicBookCatalogSchema.ts';

export type {
  PublicBookCatalogBook,
  PublicBookCatalogManifest,
  PublicBookCatalogPlatformId,
  PublicBookCatalogRecord,
  PublicBookCatalogSnapshot,
  PublicBookCatalogTag,
} from './publicBookCatalogSchema';

export const PUBLIC_BOOK_CATALOG_COLLECTION = 'publicBookCatalogIndexV1';

type CatalogDocumentSnapshot = Pick<DocumentSnapshot<DocumentData>, 'data' | 'exists'>;

export type PublicBookCatalogFirestoreApi = {
  getFromServer: (documentId: string) => Promise<CatalogDocumentSnapshot>;
  getFromCache: (documentId: string) => Promise<CatalogDocumentSnapshot>;
};

let firestoreRuntimePromise: Promise<{
  db: typeof import('./firebase').db;
  firestore: typeof import('firebase/firestore');
}> | null = null;

const getFirestoreRuntime = () => {
  firestoreRuntimePromise ??= Promise.all([
    import('./firebase'),
    import('firebase/firestore'),
  ]).then(([firebase, firestore]) => ({ db: firebase.db, firestore }));
  return firestoreRuntimePromise;
};

const defaultFirestoreApi: PublicBookCatalogFirestoreApi = {
  getFromServer: async (documentId) => {
    const { db, firestore } = await getFirestoreRuntime();
    return firestore.getDocFromServer(firestore.doc(
      db,
      PUBLIC_BOOK_CATALOG_COLLECTION,
      documentId,
    ));
  },
  getFromCache: async (documentId) => {
    const { db, firestore } = await getFirestoreRuntime();
    return firestore.getDocFromCache(firestore.doc(
      db,
      PUBLIC_BOOK_CATALOG_COLLECTION,
      documentId,
    ));
  },
};

const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)]
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');

const getPublicBookCatalogAliasId = async (fileName: string) => {
  const alias = normalizePublicBookMetadataAlias(fileName);
  if (!alias) return null;
  if (!globalThis.crypto?.subtle) throw new Error('Catalog alias hashing is unavailable');
  return toHex(await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(alias),
  ));
};

const checksum = async (value: unknown) => {
  if (!globalThis.crypto?.subtle) throw new Error('Catalog checksum is unavailable');
  return toHex(await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(stablePublicBookCatalogJson(value)),
  ));
};

const loadManifest = async (api: PublicBookCatalogFirestoreApi) => {
  let snapshot: CatalogDocumentSnapshot;
  try {
    snapshot = await api.getFromServer('manifest');
  } catch {
    snapshot = await api.getFromCache('manifest');
  }
  if (!snapshot.exists()) throw new Error('Public catalog manifest is missing');
  const manifest = parsePublicBookCatalogManifest(snapshot.data());
  if (!manifest) throw new Error('Public catalog manifest is invalid');
  return manifest;
};

const loadGenerationDocument = async (
  api: PublicBookCatalogFirestoreApi,
  documentId: string,
  expectedChecksum: string,
) => {
  let cached: CatalogDocumentSnapshot | null = null;
  try {
    cached = await api.getFromCache(documentId);
  } catch {
    // A generation document is fetched from the server only on cache miss.
  }
  if (cached?.exists()) {
    const data = cached.data();
    if (await checksum(data) === expectedChecksum) return data;
  }
  const server = await api.getFromServer(documentId);
  if (!server.exists()) throw new Error(`Public catalog document is missing: ${documentId}`);
  const data = server.data();
  if (await checksum(data) !== expectedChecksum) {
    throw new Error(`Public catalog checksum mismatch: ${documentId}`);
  }
  return data;
};

let memorySnapshot: PublicBookCatalogSnapshot | null = null;
let loadPromise: Promise<PublicBookCatalogSnapshot> | null = null;

export const resetPublicBookCatalogMemoryForTests = () => {
  memorySnapshot = null;
  loadPromise = null;
};

export const loadPublicBookCatalog = async (
  api: PublicBookCatalogFirestoreApi = defaultFirestoreApi,
): Promise<PublicBookCatalogSnapshot> => {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const manifest = await loadManifest(api);
    if (memorySnapshot?.manifest.generation === manifest.generation) {
      return memorySnapshot;
    }
    const documentIds = [
      ...manifest.aliasDocuments,
      ...manifest.catalogDocuments,
    ];
    const rawDocuments = await Promise.all(documentIds.map(async (documentId) => {
      const data = await loadGenerationDocument(
        api,
        documentId,
        manifest.checksums[documentId],
      );
      return [documentId, data] as const;
    }));
    const rawById = new Map(rawDocuments);
    const aliases = new Map<string, number>();
    for (const documentId of manifest.aliasDocuments) {
      const shard = parsePublicBookCatalogAliasShard(rawById.get(documentId), manifest);
      if (!shard) throw new Error(`Public catalog alias shard is invalid: ${documentId}`);
      for (const [alias, titleId] of Object.entries(shard.entries)) {
        if (aliases.has(alias)) throw new Error(`Duplicate public catalog alias: ${alias}`);
        aliases.set(alias, titleId);
      }
    }
    const records = new Map<number, PublicBookCatalogRecord>();
    const tags = new Map<number, PublicBookCatalogTag>();
    const genres = new Map<number, string>();
    for (const documentId of manifest.catalogDocuments) {
      const shard = parsePublicBookCatalogDataShard(rawById.get(documentId), manifest);
      if (!shard) throw new Error(`Public catalog data shard is invalid: ${documentId}`);
      for (const record of shard.records) {
        if (records.has(record.id)) throw new Error(`Duplicate public catalog title: ${record.id}`);
        records.set(record.id, record);
      }
      for (const tag of shard.tags) {
        if (tags.has(tag.id)) throw new Error(`Duplicate public catalog tag: ${tag.id}`);
        tags.set(tag.id, tag);
      }
      for (const [genreId, label] of shard.genres) {
        if (genres.has(genreId)) throw new Error(`Duplicate public catalog genre: ${genreId}`);
        genres.set(genreId, label);
      }
    }
    if (
      aliases.size !== manifest.aliasCount
      || records.size !== manifest.titleCount
      || tags.size !== manifest.tagCount
      || genres.size !== manifest.genreCount
    ) throw new Error('Public catalog manifest counts do not match generation data');
    for (const titleId of aliases.values()) {
      if (!records.has(titleId)) throw new Error(`Public catalog alias target is missing: ${titleId}`);
    }
    for (const record of records.values()) {
      if (
        record.canonicalGenreId !== null
        && !genres.has(record.canonicalGenreId)
      ) throw new Error(`Public catalog genre target is missing: ${record.canonicalGenreId}`);
      for (const tagId of record.tagIds) {
        if (!tags.has(tagId)) throw new Error(`Public catalog tag target is missing: ${tagId}`);
      }
    }
    const genreLabels = new Set(genres.values());
    const popularTags = [...tags.values()]
      .filter((tag) => !genreLabels.has(tag.label))
      .sort((left, right) => (
        right.titleCount - left.titleCount
        || left.label.localeCompare(right.label, 'ko-KR')
        || left.id - right.id
      ));
    memorySnapshot = {
      manifest,
      aliases,
      records,
      tags,
      genres,
      popularTags,
    };
    return memorySnapshot;
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
};

export const joinBooksToPublicCatalog = async (
  books: readonly Book[],
  snapshot: PublicBookCatalogSnapshot,
) => {
  const joined = new Map<string, PublicBookCatalogBook>();
  const normalizedNames = new Map<string, Promise<string | null>>();
  await Promise.all(books.map(async (book) => {
    let aliasPromise = normalizedNames.get(book.name);
    if (!aliasPromise) {
      aliasPromise = getPublicBookCatalogAliasId(book.name);
      normalizedNames.set(book.name, aliasPromise);
    }
    const aliasId = await aliasPromise;
    if (!aliasId) return;
    const titleId = snapshot.aliases.get(aliasId);
    if (titleId === undefined) return;
    const record = snapshot.records.get(titleId);
    if (!record) return;
    const genreLabel = record.canonicalGenreId === null
      ? null
      : snapshot.genres.get(record.canonicalGenreId) ?? null;
    const tags = record.tagIds.flatMap((tagId) => {
      const tag = snapshot.tags.get(tagId);
      return tag ? [tag] : [];
    }).sort((left, right) => (
      right.titleCount - left.titleCount
      || left.label.localeCompare(right.label, 'ko-KR')
      || left.id - right.id
    ));
    joined.set(book.id, { record, genreLabel, tags });
  }));
  return joined;
};

export const formatPublicBookCatalogMetric = (value: number | null) => (
  value === null
    ? null
    : new Intl.NumberFormat('ko-KR', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)
);
