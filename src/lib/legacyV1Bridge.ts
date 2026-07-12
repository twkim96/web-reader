import { initDB } from './localDB';
import { V5_SYNC_META_STORE } from './localDBSchema';
import type { OwnerKey } from './ownerIdentity';

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object' && value !== null) {
    if ('toMillis' in value && typeof value.toMillis === 'function') {
      return value.toMillis();
    }
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
};

export const fingerprintLegacyV1Document = (bookId: string, data: unknown) => {
  const input = JSON.stringify([bookId, stableValue(data)]);
  let hash = 0x811c9dc5;
  for (const character of input) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

type LegacyBridgeMeta = {
  ownerKey: OwnerKey;
  targetKey: string;
  knownRevision: number;
  nextSequence: number;
  updatedAt: number;
  legacyFingerprint: string;
};

export const claimLegacyV1CandidateV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
  fingerprint: string,
  now = Date.now(),
) => {
  const targetKey = `legacy-v1:${bookId}`;
  const db = await initDB();
  const tx = db.transaction(V5_SYNC_META_STORE, 'readwrite');
  const store = tx.objectStore(V5_SYNC_META_STORE);
  const existing = await store.get([ownerKey, targetKey]) as LegacyBridgeMeta | undefined;
  if (existing?.legacyFingerprint === fingerprint) {
    await tx.done;
    return false;
  }
  await store.put({
    ownerKey,
    targetKey,
    knownRevision: 0,
    nextSequence: 1,
    updatedAt: now,
    legacyFingerprint: fingerprint,
  } satisfies LegacyBridgeMeta);
  await tx.done;
  return true;
};
