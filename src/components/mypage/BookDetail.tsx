'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Bookmark as BookmarkIcon, Check, Heart, Star } from 'lucide-react';
import type { Book, UserProgress } from '../../types';
import { buildLocalReviewReading, buildPersonalBookReading, getWorkReadingTitles } from '../../lib/bookDetail';
import type { DiscoveryBook } from '../../lib/bookDiscovery';
import { getLocalReadingSessionsV11 } from '../../lib/localReadingStatistics';
import { isGuestOwner, type OwnerKey } from '../../lib/ownerIdentity';
import type { PublicBookMetadata } from '../../lib/publicBookMetadata';
import { getPublicBookCoverCandidates } from '../../lib/publicBookMetadataSchema';
import { parsePublicBookReview, PUBLIC_BOOK_REVIEW_LIMIT } from '../../lib/publicBookReviews';
import { resolveReviewWork, formatMyPageIdentity, indexReviewWorks, MY_PAGE_CODE, publicReaderHref, type MyPageIdentity, type MyPageReview, type PublicWorkReviews } from '../../lib/myPageSocial';
import { useMyPageReadingFiles, useMyPageWorkReview } from '../../hooks/useMyPageList';
import { ownerRuntime } from '../../lib/ownerRuntime';
import { loadReadBookMetadata } from '../../lib/readBookMetadata';
import { readCachedReadBookMetadata } from '../../lib/readBookMetadataCache';
import { getPlatformWorkKeys, platformWorkKey, type ReadBook } from '../../lib/readBooks';
import { formatReadingDuration, type StoredReadingSessionV11 } from '../../lib/readingStatistics';
import { subscribeReadingStatisticsChanges } from '../../lib/readingStatisticsWake';
import { BookCover } from './BookCover';
import { BookReviewEditor } from './BookReviewEditor';

const percent = new Intl.NumberFormat('ko', { maximumFractionDigits: 2 });
const formatPercent = (number: number) => `${percent.format(number)}%`;

function CommunityReviews({ workId }: { workId: string }) {
  type Entry = { rating: number; comment: string; totalMs: number | null; progressPercent: number | null; author?: MyPageIdentity };
  const [result, setResult] = useState<{ reviews: Entry[]; average: number | null; ratingCount: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`/api/book-reviews?workId=${encodeURIComponent(workId)}`, {
          signal: controller.signal, cache: 'no-store',
        });
        if (!response.ok) throw new Error('Reviews unavailable');
        const payload = await response.json() as Partial<PublicWorkReviews> | null;
        const entries = payload?.reviews;
        if (!Array.isArray(entries) || entries.length > PUBLIC_BOOK_REVIEW_LIMIT) throw new Error('Invalid reviews');
        const parsed = entries.map((entry): Entry | null => {
          if (!entry || typeof entry !== 'object') return null;
          const review = parsePublicBookReview({
            ...entry, totalMs: entry.totalMs === null ? 0 : entry.totalMs,
            progressPercent: entry.progressPercent === null ? 0 : entry.progressPercent,
          });
          if (!review || (entry.author && (typeof entry.author.nickname !== 'string' || !MY_PAGE_CODE.test(entry.author.code)))) return null;
          return { ...review, totalMs: entry.totalMs, progressPercent: entry.progressPercent, author: entry.author };
        });
        if (parsed.some((review) => review === null)) throw new Error('Invalid review');
        if (!controller.signal.aborted) setResult({
          reviews: parsed.filter((review) => review !== null),
          ratingCount: Number.isSafeInteger(payload?.ratingCount) ? payload!.ratingCount! : entries.length,
          average: typeof payload?.average === 'number' && Number.isFinite(payload.average) ? payload.average : null,
        });
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    };
    void load();
    return () => controller.abort();
  }, [retry, workId]);

  return (
    <section className="mypage-section" aria-label="다른 독자의 평가">
      <h2 className="text-lg font-semibold tracking-tight">다른 독자의 평가</h2>
      {failed ? <p role="alert" className="mt-3 text-sm opacity-75">평가를 불러오지 못했습니다. <button type="button" onClick={() => { setFailed(false); setRetry((value) => value + 1); }} className="text-accent-500">다시 시도</button></p>
        : result === null ? <p role="status" className="mt-3 text-sm opacity-60">평가를 불러오는 중…</p>
        : result.reviews.length === 0 ? <p className="mt-3 text-sm opacity-60">공개된 평가가 없습니다.</p>
        : <>
          {result.average !== null && <p className="mt-2 text-sm"><strong className="text-accent-500">{result.average.toFixed(2)} / 5</strong> <span className="opacity-65">공개 평가 {result.ratingCount.toLocaleString()}개</span></p>}
          {result.ratingCount > result.reviews.length && <p className="mt-1 text-xs opacity-60">최근 {result.reviews.length}개의 평가</p>}
          <ul className="mypage-divided-list mt-4">
            {result.reviews.map((review, index) => (
              <li key={review.author?.code ?? index} className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  {review.author
                    ? <a href={publicReaderHref(review.author.code)} className="font-semibold hover:text-accent-500">{formatMyPageIdentity(review.author)}</a>
                    : <span className="font-semibold">익명 독자</span>}
                  <span className="flex items-center gap-1 font-semibold text-accent-500" aria-label={`별점 ${review.rating}점, 5점 만점`}><Star size={14} fill="currentColor" aria-hidden="true" />{review.rating}/5</span>
                </div>
                {review.comment && <p className="break-words text-sm leading-relaxed">{review.comment}</p>}
                {review.totalMs !== null && review.progressPercent !== null && <p className="text-xs tabular-nums opacity-65">{formatReadingDuration(review.totalMs)} 읽음 · 진행률 {formatPercent(review.progressPercent)}</p>}
              </li>
            ))}
          </ul>
        </>}
    </section>
  );
}

const emptyHistory = { sessions: [] };

export function BookDetail({ bookId, discovery, readBook, ownerKey, books, progress, bookmarkProgress, catalogLoading, identityBlocked, saved, focusReview }: {
  bookId: string;
  discovery?: DiscoveryBook;
  readBook?: ReadBook;
  ownerKey: OwnerKey;
  books: Book[];
  progress: Record<string, UserProgress>;
  bookmarkProgress: Record<string, UserProgress>;
  catalogLoading: boolean;
  identityBlocked: boolean;
  saved: boolean;
  focusReview: boolean;
}) {
  const lookupId = discovery?.id ?? bookId;
  const reviews = useMyPageWorkReview(ownerKey, !isGuestOwner(ownerKey) && Boolean(discovery) && !identityBlocked, lookupId);
  const [reviewChangeVersion, setReviewChangeVersion] = useState(0);
  const reviewSession = ownerRuntime.capture();
  const reviewActive = useRef(false);
  useEffect(() => {
    reviewActive.current = true;
    return () => { reviewActive.current = false; };
  }, []);
  const changeReview = (review: MyPageReview | null, oldId: string) => {
    if (!reviewActive.current || reviewSession?.ownerKey !== ownerKey || !ownerRuntime.isCurrent(reviewSession)) return;
    // Cancel a pre-save response before replacing its data with the server ACK.
    const finish = reviews.cache.beginWrite(ownerKey);
    reviews.cache.update(reviewSession, (current) => ({
      reviews: [...(review ? [review] : []), ...current.reviews.filter((item) => item.workId !== oldId && item.workId !== review?.workId)],
      deletions: current.deletions.filter((item) => item.workId !== review?.workId),
    }));
    finish?.();
    setReviewChangeVersion((value) => value + 1);
    void reviews.refresh();
  };
  const [lookup, setLookup] = useState<{ id: string; value: PublicBookMetadata | null }>();
  const [loading, setLoading] = useState(true);
  const [metadataFailed, setMetadataFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [history, setHistory] = useState<{
    sessions: StoredReadingSessionV11[];
  } | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const { data: published } = useMyPageReadingFiles(ownerKey, Boolean(history && !historyFailed));
  const archived = published?.history ?? null;
  const [historyLookup, setHistoryLookup] = useState<{
    titles: string;
    metadata: ReadonlyMap<string, PublicBookMetadata | null>;
    failed: ReadonlySet<string>;
    uncertainTitles?: ReadonlySet<string>;
  }>();
  const [historyRetry, retryHistoryMetadata] = useState(0);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const reviewIndex = useMemo(() => indexReviewWorks(reviews.data?.reviews ?? []), [reviews.data]);
  const deletionIndex = useMemo(() => indexReviewWorks(reviews.data?.deletions ?? []), [reviews.data]);
  const readingInput = useMemo(() => ({
    ownerKey, books, progress, bookmarkProgress, ...(history ?? emptyHistory), archived,
  }), [ownerKey, books, progress, bookmarkProgress, history, archived]);
  const historyTitles = useMemo(() => JSON.stringify(getWorkReadingTitles(readingInput).sort()), [readingInput]);

  const historyResult = historyLookup?.titles === historyTitles ? historyLookup : undefined;
  const historyMetadata = historyResult?.metadata;
  const platformKeys = useMemo(() => discovery
    ? discovery.platforms.map(({ id, url }) => platformWorkKey(id, url)) : readBook?.platformWorkKeys ?? [], [discovery, readBook]);
  const candidate = lookup?.id === lookupId ? lookup.value : null;
  const metadata = candidate && (platformKeys.length && candidate.platforms.length
    ? getPlatformWorkKeys(candidate).some((key) => platformKeys.includes(key))
    : candidate.titleKey === lookupId || readBook?.equivalentTitleKeys?.includes(candidate.titleKey)) ? candidate : null;

  const historyReady = history !== null || historyFailed;
  useEffect(() => {
    const titles: string[] = JSON.parse(historyTitles);
    if (!historyReady || !titles.length) return;
    const controller = new AbortController();
    const load = async () => {
      const cached = await readCachedReadBookMetadata(ownerKey, titles);
      if (controller.signal.aborted) return;
      const missing = titles.filter((title) => !cached.has(title));
      const { metadata, failed, uncertainTitles } = missing.length
        ? await loadReadBookMetadata(missing, { signal: controller.signal, cacheOwnerKey: ownerKey })
        : { metadata: new Map<string, PublicBookMetadata | null>(), failed: new Set<string>(), uncertainTitles: undefined };
      if (controller.signal.aborted) return;
      for (const [title, match] of cached) metadata.set(title, match.metadata);
      setHistoryLookup({ titles: historyTitles, metadata, failed, uncertainTitles });
    };
    void load();
    return () => controller.abort();
  }, [historyReady, historyTitles, historyRetry, ownerKey]);

  useEffect(() => {
    const controller = new AbortController();
    void loadReadBookMetadata([lookupId], { signal: controller.signal }).then(({ metadata: result, failed }) => {
      if (controller.signal.aborted) return;
      setLookup({ id: lookupId, value: result.get(lookupId) ?? null });
      setMetadataFailed(failed.has(lookupId));
      setLoading(false);
    });
    return () => controller.abort();
  }, [lookupId, retry]);

  useEffect(() => {
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      try {
        const sessions = await getLocalReadingSessionsV11(ownerKey);
        if (current === revision) {
          setHistory({ sessions });
          setHistoryFailed(false);
        }
      } catch {
        if (current === revision) setHistoryFailed(true);
      }
    };
    const unsubscribe = subscribeReadingStatisticsChanges(ownerKey, () => { void refresh(); });
    void refresh();
    return () => {
      revision++;
      unsubscribe();
    };
  }, [ownerKey]);

  const work = useMemo(() => ({
    id: lookupId,
    equivalentTitleKeys: discovery ? [] : [bookId, ...(readBook?.equivalentTitleKeys ?? []), ...(metadata ? [metadata.titleKey] : [])],
    platformWorkKeys: discovery ? platformKeys : [...new Set([...platformKeys, ...(metadata ? getPlatformWorkKeys(metadata) : [])])],
  }), [bookId, discovery, lookupId, metadata, platformKeys, readBook]);
  const review = resolveReviewWork(reviewIndex, work);
  const deletion = resolveReviewWork(deletionIndex, work);
  const reviewBlocked = identityBlocked || (!catalogLoading && !discovery) || review.blocked || (!review.entry && deletion.blocked);
  const personal = useMemo(() => buildPersonalBookReading({
    ...readingInput,
    titleKeys: [work.id, bookId, ...work.equivalentTitleKeys],
    platformWorkKeys: work.platformWorkKeys,
    metadataByTitle: historyMetadata,
    uncertainTitles: historyResult?.uncertainTitles,
    knownFileIds: readBook?.fileIds ?? [],
  }), [work, bookId, historyMetadata, historyResult, readingInput, readBook]);
  const completeHistory = history && !historyFailed && (historyTitles === '[]' || historyResult?.failed.size === 0);
  const reviewFileIds = completeHistory ? personal.reviewFileIds : null;
  const confirmedReading = useMemo(() => history && reviewFileIds
    ? buildLocalReviewReading(history.sessions, ownerKey, reviewFileIds)
    : null, [history, ownerKey, reviewFileIds]);
  // A missing edition cannot make a comment edit overwrite a previously
  // confirmed reading total with the lower bound visible on this device.
  const previous = review.entry;
  const losesEvidence = personal.reviewHistoryPartial && confirmedReading && previous
    && (confirmedReading.totalMs < (previous.totalMs ?? 0)
      || confirmedReading.progressPercent < (previous.progressPercent ?? 0));
  const readingSnapshot = losesEvidence ? null : confirmedReading;
  const reviewPlatformKeys = [...new Set([...work.platformWorkKeys, ...(readBook?.platformWorkKeys ?? [])])];
  const title = discovery?.title ?? metadata?.displayTitle ?? readBook?.title;
  useEffect(() => {
    const heading = reviewHeading.current;
    if (!focusReview || !title || !heading) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView?.({ block: 'start', behavior: 'instant' });
  }, [focusReview, title]);
  const cover = discovery?.coverUrl ?? getPublicBookCoverCandidates(metadata)[0]?.coverUrl ?? readBook?.coverUrl ?? null;
  const platforms = new Map((discovery?.platforms ?? []).map(({ id, label, url }) => [
    platformWorkKey(id, url), { label, url, metrics: null as PublicBookMetadata['platforms'][number] | null },
  ]));
  for (const metrics of metadata?.platforms ?? []) {
    const { platform, label, url } = metrics;
    platforms.set(platformWorkKey(platform, url), { label, url, metrics });
  }
  const hasPersonal = personal.bookmarks.length > 0 || personal.hasRead;

  if (!title && (catalogLoading || loading)) return <p role="status" className="mypage-section text-sm opacity-70">도서 정보를 불러오는 중…</p>;
  if (!title) return (
    <section className="mypage-section space-y-3">
      <h2 className="text-lg font-semibold">도서 정보를 찾을 수 없습니다.</h2>
      {metadataFailed && <button type="button" onClick={() => { setLoading(true); setRetry((value) => value + 1); }} className="text-sm text-accent-500">다시 시도</button>}
    </section>
  );

  return (
    <>
      <section className="mypage-section" aria-label="도서 기본정보">
        <div className="flex items-start gap-4 sm:gap-6">
          <div className="w-20 shrink-0 sm:w-28"><BookCover url={cover} identity={lookupId} title={title} large coverLoading="direct-with-proxy-fallback" /></div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex min-h-5 items-center justify-between gap-2">
              <div className="min-w-0 break-words text-xs font-semibold text-accent-500">{discovery?.genre}</div>
              <div className="flex shrink-0 items-center gap-2.5">
                {personal.hasRead && <span role="img" aria-label="읽은 기록 있음" title="읽은 기록 있음" className="text-accent-500"><Check size={18} aria-hidden="true" /></span>}
                <span role="img" aria-label={saved ? '위시리스트에 담김' : '위시리스트에 담기지 않음'} title={saved ? '위시리스트에 담김' : '위시리스트에 담기지 않음'} className={saved ? 'text-accent-500' : 'opacity-55'}>
                  <Heart size={19} fill={saved ? 'currentColor' : 'none'} aria-hidden="true" />
                </span>
              </div>
            </div>
            <h2 className="break-words text-xl font-semibold leading-snug tracking-tight sm:text-3xl">{title}</h2>
            {discovery?.tags.length ? <ul className="mt-3 flex flex-wrap gap-x-2 gap-y-1.5 text-xs opacity-65">{discovery.tags.map((tag) => <li key={tag} className="break-all">#{tag}</li>)}</ul> : null}
            {discovery?.sourceCount != null && !metadata && <p className="mt-3 text-xs opacity-65">조회·다운로드 {discovery.sourceCount.toLocaleString('ko')}</p>}
          </div>
        </div>
        {platforms.size > 0 && (
          <ul className="mypage-divided-list mt-5 sm:grid-cols-3 sm:[&>li::after]:hidden">
            {[...platforms].map(([key, { label, url, metrics }]) => (
              <li key={key} className="min-w-0">
                <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center gap-1 text-sm font-medium text-accent-500">{label}<ArrowUpRight size={14} /></a>
                {metrics && <div className="flex flex-wrap gap-x-2 text-xs leading-5 opacity-65">
                  {metrics.viewCount !== null && <span>{metrics.viewCount.toLocaleString('ko')} 조회</span>}
                  {metrics.downloadCount !== null && <span>{metrics.downloadCount.toLocaleString('ko')} 다운로드</span>}
                  {metrics.rating !== null && <span>평점 {metrics.rating.toLocaleString('ko')}</span>}
                </div>}
              </li>
            ))}
          </ul>
        )}
      </section>
      {hasPersonal && (
        <section className="mypage-section" aria-label="내 독서 기록">
          <h2 className="text-lg font-semibold tracking-tight">내 독서 기록</h2>
          {personal.hasRead && (
            <dl className="mt-3 flex items-start gap-8 text-sm sm:gap-10">
              <div><dt className="text-xs opacity-65">읽은 시간</dt><dd className="mt-1 font-medium">{formatReadingDuration(personal.totalMs)}</dd></div>
              <div className="text-right"><dt className="text-xs opacity-65">진행도</dt><dd className="mt-1 font-medium tabular-nums">{formatPercent(personal.progressPercent)}</dd></div>
            </dl>
          )}
          {personal.bookmarks.length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs opacity-65">책갈피</h3>
              <ul className="mypage-divided-list mt-2">
                {personal.bookmarks.map(({ id, name, progressPercent }) => <li key={id} className="flex items-start gap-2 text-sm"><BookmarkIcon size={14} className="mt-0.5 shrink-0 text-accent-500" /><span className="min-w-0 flex-1 break-words">{name || '책갈피'}</span>{progressPercent !== undefined && <span className="shrink-0 text-xs tabular-nums opacity-65">{formatPercent(progressPercent)}</span>}</li>)}
              </ul>
            </div>
          )}
        </section>
      )}
      {Boolean(historyResult?.failed.size) && <p role="status" className="text-sm opacity-65">일부 독서 기록을 연결하지 못했습니다. <button type="button" className="text-accent-500" onClick={() => retryHistoryMetadata((value) => value + 1)}>기록 다시 연결</button></p>}
      {historyFailed && <p role="status" className="text-sm opacity-65">내 독서 기록을 불러오지 못했습니다.</p>}
      <BookReviewEditor key={work.id} ownerKey={ownerKey} workId={work.id} platformWorkKeys={reviewPlatformKeys} fileIds={losesEvidence ? [] : reviewFileIds ?? []}
        readingSnapshot={readingSnapshot} readingHistoryPartial={personal.reviewHistoryPartial} review={review.entry} deletion={deletion.entry} blocked={reviewBlocked}
        ready={reviews.ready} loadingHistory={catalogLoading || (!history && !historyFailed)}
        error={reviews.error} refresh={reviews.refresh} change={changeReview} headingRef={reviewHeading} />
      <CommunityReviews key={`${lookupId}:${reviewChangeVersion}`} workId={lookupId} />
    </>
  );
}
