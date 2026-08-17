import { normalizePlatformTitle, sha256 } from './domain.ts';
import { normalizePublicBookMetadataAlias } from '../../lib/publicBookMetadataSchema.ts';

export type BookMetadataRefreshRequest = {
  fileName: string;
};

export const parseBookMetadataRefreshRequest = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).join(',') !== 'fileName') return null;
  const { fileName } = record;
  if (typeof fileName !== 'string' || fileName.length < 1 || fileName.length > 1000) return null;
  const alias = normalizePublicBookMetadataAlias(fileName);
  const queryTitle = fileName.replace(/\.(?:epub|txt|pdf|zip|cbz|7z)$/i, '')
    .normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!alias || !normalizePlatformTitle(queryTitle)) return null;
  return {
    fileName,
    queryTitle,
    aliasId: sha256(alias),
    canonicalKey: sha256(normalizePlatformTitle(queryTitle)),
  };
};

export const withTrustedQueryTitle = (
  input: NonNullable<ReturnType<typeof parseBookMetadataRefreshRequest>>,
  value: unknown,
) => {
  if (typeof value !== 'string') return input;
  const queryTitle = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!queryTitle || queryTitle.length > 500 || !normalizePlatformTitle(queryTitle)) return input;
  return { ...input, queryTitle, canonicalKey: sha256(normalizePlatformTitle(queryTitle)) };
};
