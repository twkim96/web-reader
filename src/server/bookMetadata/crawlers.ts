import {
  normalizeTags,
  parseCount,
  selectUniqueExactCandidate,
  stripHtml,
  titlesMatch,
  type PlatformCrawlResult,
  type PlatformId,
} from './domain.ts';
import { BOOK_METADATA_LIMITS, type PlatformAuthProvider } from './config.ts';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const ALLOWED_HOSTS = new Set([
  'series.naver.com',
  'bff-page.kakao.com',
  'page.kakao.com',
  'novelpia.com',
]);

type Candidate<T = unknown> = { id: string; title: string; record?: T; sourceCount?: number | null };

const firstValue = (value: unknown, keys: string[]) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return keys.map((key) => record[key]).find((candidate) => (
    candidate !== null && candidate !== undefined && String(candidate).trim()
  )) ?? null;
};

const safeError = (platform: PlatformId, error: unknown): PlatformCrawlResult => ({
  platform,
  status: 'error',
  remoteId: null,
  remoteTitle: null,
  url: null,
  genre: null,
  tags: null,
  sourceCount: null,
  message: error instanceof Error ? error.message.slice(0, 160) : '조회 실패',
});

const empty = (platform: PlatformId, status: 'not-found' | 'ambiguous'): PlatformCrawlResult => ({
  platform,
  status,
  remoteId: null,
  remoteTitle: null,
  url: null,
  genre: null,
  tags: null,
  sourceCount: null,
});

const fetchBounded = async (url: URL, signal: AbortSignal, json = false) => {
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) throw new Error('platform URL is not allowed');
  const headers: HeadersInit = {
    Accept: json ? 'application/json,text/plain,*/*' : 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
    'User-Agent': USER_AGENT,
  };
  if (url.hostname === 'bff-page.kakao.com') {
    headers.Origin = 'https://page.kakao.com';
    headers.Referer = 'https://page.kakao.com/';
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal, redirect: 'follow', cache: 'no-store' });
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== 'https:' || !ALLOWED_HOSTS.has(finalUrl.hostname)) throw new Error('platform redirect is not allowed');
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          continue;
        }
        throw new Error(`platform HTTP ${response.status}`);
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > BOOK_METADATA_LIMITS.responseBytes) {
        throw new Error('platform response is too large');
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > BOOK_METADATA_LIMITS.responseBytes) throw new Error('platform response is too large');
      const text = new TextDecoder().decode(buffer);
      return json ? JSON.parse(text) as unknown : text;
    } catch (error) {
      lastError = error;
      if (signal.aborted || attempt === 2) break;
    }
  }
  throw lastError;
};

const parseBoundedResponse = async (response: Response, json: boolean) => {
  if (!response.ok) throw new Error(`platform HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > BOOK_METADATA_LIMITS.responseBytes) throw new Error('platform response is too large');
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > BOOK_METADATA_LIMITS.responseBytes) throw new Error('platform response is too large');
  const text = new TextDecoder().decode(buffer);
  return json ? JSON.parse(text) as unknown : text;
};

export const parseSeriesCandidates = (page: string): Candidate[] => {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const item of page.match(/<li\b[\s\S]*?<\/li>/gi) ?? []) {
    const product = item.match(/\/novel\/detail\.series\?productNo=(\d+)/i)?.[1];
    if (!product || seen.has(product)) continue;
    const title = item.match(/class=["'][^"']*N=a:nov\.title[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1]
      ?? item.match(/<h3[^>]*>[\s\S]*?<a[^>]+href=["'][^"']*\/novel\/detail\.series\?productNo=\d+[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1]
      ?? item.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i)?.[1]
      ?? '';
    seen.add(product);
    candidates.push({ id: product, title: stripHtml(title) });
  }
  if (candidates.length > 0) return candidates;
  for (const match of page.matchAll(/<a[^>]+href=["'][^"']*\/novel\/detail\.series\?productNo=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!seen.has(match[1])) candidates.push({ id: match[1], title: stripHtml(match[2]) });
  }
  return candidates;
};

export const parseSeriesDetail = (page: string) => {
  const title = stripHtml(
    page.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
    ?? page.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1]
    ?? page.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?? '',
  ).replace(/\s*:\s*네이버시리즈\s*$/i, '').trim();
  const download = page.match(/class=["'][^"']*btn_download[^"']*["'][\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)?.[1];
  const info = page.match(/<ul\b[^>]*class=["'][^"']*\bend_info\b[^"']*["'][^>]*>[\s\S]{0,5000}/i)?.[0] ?? '';
  const genre = info.match(/categoryTypeCode=genre(?:&amp;|&)genreCode=[^"']+["'][^>]*>([\s\S]*?)<\/a>/i)?.[1];
  return { title, sourceCount: download ? parseCount(stripHtml(download)) : null, genre: genre ? stripHtml(genre).replace(/^#+\s*/, '') : null };
};

const crawlSeries = async (title: string, signal: AbortSignal): Promise<PlatformCrawlResult> => {
  const search = new URL('https://series.naver.com/search/search.series');
  search.search = new URLSearchParams({ t: 'all', fs: 'novel', q: title }).toString();
  const page = await fetchBounded(search, signal) as string;
  const candidates = parseSeriesCandidates(page);
  if (candidates.length === 0 && !page.includes('검색결과가 없습니다')) throw new Error('Series search shape changed');
  const selected = selectUniqueExactCandidate(title, candidates);
  if (!selected.candidate) return empty('series', selected.status === 'ambiguous' ? 'ambiguous' : 'not-found');
  const detailUrl = new URL('https://series.naver.com/novel/detail.series');
  detailUrl.searchParams.set('productNo', selected.candidate.id);
  const detail = parseSeriesDetail(await fetchBounded(detailUrl, signal) as string);
  if (!detail.title || detail.title.replace(/\s/g, '').includes('판매중지상품안내')) throw new Error('Series detail is unavailable');
  if (!titlesMatch(title, detail.title)) return empty('series', 'not-found');
  return { platform: 'series', status: 'ok', remoteId: selected.candidate.id, remoteTitle: detail.title, url: detailUrl.toString(), genre: detail.genre, tags: null, sourceCount: detail.sourceCount };
};

export const parseKakaoCandidates = (data: unknown): Candidate[] => {
  const result = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).result : null;
  const list = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>).list : null;
  if (!Array.isArray(list)) throw new Error('Kakao search shape changed');
  const candidates = list.flatMap((item) => {
    const id = firstValue(item, ['series_id', 'seriesId', 'id']);
    const candidateTitle = firstValue(item, ['title', 'name']);
    if (!id || !candidateTitle) return [];
    const props = firstValue(item, ['service_property', 'serviceProperty']);
    return [{ id: String(id), title: String(candidateTitle), sourceCount: parseCount(firstValue(props, ['view_count', 'viewCount'])) }];
  });
  if (list.length > 0 && candidates.length === 0) throw new Error('Kakao search item shape changed');
  return candidates;
};

export const parseKakaoOverview = (data: unknown) => {
  const result = firstValue(data, ['result']);
  const content = firstValue(result, ['content']);
  if (!content || typeof content !== 'object') throw new Error('Kakao overview shape changed');
  const props = firstValue(content, ['service_property', 'serviceProperty']);
  return {
    title: String(firstValue(content, ['title', 'name', 'seoTitle']) ?? ''),
    sourceCount: parseCount(firstValue(props, ['viewCount', 'view_count', 'readCount', 'read_count'])),
    genre: firstValue(content, ['sub_category', 'subCategory']) === null ? null : String(firstValue(content, ['sub_category', 'subCategory'])).replace(/^#+\s*/, '').trim(),
  };
};

export const parseKakaoTags = (data: unknown) => {
  const result = firstValue(data, ['result']);
  if (!result || typeof result !== 'object' || Array.isArray(result) || !('theme_keyword_list' in result)) throw new Error('Kakao about shape changed');
  const list = (result as Record<string, unknown>).theme_keyword_list;
  if (!Array.isArray(list)) throw new Error('Kakao tag list shape changed');
  return normalizeTags(list.map((item) => firstValue(item, ['title'])));
};

const crawlKakao = async (title: string, signal: AbortSignal): Promise<PlatformCrawlResult> => {
  const search = new URL('https://bff-page.kakao.com/api/gateway/api/v2/search/series');
  search.search = new URLSearchParams({ keyword: title, category_uid: '11', is_complete: 'false', sort_type: 'ACCURACY', page: '0', size: '5' }).toString();
  const selected = selectUniqueExactCandidate(title, parseKakaoCandidates(await fetchBounded(search, signal, true)));
  if (!selected.candidate) return empty('kakao', selected.status === 'ambiguous' ? 'ambiguous' : 'not-found');
  const overviewUrl = new URL('https://bff-page.kakao.com/api/gateway/api/v1/content/overview');
  overviewUrl.searchParams.set('series_id', selected.candidate.id);
  const overview = parseKakaoOverview(await fetchBounded(overviewUrl, signal, true));
  if (!overview.title) throw new Error('Kakao overview has no title');
  if (!titlesMatch(title, overview.title)) return empty('kakao', 'not-found');
  let tags: string[] | null = null;
  try {
    const aboutUrl = new URL('https://bff-page.kakao.com/api/gateway/api/v1/content/about');
    aboutUrl.searchParams.set('series_id', selected.candidate.id);
    tags = parseKakaoTags(await fetchBounded(aboutUrl, signal, true));
  } catch {
    tags = null;
  }
  return { platform: 'kakao', status: 'ok', remoteId: selected.candidate.id, remoteTitle: overview.title, url: `https://page.kakao.com/content/${selected.candidate.id}`, genre: overview.genre, tags, sourceCount: overview.sourceCount ?? selected.candidate.sourceCount ?? null };
};

const novelpiaTitle = (record: unknown) => String(firstValue(record, ['novel_name', 'novelName', 'title', 'name', 'subject']) ?? '');

export const parseNovelpiaTags = (record: unknown): string[] | null => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const value = (record as Record<string, unknown>).novel_genre_arr ?? (record as Record<string, unknown>).novel_genre;
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return normalizeTags(value);
  if (typeof value === 'string') {
    const decoded = JSON.parse(value) as unknown;
    if (!Array.isArray(decoded)) throw new Error('NovelPia genre shape changed');
    return normalizeTags(decoded);
  }
  throw new Error('NovelPia genre shape changed');
};

export const parseNovelpiaDetailTags = (page: string) => {
  const blocks = page.match(/<p\b[^>]*class=["'][^"']*\bwriter-tag\b[^"']*["'][^>]*>[\s\S]*?<\/p>/gi) ?? [];
  if (blocks.length === 0) throw new Error('NovelPia detail tag shape changed');
  return normalizeTags(blocks.flatMap((block) => [...block.matchAll(/<span\b[^>]*class=["'][^"']*\btag\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)].map((match) => stripHtml(match[1]))));
};

const crawlNovelpia = async (title: string, signal: AbortSignal, _authProvider: PlatformAuthProvider | null): Promise<PlatformCrawlResult> => {
  const search = new URL('https://novelpia.com/proc/novel');
  search.search = new URLSearchParams({ cmd: 'novel_search', page: '1', rows: '30', search_type: 'novel_name', search_val: title, novel_type: '', start_count_book: '', end_count_book: '', novel_age: '', start_days: '', sort_col: 'last_viewdate', novel_genre: '', block_out: '0', block_stop: '0', is_contest: '0', is_complete: '', is_challenge: '', list_display: 'list' }).toString();
  const data = await fetchBounded(search, signal, true);
  const list = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).list : null;
  if (!Array.isArray(list)) throw new Error('NovelPia search shape changed');
  const candidates: Candidate<Record<string, unknown>>[] = list.flatMap((item) => {
    const id = firstValue(item, ['novel_no', 'novelNo', 'novel_id', 'novelId', 'id']);
    const candidateTitle = novelpiaTitle(item);
    return id && candidateTitle ? [{ id: String(id), title: candidateTitle, record: item as Record<string, unknown> }] : [];
  });
  if (list.length > 0 && candidates.length === 0) throw new Error('NovelPia search item shape changed');
  let selected = selectUniqueExactCandidate(title, candidates);
  if (!selected.candidate && selected.status === 'not-found' && _authProvider?.isConfigured()) {
    try {
      const authenticated = await _authProvider.withSession(async (session) => (
        parseBoundedResponse(await session.fetch(search, { signal }), true)
      ));
      const authenticatedList = authenticated && typeof authenticated === 'object' && !Array.isArray(authenticated)
        ? (authenticated as Record<string, unknown>).list
        : null;
      if (!Array.isArray(authenticatedList)) throw new Error('NovelPia authenticated search shape changed');
      const authenticatedCandidates: Candidate<Record<string, unknown>>[] = authenticatedList.flatMap((item) => {
        const id = firstValue(item, ['novel_no', 'novelNo', 'novel_id', 'novelId', 'id']);
        const candidateTitle = novelpiaTitle(item);
        return id && candidateTitle ? [{ id: String(id), title: candidateTitle, record: item as Record<string, unknown> }] : [];
      });
      selected = selectUniqueExactCandidate(title, authenticatedCandidates);
    } catch {
      // Authentication is optional. Public results and other platforms remain authoritative.
    }
  }
  if (!selected.candidate) return empty('novelpia', selected.status === 'ambiguous' ? 'ambiguous' : 'not-found');
  const record = selected.candidate.record ?? {};
  let tags: string[] | null;
  try { tags = parseNovelpiaTags(record); } catch { tags = null; }
  if (tags === null) {
    try { tags = parseNovelpiaDetailTags(await fetchBounded(new URL(`https://novelpia.com/novel/${selected.candidate.id}`), signal) as string); } catch { tags = null; }
  }
  return {
    platform: 'novelpia', status: 'ok', remoteId: selected.candidate.id, remoteTitle: selected.candidate.title,
    url: `https://novelpia.com/novel/${selected.candidate.id}`, genre: tags?.[0] ?? null, tags,
    sourceCount: parseCount(firstValue(record, ['count_view', 'view_count', 'viewCount', 'hit', 'hits'])),
  };
};

export const crawlPublicBookMetadata = async (
  title: string,
  signal: AbortSignal,
  authProvider: PlatformAuthProvider | null = null,
) => {
  const bounded = async (platform: PlatformId, work: (childSignal: AbortSignal) => Promise<PlatformCrawlResult>) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, BOOK_METADATA_LIMITS.platformTimeoutMs);
    try { return await work(controller.signal); } catch (error) { return safeError(platform, error); } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  };
  return Promise.all([
    bounded('series', (childSignal) => crawlSeries(title, childSignal)),
    bounded('kakao', (childSignal) => crawlKakao(title, childSignal)),
    bounded('novelpia', (childSignal) => crawlNovelpia(title, childSignal, authProvider)),
  ]);
};
