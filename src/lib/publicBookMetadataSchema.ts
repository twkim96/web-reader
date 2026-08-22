import {
  extractCoreTitle,
  NORMALIZER_VERSION as FILE_CHECK_TITLE_NORMALIZER_VERSION,
} from '../vendor/fileCheckTitleNormalizer.js';

export type PublicBookPlatformId = 'series' | 'kakao' | 'novelpia';

export type PublicBookPlatformMetadata = {
  platform: PublicBookPlatformId;
  label: string;
  title: string;
  url: string;
  coverUrl: string | null;
  downloadCount: number | null;
  interestCount: number | null;
  viewCount: number | null;
  recommendCount: number | null;
  rating: number | null;
  ratingCount: number | null;
  lastSuccessAt: string;
};

export type PublicBookMetadata = {
  schemaVersion: 1;
  titleKey: string;
  displayTitle: string;
  normalizerVersion: string;
  publishedAt: string;
  platforms: PublicBookPlatformMetadata[];
};

const platformIds = new Set<PublicBookPlatformId>(['series', 'kakao', 'novelpia']);
const coverPlatformPriority: readonly PublicBookPlatformId[] = ['series', 'kakao', 'novelpia'];

export const normalizePublicBookMetadataAlias = (value: string) => value
  .normalize('NFC')
  .replace(/\.(?:epub|txt|pdf|zip|cbz|7z)$/i, '')
  .toLowerCase()
  .replace(/[^a-z0-9가-힣\u3400-\u9fff\uf900-\ufaff]/g, '');

export const getPublicBookMetadataAliasCandidates = (value: string) => {
  const aliases = [
    normalizePublicBookMetadataAlias(value),
    extractCoreTitle(value),
  ].filter(Boolean);
  return [...new Set(aliases)];
};

export { FILE_CHECK_TITLE_NORMALIZER_VERSION };

const boundedString = (value: unknown, maxLength: number) => (
  typeof value === 'string' && value.length <= maxLength ? value : null
);

const nullableMetric = (value: unknown) => (
  value === null
    ? null
    : typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : undefined
);

const parsePlatform = (value: unknown): PublicBookPlatformMetadata | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const platform = record.platform;
  const label = boundedString(record.label, 32);
  const title = boundedString(record.title, 500);
  const url = boundedString(record.url, 1000);
  const coverUrl = record.coverUrl === undefined || record.coverUrl === null
    ? null
    : boundedString(record.coverUrl, 2000);
  const lastSuccessAt = boundedString(record.lastSuccessAt, 40);
  if (
    typeof platform !== 'string'
    || !platformIds.has(platform as PublicBookPlatformId)
    || label === null
    || title === null
    || url === null
    || coverUrl === null && record.coverUrl !== undefined && record.coverUrl !== null
    || lastSuccessAt === null
    || !/^https:\/\//.test(url)
    || coverUrl !== null && !/^https:\/\//.test(coverUrl)
  ) return null;
  const metrics = {
    downloadCount: nullableMetric(record.downloadCount),
    interestCount: nullableMetric(record.interestCount),
    viewCount: nullableMetric(record.viewCount),
    recommendCount: nullableMetric(record.recommendCount),
    rating: nullableMetric(record.rating),
    ratingCount: nullableMetric(record.ratingCount),
  };
  if (Object.values(metrics).some((metric) => metric === undefined)) return null;
  return {
    platform: platform as PublicBookPlatformId,
    label,
    title,
    url,
    coverUrl,
    lastSuccessAt,
    ...metrics as Record<keyof typeof metrics, number | null>,
  };
};

export const getPublicBookCoverCandidates = (metadata: PublicBookMetadata | null) => {
  if (!metadata) return [];
  const byPlatform = new Map(metadata.platforms.map((platform) => [platform.platform, platform]));
  const seen = new Set<string>();
  return coverPlatformPriority.flatMap((platformId) => {
    const coverUrl = byPlatform.get(platformId)?.coverUrl;
    if (!coverUrl || seen.has(coverUrl)) return [];
    seen.add(coverUrl);
    return [{ platform: platformId, coverUrl }];
  });
};

export const parsePublicBookMetadata = (value: unknown): PublicBookMetadata | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const titleKey = boundedString(record.titleKey, 500);
  const displayTitle = boundedString(record.displayTitle, 500);
  const normalizerVersion = boundedString(record.normalizerVersion, 32);
  const publishedAt = boundedString(record.publishedAt, 40);
  if (
    record.schemaVersion !== 1
    || !titleKey
    || !displayTitle
    || !normalizerVersion
    || !publishedAt
    || !Array.isArray(record.platforms)
    || record.platforms.length > 3
  ) return null;
  const platforms = record.platforms.map(parsePlatform);
  if (platforms.some((platform) => platform === null)) return null;
  return {
    schemaVersion: 1,
    titleKey,
    displayTitle,
    normalizerVersion,
    publishedAt,
    platforms: platforms as PublicBookPlatformMetadata[],
  };
};
