import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import {
  normalizePublicBookMetadataAlias,
  parsePublicBookMetadata,
} from './publicBookMetadataSchema';

export type {
  PublicBookMetadata,
  PublicBookPlatformId,
  PublicBookPlatformMetadata,
} from './publicBookMetadataSchema';

export const PUBLIC_BOOK_METADATA_COLLECTION = 'publicBookMetadataV1';

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

export const loadPublicBookMetadata = async (fileName: string) => {
  const aliasId = await getPublicBookMetadataAliasId(fileName);
  if (!aliasId) return null;
  const snapshot = await getDoc(doc(
    db,
    PUBLIC_BOOK_METADATA_COLLECTION,
    aliasId.slice(0, 2),
  ));
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  if (
    data.schemaVersion !== 1
    || typeof data.entries !== 'object'
    || !data.entries
    || Array.isArray(data.entries)
  ) return null;
  return parsePublicBookMetadata((data.entries as Record<string, unknown>)[aliasId]);
};
