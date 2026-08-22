import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { canonicalGenre, sha256, type OnDemandMetadata, type PlatformCrawlResult } from './domain.ts';
import { BOOK_METADATA_LIMITS } from './config.ts';

const SOURCE_BITS = { series: 1, kakao: 2, novelpia: 4 } as const;
export const BOOK_METADATA_CRAWLER_VERSION = 'web-reader-1.8.29-v3';

export type LeaseResult =
  | { kind: 'cached'; document: OnDemandMetadata }
  | { kind: 'acquired'; owner: string }
  | { kind: 'busy' }
  | { kind: 'quota' }
  | { kind: 'cooldown' };

const isFresh = (value: unknown, now: number): value is OnDemandMetadata => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && typeof record.nextRefreshAt === 'string'
    && Date.parse(record.nextRefreshAt) > now
    && (record.status === 'ready' || record.status === 'not-found' || record.status === 'ambiguous');
};

const matchesCacheIdentity = (
  value: OnDemandMetadata,
  expected?: { queryTitle: string; crawlerVersion: string },
) => !expected || (
  value.queryTitle === expected.queryTitle
  && value.crawlerVersion === expected.crawlerVersion
);

export const acquireMetadataLease = async (
  db: Firestore,
  aliasId: string,
  uid: string,
  now = Date.now(),
  expected?: { queryTitle: string; crawlerVersion: string },
): Promise<LeaseResult> => {
  const owner = randomUUID();
  const sourceRef = db.collection('publicBookMetadataOnDemandV1').doc(aliasId);
  const leaseRef = db.collection('bookMetadataRequestStateV1').doc(aliasId);
  const day = new Date(now).toISOString().slice(0, 10);
  const quotaRef = db.collection('bookMetadataDailyQuotaV1').doc(`${sha256(uid).slice(0, 24)}_${day}`);
  return db.runTransaction(async (transaction) => {
    const [source, lease, quota] = await Promise.all([
      transaction.get(sourceRef),
      transaction.get(leaseRef),
      transaction.get(quotaRef),
    ]);
    const sourceData = source.data();
    const freshSource = source.exists && isFresh(sourceData, now) ? sourceData : null;
    if (freshSource && matchesCacheIdentity(freshSource, expected)) {
      return { kind: 'cached', document: freshSource };
    }
    const replacesMismatchedFreshCache = Boolean(freshSource && expected);
    const leaseData = lease.data() as Record<string, unknown> | undefined;
    const leaseUntil = typeof leaseData?.leaseUntil === 'number' ? leaseData.leaseUntil : 0;
    if (leaseUntil > now) return { kind: 'busy' };
    const lastStartedAt = typeof leaseData?.lastStartedAt === 'number' ? leaseData.lastStartedAt : 0;
    if (
      !replacesMismatchedFreshCache
      && lastStartedAt + BOOK_METADATA_LIMITS.aliasCooldownMs > now
    ) return { kind: 'cooldown' };
    const quotaData = quota.data() as Record<string, unknown> | undefined;
    const count = typeof quotaData?.count === 'number' ? quotaData.count : 0;
    if (count >= BOOK_METADATA_LIMITS.dailyUserLimit) return { kind: 'quota' };
    transaction.set(quotaRef, { schemaVersion: 1, uidHash: sha256(uid), day, count: count + 1, updatedAt: now });
    transaction.set(leaseRef, { schemaVersion: 1, owner, leaseUntil: now + BOOK_METADATA_LIMITS.leaseMs, lastStartedAt: now });
    return { kind: 'acquired', owner };
  });
};

export const buildOnDemandMetadata = (
  aliasId: string,
  canonicalKey: string,
  queryTitle: string,
  results: PlatformCrawlResult[],
  now = Date.now(),
): OnDemandMetadata => {
  const successful = results.flatMap((result) => (
    result.status === 'ok' && result.remoteId && result.remoteTitle && result.url
      ? [{
        platform: result.platform,
        remoteId: result.remoteId,
        remoteTitle: result.remoteTitle,
        url: result.url,
        coverUrl: result.coverUrl,
        genre: result.genre,
        tags: result.tags,
        sourceCount: result.sourceCount,
      }]
      : []
  ));
  const status = successful.length > 0
    ? 'ready'
    : results.some(({ status: value }) => value === 'ambiguous')
      ? 'ambiguous'
      : results.every(({ status: value }) => value === 'not-found')
        ? 'not-found'
        : 'error';
  const cacheMs = status === 'error' ? 10 * 60_000 : BOOK_METADATA_LIMITS.cacheMs;
  return {
    schemaVersion: 1,
    aliasId,
    canonicalKey,
    queryTitle,
    status,
    platforms: successful,
    platformStatuses: results.map(({ platform, status: resultStatus, message }) => ({
      platform,
      status: resultStatus,
      ...(message ? { message: message.slice(0, 160) } : {}),
    })),
    crawledAt: new Date(now).toISOString(),
    nextRefreshAt: new Date(now + cacheMs).toISOString(),
    crawlerVersion: BOOK_METADATA_CRAWLER_VERSION,
    publishPending: status === 'ready',
  };
};

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
};

const deltaRecord = (document: OnDemandMetadata) => {
  const platforms = document.platforms;
  return {
    k: document.canonicalKey,
    q: document.queryTitle,
    p: platforms.reduce((mask, platform) => mask | SOURCE_BITS[platform.platform], 0),
    g: canonicalGenre(platforms.map((platform) => ({ ...platform, status: 'ok' as const }))),
    t: [...new Set(platforms.flatMap(({ tags }) => tags ?? []))].sort((a, b) => a.localeCompare(b, 'ko-KR')),
    c: [
      platforms.find(({ platform }) => platform === 'series')?.sourceCount ?? null,
      platforms.find(({ platform }) => platform === 'kakao')?.sourceCount ?? null,
      platforms.find(({ platform }) => platform === 'novelpia')?.sourceCount ?? null,
    ],
  };
};

export const publishCatalogDelta = async (db: Firestore, changedDocument?: OnDemandMetadata) => {
  const manifestRef = db.collection('publicBookCatalogDeltaV1').doc('manifest');
  const startingManifest = await manifestRef.get();
  const startingGeneration = startingManifest.exists ? startingManifest.data()?.generation ?? null : null;
  const records: Record<string, ReturnType<typeof deltaRecord>> = {};
  const startingDocuments = startingManifest.data()?.documents;
  if (startingManifest.exists && Array.isArray(startingDocuments) && startingDocuments.length === 16) {
    const priorShards = await Promise.all(startingDocuments.map((id) => db.collection('publicBookCatalogDeltaV1').doc(String(id)).get()));
    for (const shard of priorShards) {
      const entries = shard.data()?.entries;
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('existing catalog delta shard is invalid');
      for (const [alias, record] of Object.entries(entries)) {
        if (!/^[0-9a-f]{64}$/.test(alias) || !record || typeof record !== 'object' || Array.isArray(record)) throw new Error('existing catalog delta record is invalid');
        records[alias] = record as ReturnType<typeof deltaRecord>;
      }
    }
  } else if (!changedDocument) {
    const snapshot = await db.collection('publicBookMetadataOnDemandV1').get();
    snapshot.docs.sort((a, b) => a.id.localeCompare(b.id)).forEach((document) => {
      const value = document.data() as OnDemandMetadata;
      if (value.schemaVersion === 1 && value.status === 'ready' && value.aliasId === document.id) records[document.id] = deltaRecord(value);
    });
  }
  if (changedDocument?.status === 'ready') records[changedDocument.aliasId] = deltaRecord(changedDocument);
  const generation = sha256(stableJson(records)).slice(0, 20);
  const documents = Array.from({ length: 16 }, (_, shard) => `${generation}_delta_${shard.toString(16)}`);
  const checksums: Record<string, string> = {};
  const shardPayloads = documents.map((documentId, shard) => {
    const entries = Object.fromEntries(Object.entries(records).filter(([alias]) => Number.parseInt(alias[0], 16) === shard));
    const payload = { schemaVersion: 1, generation, kind: 'delta', shard, entries };
    if (new TextEncoder().encode(stableJson(payload)).byteLength > 900_000) throw new Error(`catalog delta shard is too large: ${shard}`);
    checksums[documentId] = sha256(stableJson(payload));
    return [documentId, payload] as const;
  });
  const existing = await Promise.all(documents.map((documentId) => db.collection('publicBookCatalogDeltaV1').doc(documentId).get()));
  const batch = db.batch();
  for (const [documentId, payload] of shardPayloads) {
    const found = existing.find((document) => document.id === documentId);
    if (found?.exists) {
      if (sha256(stableJson(found.data())) !== checksums[documentId]) throw new Error(`catalog delta immutable document mismatch: ${documentId}`);
    } else {
      batch.create(db.collection('publicBookCatalogDeltaV1').doc(documentId), payload);
    }
  }
  await batch.commit();
  const readback = await Promise.all(documents.map((documentId) => db.collection('publicBookCatalogDeltaV1').doc(documentId).get()));
  for (const document of readback) {
    if (!document.exists || sha256(stableJson(document.data())) !== checksums[document.id]) throw new Error(`catalog delta readback mismatch: ${document.id}`);
  }
  const manifest = {
    schemaVersion: 1,
    generation,
    publishedAt: new Date().toISOString(),
    documents,
    recordCount: Object.keys(records).length,
    checksums,
  };
  await db.runTransaction(async (transaction) => {
    const current = await transaction.get(manifestRef);
    const currentGeneration = current.exists ? current.data()?.generation ?? null : null;
    if (currentGeneration !== startingGeneration && currentGeneration !== generation) {
      throw new Error('catalog delta manifest changed during publish');
    }
    transaction.set(manifestRef, manifest, { merge: false });
  });
  return manifest;
};

export const recoverPendingCatalogPublication = async (db: Firestore, document: OnDemandMetadata) => {
  if (document.status !== 'ready' || !document.publishPending) return null;
  const manifest = await publishCatalogDelta(db, document);
  await db.collection('publicBookMetadataOnDemandV1').doc(document.aliasId).update({ publishPending: false });
  return manifest.generation;
};

export const saveMetadataAndPublish = async (
  db: Firestore,
  document: OnDemandMetadata,
  owner: string,
) => {
  const sourceRef = db.collection('publicBookMetadataOnDemandV1').doc(document.aliasId);
  const leaseRef = db.collection('bookMetadataRequestStateV1').doc(document.aliasId);
  await db.runTransaction(async (transaction) => {
    const lease = await transaction.get(leaseRef);
    if (lease.data()?.owner !== owner) throw new Error('metadata lease ownership was lost');
    transaction.set(sourceRef, document, { merge: false });
    transaction.set(leaseRef, { schemaVersion: 1, owner: null, leaseUntil: 0, lastStartedAt: lease.data()?.lastStartedAt ?? Date.now() });
  });
  if (document.status === 'ready') {
    try {
      const manifest = await publishCatalogDelta(db, document);
      await sourceRef.update({ publishPending: false });
      return manifest.generation;
    } catch (error) {
      console.error('[BookMetadata] delta publish failed');
      throw error;
    }
  }
  return null;
};

export const waitForMetadataLease = async (db: Firestore, aliasId: string) => {
  const ref = db.collection('publicBookMetadataOnDemandV1').doc(aliasId);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const snapshot = await ref.get();
    if (snapshot.exists) return snapshot.data() as OnDemandMetadata;
  }
  return null;
};
