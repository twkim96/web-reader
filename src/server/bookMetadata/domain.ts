import { createHash } from 'node:crypto';

export const BOOK_METADATA_CRAWLER_VERSION = 'web-reader-1.8.15-v1';
export const BOOK_METADATA_NORMALIZER_VERSION = 'web-reader-title-v1';

export type PlatformId = 'series' | 'kakao' | 'novelpia';
export type CrawlStatus = 'ok' | 'not-found' | 'ambiguous' | 'error';

export type PlatformCrawlResult = {
  platform: PlatformId;
  status: CrawlStatus;
  remoteId: string | null;
  remoteTitle: string | null;
  url: string | null;
  genre: string | null;
  tags: string[] | null;
  sourceCount: number | null;
  message?: string;
};

export type OnDemandMetadata = {
  schemaVersion: 1;
  aliasId: string;
  canonicalKey: string;
  queryTitle: string;
  status: 'ready' | 'not-found' | 'ambiguous' | 'error';
  platforms: Array<{
    platform: PlatformId;
    remoteId: string;
    remoteTitle: string;
    url: string;
    genre: string | null;
    tags: string[] | null;
    sourceCount: number | null;
  }>;
  platformStatuses: Array<{
    platform: PlatformId;
    status: CrawlStatus;
    message?: string;
  }>;
  crawledAt: string;
  nextRefreshAt: string;
  crawlerVersion: string;
  publishPending: boolean;
};

const decodeHtml = (value: string) => value
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));

export const stripHtml = (value: string) => decodeHtml(value)
  .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export const normalizePlatformTitle = (value: string) => {
  let text = decodeHtml(String(value ?? '')).normalize('NFKC').trim()
    .replace(/\s*:\s*네이버시리즈\s*$/i, '');
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = text
      .replace(/\s*\(\s*총\s*[\d,]+\s*(?:화|권|편)(?:\s*\/\s*[^)]+)?\)\s*$/i, '')
      .replace(/\s*\[\s*(?:단행본|독점|미니노블)\s*\]\s*$/i, '')
      .trim();
  }
  return text.toLocaleLowerCase('ko-KR').replace(/[\s:()\[\]{},.。…?!\-_·ㆍ・“”「」『』‐-―]+/g, '');
};

export const titlesMatch = (requested: string, candidate: string) => {
  const left = normalizePlatformTitle(requested);
  return Boolean(left) && left === normalizePlatformTitle(candidate);
};

export const normalizeTags = (values: unknown[]) => {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    if (typeof value !== 'string') throw new Error('platform tag must be text');
    const tag = decodeHtml(value).replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '').trim();
    if (!tag || tag.length > 80 || seen.has(tag)) return [];
    seen.add(tag);
    return [tag];
  }).slice(0, 64);
};

export const parseCount = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
  }
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const text = decodeHtml(String(value)).replace(/,/g, '').trim();
  const units: Record<string, number> = { '억': 100_000_000, '천만': 10_000_000, '만': 10_000, '천': 1_000 };
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(천만|억|만|천)/g)];
  if (matches.length > 0) return Math.trunc(matches.reduce((sum, match) => (
    sum + Number(match[1]) * units[match[2]]
  ), 0));
  const match = text.match(/\d+(?:\.\d+)?/);
  return match ? Math.trunc(Number(match[0])) : null;
};

export const selectUniqueExactCandidate = <T extends { id: string; title: string }>(
  requestedTitle: string,
  candidates: T[],
): { candidate: T | null; status: 'ok' | 'not-found' | 'ambiguous' } => {
  const matched = candidates.filter((candidate) => titlesMatch(requestedTitle, candidate.title));
  if (matched.length === 0) return { candidate: null, status: 'not-found' };
  if (matched.length > 1 || new Set(matched.map(({ id }) => id)).size > 1) {
    return { candidate: null, status: 'ambiguous' };
  }
  return { candidate: matched[0], status: 'ok' };
};

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const canonicalGenre = (platforms: PlatformCrawlResult[]) => {
  const canonical = [
    '판타지', '현대판타지', '무협', '로맨스판타지', '로맨스', '현대', '라이트노벨',
    'SF', '대체역사', '스포츠', '미스터리', '공포', 'BL', '패러디', '기타',
  ];
  const aliases: Record<string, string> = { 현판: '현대판타지', 로판: '로맨스판타지' };
  const map = (value: string | null) => {
    const label = aliases[value ?? ''] ?? value;
    return label && canonical.includes(label) ? label : null;
  };
  for (const platform of ['kakao', 'series', 'novelpia'] as const) {
    const result = platforms.find((candidate) => candidate.platform === platform && candidate.status === 'ok');
    if (!result) continue;
    const direct = map(result.genre);
    if (direct) return direct;
    if (platform === 'novelpia' && ['고수위', 'TS', '환생', '중세', '하렘', '퓨전'].includes(result.genre ?? '')) {
      const fallback = result.tags?.map(map).find(Boolean);
      if (fallback) return fallback;
    }
  }
  return null;
};
