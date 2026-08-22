import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import {
  getPublicBookMetadataAliasCandidates,
  normalizePublicBookMetadataAlias,
  parsePublicBookMetadata,
} from './publicBookMetadataSchema';

export type {
  PublicBookMetadata,
  PublicBookPlatformId,
  PublicBookPlatformMetadata,
} from './publicBookMetadataSchema';

export const PUBLIC_BOOK_METADATA_COLLECTION = 'publicBookMetadataV1';
export const PUBLIC_BOOK_METADATA_ON_DEMAND_COLLECTION = 'publicBookMetadataOnDemandV1';

const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)]
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');

export const getPublicBookMetadataAliasId = async (fileName: string) => {
  const alias = normalizePublicBookMetadataAlias(fileName);
  if (!alias) return null;
  if (!globalThis.crypto?.subtle) throw new Error('Metadata alias hashing is unavailable');
  return toHex(await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(alias),
  ));
};

const getPublicBookMetadataAliasIds = async (fileName: string) => {
  if (!globalThis.crypto?.subtle) throw new Error('Metadata alias hashing is unavailable');
  return Promise.all(getPublicBookMetadataAliasCandidates(fileName).map(async (alias) => toHex(
    await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(alias)),
  )));
};

export const loadPublicBookMetadata = async (fileName: string) => {
  const aliasIds = await getPublicBookMetadataAliasIds(fileName);
  if (aliasIds.length === 0) return null;
  const bucketIds = [...new Set(aliasIds.map((aliasId) => aliasId.slice(0, 2)))];
  const snapshots = await Promise.all(bucketIds.map(async (bucketId) => [
    bucketId,
    await getDoc(doc(db, PUBLIC_BOOK_METADATA_COLLECTION, bucketId)),
  ] as const));
  const buckets = new Map(snapshots);
  for (const aliasId of aliasIds) {
    const snapshot = buckets.get(aliasId.slice(0, 2));
    if (snapshot?.exists()) {
      const data = snapshot.data();
      if (
        data.schemaVersion === 1
        && typeof data.entries === 'object'
        && data.entries
        && !Array.isArray(data.entries)
      ) {
        const parsed = parsePublicBookMetadata((data.entries as Record<string, unknown>)[aliasId]);
        if (parsed) return parsed;
      }
    }
  }
  const aliasId = aliasIds[0];
  const onDemand = await getDoc(doc(db, PUBLIC_BOOK_METADATA_ON_DEMAND_COLLECTION, aliasId));
  return onDemand.exists() ? parseOnDemandPublicBookMetadata(onDemand.data()) : null;
};

export const parseOnDemandPublicBookMetadata = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.status !== 'ready' || typeof record.queryTitle !== 'string' || typeof record.crawledAt !== 'string' || !Array.isArray(record.platforms)) return null;
  return parsePublicBookMetadata({
    schemaVersion: 1,
    titleKey: record.queryTitle,
    displayTitle: record.queryTitle,
    normalizerVersion: 'web-reader-title-v1',
    publishedAt: record.crawledAt,
    platforms: record.platforms.map((platform) => {
      if (!platform || typeof platform !== 'object' || Array.isArray(platform)) return platform;
      const item = platform as Record<string, unknown>;
      const count = typeof item.sourceCount === 'number' ? item.sourceCount : null;
      return {
        platform: item.platform,
        label: item.platform === 'series' ? '네이버 시리즈' : item.platform === 'kakao' ? '카카오페이지' : '노벨피아',
        title: item.remoteTitle,
        url: item.url,
        coverUrl: typeof item.coverUrl === 'string' ? item.coverUrl : null,
        downloadCount: item.platform === 'series' ? count : null,
        viewCount: item.platform === 'series' ? null : count,
        interestCount: null,
        recommendCount: null,
        rating: null,
        ratingCount: null,
        lastSuccessAt: record.crawledAt,
      };
    }),
  });
};

export type PublicBookMetadataRefreshStatus = 'ready' | 'not-found' | 'ambiguous' | 'error' | 'busy' | 'quota' | 'cooldown';

export const requestPublicBookMetadataRefresh = async (fileName: string) => {
  const { auth } = await import('./firebase');
  const user = auth.currentUser;
  if (!user) throw new Error('login-required');
  const token = await user.getIdToken();
  const response = await fetch('/api/book-metadata/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fileName }),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  const status = payload?.status;
  if (typeof status !== 'string') throw new Error('invalid-response');
  const metadata = payload?.document ? parseOnDemandPublicBookMetadata(payload.document) : null;
  return { status: status as PublicBookMetadataRefreshStatus, metadata };
};
