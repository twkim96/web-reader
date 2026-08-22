'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { CalendarClock, Clipboard, Clock3, Database, ExternalLink, FileType2, ImageDown, Info, RefreshCw, Trash2, X } from 'lucide-react';
import type { Book, UserProgress } from '../../types';
import type { OwnerKey } from '../../lib/ownerIdentity';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { getLocalReadingSessionsV11 } from '../../lib/localReadingStatistics';
import { buildReadingStatistics } from '../../lib/readingStatistics';
import { subscribeReadingStatisticsChanges } from '../../lib/readingStatisticsWake';
import {
  getBookFormatLabel,
  canRequestPublicBookMetadata,
  getDisplayBookTitle,
  getProgressTime,
  getVisibleBookInfoCatalogTags,
  type ShelfTheme,
} from './bookUtils';
import {
  loadPublicBookMetadata,
  requestPublicBookMetadataRefresh,
  type PublicBookMetadata,
  type PublicBookPlatformMetadata,
} from '../../lib/publicBookMetadata';
import { readHiddenReadingStatisticsSessionIds } from '../../lib/readingStatisticsSessionVisibility';
import type { PublicBookCatalogBook } from '../../lib/publicBookCatalog';
import type { PublicBookCatalogLoadState } from '../../hooks/usePublicBookCatalog';
import { useShelfBookCover } from './useShelfBookCovers';
import { GeneratedBookCover } from './GeneratedBookCover';

type Props = {
  book: Book;
  ownerKey: OwnerKey;
  progress?: UserProgress;
  isDownloaded: boolean;
  isOfflineMode: boolean;
  theme: ShelfTheme;
  catalog?: PublicBookCatalogBook;
  catalogState?: PublicBookCatalogLoadState;
  isDeleting?: boolean;
  showManagementActions?: boolean;
  canDeleteLocalCopy?: boolean;
  onOpen?: (book: Book) => void;
  onDelete?: () => Promise<void>;
  onDeleteLocalCopy?: () => Promise<void>;
  onCatalogRefresh?: () => void;
  onClose: () => void;
};

const formatBookSize = (size: Book['size']) => {
  const bytes = typeof size === 'string' ? Number(size) : size;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '알 수 없음';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('ko-KR')}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
};

const formatLastRead = (lastRead: UserProgress['lastRead'] | undefined) => {
  const time = getProgressTime(lastRead);
  if (!time) return '아직 읽지 않음';
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(time);
};

const formatBookReadingTime = (durationMs: number | null) => {
  if (durationMs === null || durationMs <= 0) return '';
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  return `${Math.floor(totalMinutes / 60)}시간 ${totalMinutes % 60}분`;
};

const getBookProofFileName = (name: string) => {
  const title = getDisplayBookTitle(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '도서';
  const date = new Date().toISOString().slice(0, 10);
  return `독서인증_${title}_${date}.png`;
};

export const BookInfoModal: React.FC<Props> = ({
  book,
  ownerKey,
  progress,
  isDownloaded,
  isOfflineMode,
  theme,
  catalog,
  catalogState = 'ready',
  isDeleting = false,
  showManagementActions = true,
  canDeleteLocalCopy = false,
  onOpen,
  onDelete,
  onDeleteLocalCopy,
  onCatalogRefresh,
  onClose,
}) => {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureFeedback, setCaptureFeedback] = useState('');
  const [deleteFeedback, setDeleteFeedback] = useState('');
  const [metadata, setMetadata] = useState<PublicBookMetadata | null>(null);
  const [metadataState, setMetadataState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [requestState, setRequestState] = useState<'idle' | 'requesting' | 'ready' | 'not-found' | 'ambiguous' | 'busy' | 'quota' | 'offline' | 'login-required' | 'error'>('idle');
  const [readingTimeMs, setReadingTimeMs] = useState<number | null>(null);
  const coverUrl = useShelfBookCover(book);
  const dialogRef = useRef<HTMLElement>(null);
  const captureRef = useRef<HTMLDivElement>(null);
  const metadataRequestSequenceRef = useRef(0);
  useBodyScrollLock();

  useEffect(() => {
    let active = true;
    void loadPublicBookMetadata(book.name).then((value) => {
      if (!active) return;
      setMetadata(value);
      setMetadataState(value ? 'ready' : 'missing');
    }).catch((error) => {
      if (!active) return;
      console.warn('[BookInfo] metadata lookup failed:', error);
      setMetadataState('error');
    });
    return () => { active = false; };
  }, [book.name]);

  useEffect(() => {
    let active = true;
    const reload = async () => {
      try {
        const sessions = await getLocalReadingSessionsV11(ownerKey);
        if (!active) return;
        const hiddenSessionIds = readHiddenReadingStatisticsSessionIds(ownerKey);
        const bookStatistics = buildReadingStatistics(sessions.filter(({ sessionId }) => (
          !hiddenSessionIds.has(sessionId)
        ))).books
          .find(({ bookId }) => bookId === book.id);
        setReadingTimeMs(bookStatistics && bookStatistics.totalMs > 0
          ? bookStatistics.totalMs
          : null);
      } catch (error) {
        if (!active) return;
        console.warn('[BookInfo] reading statistics lookup failed:', error);
        setReadingTimeMs(null);
      }
    };
    void reload();
    const unsubscribe = subscribeReadingStatisticsChanges(ownerKey, () => {
      void reload();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [book.id, ownerKey]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isDeleting) return;
      event.preventDefault();
      if (confirmingDelete) setConfirmingDelete(false);
      else onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handleKeyDown);
      previous?.focus();
    };
  }, [confirmingDelete, isDeleting, onClose]);

  const sourceLabel = isOfflineMode || book.source === 'local'
    ? '기기 로컬'
    : 'Google Drive';
  const progressPercent = Math.min(100, Math.max(0, progress?.progressPercent ?? 0));
  const visibleCatalogTags = getVisibleBookInfoCatalogTags(catalog);
  const hasRawCatalogTags = visibleCatalogTags.length > 0;
  const canRequestMetadata = canRequestPublicBookMetadata(
    catalog,
    catalogState,
    metadata,
    metadataState,
  );
  const requestMetadata = useCallback(async () => {
    const sequence = ++metadataRequestSequenceRef.current;
    if (!navigator.onLine) {
      setRequestState('offline');
      return;
    }
    setRequestState('requesting');
    try {
      const result = await requestPublicBookMetadataRefresh(book.name);
      if (sequence !== metadataRequestSequenceRef.current) return;
      if (result.metadata) {
        setMetadata(result.metadata);
        setMetadataState('ready');
      }
      if (result.status === 'ready') {
        setRequestState('ready');
        onCatalogRefresh?.();
      } else if (result.status === 'ambiguous') setRequestState('ambiguous');
      else if (result.status === 'not-found') setRequestState('not-found');
      else if (result.status === 'busy') setRequestState('busy');
      else if (result.status === 'quota' || result.status === 'cooldown') setRequestState('quota');
      else setRequestState('error');
    } catch (error) {
      if (sequence !== metadataRequestSequenceRef.current) return;
      setRequestState(error instanceof Error && error.message === 'login-required' ? 'login-required' : 'error');
    }
  }, [book.name, onCatalogRefresh]);

  useEffect(() => () => {
    metadataRequestSequenceRef.current += 1;
  }, [book.name]);
  const formatMetric = (value: number | null) => value === null
    ? null
    : new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const platformMetrics = (platform: PublicBookPlatformMetadata) => [
    platform.viewCount !== null && `조회 ${formatMetric(platform.viewCount)}`,
    platform.downloadCount !== null && `다운로드 ${formatMetric(platform.downloadCount)}`,
    platform.interestCount !== null && `관심 ${formatMetric(platform.interestCount)}`,
    platform.recommendCount !== null && `추천 ${formatMetric(platform.recommendCount)}`,
    platform.rating !== null && `평점 ${platform.rating.toFixed(1)}`,
    platform.ratingCount !== null && `평가 ${formatMetric(platform.ratingCount)}`,
  ].filter(Boolean).slice(0, 2).join(' · ');

  const createReadingProofBlob = useCallback(async () => {
    const source = captureRef.current;
    if (!source) throw new Error('Reading proof source is unavailable');
    let captureNode: HTMLElement | null = null;
    try {
      await document.fonts?.ready;
      captureNode = source.cloneNode(true) as HTMLElement;
      const sourceStyle = getComputedStyle(source);
      const dialogStyle = dialogRef.current ? getComputedStyle(dialogRef.current) : sourceStyle;
      for (let index = 0; index < sourceStyle.length; index += 1) {
        const property = sourceStyle.item(index);
        if (property.startsWith('--')) {
          captureNode.style.setProperty(property, sourceStyle.getPropertyValue(property));
        }
      }
      Object.assign(captureNode.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: `${Math.ceil(source.getBoundingClientRect().width)}px`,
        maxHeight: 'none',
        height: 'auto',
        overflow: 'hidden',
        flex: 'none',
        pointerEvents: 'none',
        zIndex: '-2147483647',
        border: dialogStyle.border,
        borderRadius: dialogStyle.borderRadius,
        boxShadow: dialogStyle.boxShadow,
        backgroundColor: sourceStyle.backgroundColor,
      });
      const scrollBody = captureNode.querySelector<HTMLElement>('[data-book-info-scroll-body="true"]');
      if (scrollBody) Object.assign(scrollBody.style, {
        maxHeight: 'none',
        height: 'auto',
        overflow: 'visible',
      });
      document.body.appendChild(captureNode);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const captureRect = captureNode.getBoundingClientRect();
      if (captureRect.width < 1 || captureRect.height < 1) {
        throw new Error('Reading proof capture has no renderable area');
      }
      const { toBlob } = await import('html-to-image');
      const blob = await toBlob(captureNode, {
        cacheBust: true,
        pixelRatio: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
        backgroundColor: sourceStyle.backgroundColor,
      });
      if (!blob || blob.size === 0) throw new Error('Reading proof PNG is empty');
      return blob;
    } finally {
      captureNode?.remove();
    }
  }, []);

  const downloadReadingProof = useCallback(async () => {
    if (capturing) return;
    setCapturing(true);
    setCaptureFeedback('이미지 생성 중…');
    try {
      const blob = await createReadingProofBlob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = getBookProofFileName(book.name);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      setCaptureFeedback('독서 인증 이미지를 다운로드했습니다.');
    } catch (error) {
      console.error('[BookInfo] reading proof download failed:', error);
      setCaptureFeedback('이미지를 만들지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setCapturing(false);
    }
  }, [book.name, capturing, createReadingProofBlob]);

  const copyReadingProof = useCallback(async () => {
    if (capturing) return;
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      setCaptureFeedback('이 브라우저는 이미지 클립보드 저장을 지원하지 않습니다.');
      return;
    }
    setCapturing(true);
    setCaptureFeedback('이미지 생성 중…');
    try {
      // Pass the pending PNG to ClipboardItem immediately so browsers that
      // enforce transient user activation keep the clipboard write authorized.
      const blobPromise = createReadingProofBlob();
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blobPromise }),
      ]);
      setCaptureFeedback('독서 인증 이미지를 클립보드에 저장했습니다.');
    } catch (error) {
      console.error('[BookInfo] reading proof clipboard copy failed:', error);
      setCaptureFeedback('이미지를 클립보드에 저장하지 못했습니다.');
    } finally {
      setCapturing(false);
    }
  }, [capturing, createReadingProofBlob]);

  const deleteLocalCopy = useCallback(async () => {
    if (!onDeleteLocalCopy || isDeleting) return;
    setDeleteFeedback('');
    try {
      await onDeleteLocalCopy();
      setConfirmingDelete(false);
    } catch (error) {
      console.error('[BookInfo] local copy deletion failed:', error);
      setDeleteFeedback('로컬 사본을 삭제하지 못했습니다. 다시 시도해 주세요.');
    }
  }, [isDeleting, onDeleteLocalCopy]);

  return (
    <div
      className="fixed inset-0 z-[180] flex items-center justify-center bg-black/65 p-2 backdrop-blur-sm sm:p-5"
      onClick={() => { if (!isDeleting) onClose(); }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="book-info-title"
        tabIndex={-1}
        data-book-info-modal="true"
        data-book-info-id={book.id}
        onClick={(event) => event.stopPropagation()}
        className={`flex max-h-[78dvh] w-[min(90vw,36rem)] min-w-0 select-text flex-col overflow-hidden rounded-2xl border ${theme.border} ${theme.bg} ${theme.text} shadow-2xl outline-none focus:outline-none sm:max-h-[82dvh] sm:rounded-3xl`}
      >
        <div
          ref={captureRef}
          data-book-info-capture-root="true"
          className={`flex min-h-0 flex-1 flex-col overflow-hidden ${theme.bg} ${theme.text}`}
        >
          <header data-modal-header="book-info" className={`flex items-center justify-between border-b ${theme.border} px-3 py-2 sm:px-4`}>
            <div className="flex min-w-0 items-center gap-2.5">
              <div data-modal-header-icon="book-info" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${theme.secondary}`}>
                <Info size={19} aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 id="book-info-title" className="text-base font-black sm:text-lg">도서 정보</h2>
                <p className="truncate text-[10px] font-bold opacity-45">{getBookFormatLabel(book)} · {sourceLabel}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={isDeleting}
              aria-label="도서 정보 닫기"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-black/5 disabled:opacity-35 dark:hover:bg-white/10"
            >
              <X size={22} />
            </button>
          </header>

          <div data-book-info-scroll-body="true" className="min-h-0 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4 sm:py-4">
            <div data-book-info-title-layout="true" className="flex min-w-0 items-start gap-3">
              <div
                data-book-info-cover-frame="true"
                className="relative h-28 w-[4.5rem] shrink-0 overflow-hidden sm:h-32 sm:w-[5.25rem]"
              >
                {coverUrl ? (
                  <Image
                    data-book-info-cover="true"
                    src={coverUrl}
                    alt=""
                    fill
                    sizes="(min-width: 640px) 84px, 72px"
                    unoptimized
                    className="object-cover"
                  />
                ) : (
                  <GeneratedBookCover
                    identity={book.id}
                    title={getDisplayBookTitle(book.name)}
                    variant="info"
                  />
                )}
              </div>
              <div
                data-book-info-title-meta-column="true"
                className="flex min-h-28 min-w-0 flex-1 flex-col pt-0.5 sm:min-h-32"
              >
                <h3 className="break-words text-lg font-black leading-snug sm:text-xl">
                  {getDisplayBookTitle(book.name)}
                </h3>
                <p className="mt-1 break-all text-[10px] leading-4 opacity-45">{book.name}</p>

                <div data-book-info-tag-row="true" className="mt-auto flex flex-wrap gap-1.5 pt-3">
                  <span className="rounded-full bg-accent-500/12 px-2 py-1 text-[10px] font-bold text-accent-500">
                    {getBookFormatLabel(book)}
                  </span>
                  <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${isDownloaded ? 'bg-emerald-500/12 text-emerald-500' : 'bg-black/5 opacity-55 dark:bg-white/5'}`}>
                    {isDownloaded ? '기기 저장됨' : '클라우드 전용'}
                  </span>
                  {metadata?.platforms.map((platform) => (
                    <span
                      key={platform.platform}
                      data-book-info-platform-badge={platform.platform}
                      className="rounded-full bg-accent-500/12 px-2 py-1 text-[10px] font-bold text-accent-500"
                    >
                      {platform.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-1.5">
              {[
                { icon: FileType2, label: '파일 형식', value: getBookFormatLabel(book) },
                { icon: Database, label: '파일 크기', value: formatBookSize(book.size) },
                { icon: Clock3, label: '읽은 시간', value: formatBookReadingTime(readingTimeMs) },
                { icon: CalendarClock, label: '최근 독서', value: formatLastRead(progress?.lastRead) },
              ].map(({ icon: Icon, label, value }) => (
                <div key={label} className={`min-w-0 rounded-xl border ${theme.border} px-2.5 py-2 sm:rounded-2xl`}>
                  <dt className="flex items-center gap-1 text-[10px] font-bold opacity-45"><Icon size={12} />{label}</dt>
                  <dd
                    data-book-info-value={label === '읽은 시간' ? 'reading-time' : undefined}
                    className="mt-1 min-h-4 truncate text-xs font-bold sm:text-sm"
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>

            <div className={`mt-3 rounded-xl border ${theme.border} px-3 py-2.5 sm:rounded-2xl`}>
              <div className="flex items-center justify-between gap-3 text-xs font-bold">
                <span className="opacity-55">읽기 진행률</span>
                <strong className="text-accent-500">{progressPercent.toFixed(1)}%</strong>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/15 dark:bg-black/30">
                <div className="h-full rounded-full bg-accent-500" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>

            <section
              data-book-metadata-summary="true"
              className={`mt-3 rounded-xl border ${theme.border} px-3 py-2.5 sm:rounded-2xl`}
              aria-labelledby="book-platform-metadata-title"
            >
              <div className="flex items-center justify-between gap-2">
                <h4 id="book-platform-metadata-title" className="text-xs font-black sm:text-sm">작품 정보</h4>
                {metadata && (
                  <span className="text-[9px] opacity-40">
                    {new Date(metadata.publishedAt).toLocaleDateString('ko-KR')} 갱신
                  </span>
                )}
              </div>
              {metadataState === 'loading' ? (
                <p role="status" className="py-3 text-center text-[10px] opacity-40">플랫폼 정보를 확인하는 중…</p>
              ) : metadataState === 'ready' && metadata ? (
                <div data-book-platform-metadata="true" className="mt-2 grid gap-1.5">
                  {metadata.platforms.map((platform) => (
                    <a
                      key={platform.platform}
                      href={platform.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex min-w-0 items-center gap-2 rounded-lg bg-black/5 px-2.5 py-2 hover:bg-accent-500/10 dark:bg-white/5"
                    >
                      <span className="min-w-0 flex-1">
                        <strong data-book-info-platform-metrics={platform.platform} className="block truncate text-xs font-black text-accent-500 sm:text-sm">
                          {platformMetrics(platform) || platform.label}
                        </strong>
                        <small data-book-info-platform-title={platform.platform} className="mt-0.5 block truncate text-[10px] font-bold opacity-50 sm:text-[11px]">
                          {platform.title}
                        </small>
                      </span>
                      <ExternalLink size={13} className="shrink-0 opacity-35 group-hover:text-accent-500 group-hover:opacity-100" />
                    </a>
                  ))}
                </div>
              ) : (
                <p className="py-3 text-center text-[10px] opacity-40">
                  {metadataState === 'error' ? '플랫폼 정보를 불러오지 못했습니다.' : '연결된 플랫폼 정보가 없습니다.'}
                </p>
              )}

              <div
                data-book-catalog-tags="true"
                className={`mt-3 border-t ${theme.border} pt-2.5`}
                aria-label="장르 및 태그"
              >
                {catalogState === 'loading' && !catalog ? (
                  <p role="status" className="py-2 text-[10px] opacity-40">장르·태그를 불러오는 중…</p>
                ) : (
                  <>
                    {catalog && (catalog.genreLabel || visibleCatalogTags.length > 0) && (
                    <div className="flex flex-wrap gap-1.5">
                      {catalog.genreLabel && (
                        <span className="rounded-full bg-accent-500/12 px-2 py-1 text-[10px] font-black text-accent-500">
                          {catalog.genreLabel}
                        </span>
                      )}
                      {visibleCatalogTags.map((tag) => (
                        <span
                          key={tag.id}
                          data-book-catalog-tag="true"
                          className="rounded-full bg-black/5 px-2 py-1 text-[10px] font-bold opacity-65 dark:bg-white/5"
                        >
                          #{tag.label}
                        </span>
                      ))}
                    </div>
                    )}
                    {!hasRawCatalogTags && (
                    <div className="flex items-center justify-between gap-3">
                      <p role="status" className="text-[10px] opacity-45">
                        {requestState === 'requesting' && '플랫폼에서 메타데이터를 확인하는 중…'}
                        {requestState === 'ready' && '메타데이터를 반영했습니다.'}
                        {requestState === 'not-found' && '공개 검색에서 찾지 못함 · 성인 인증 작품일 수 있음'}
                        {requestState === 'ambiguous' && '동일 제목 작품이 여러 개라 자동 반영하지 않았습니다.'}
                        {requestState === 'busy' && '같은 작품을 확인 중입니다. 잠시 뒤 다시 시도해 주세요.'}
                        {requestState === 'quota' && '요청 간격 또는 오늘의 요청 한도에 도달했습니다.'}
                        {requestState === 'offline' && '온라인 상태에서 요청할 수 있습니다.'}
                        {requestState === 'login-required' && '로그인 후 요청할 수 있습니다.'}
                        {requestState === 'error' && '요청하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'}
                        {requestState === 'idle' && '등록된 태그가 없습니다.'}
                      </p>
                      {canRequestMetadata && (
                        <button
                          type="button"
                          data-book-metadata-request="true"
                          disabled={requestState === 'requesting'}
                          onClick={() => void requestMetadata()}
                          className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl bg-accent-500/12 px-3 text-[10px] font-black text-accent-500 disabled:opacity-45"
                        >
                          <RefreshCw size={12} className={requestState === 'requesting' ? 'animate-spin' : ''} />
                          {requestState === 'requesting' ? '확인 중' : '메타데이터 요청'}
                        </button>
                      )}
                    </div>
                    )}
                  </>
                )}
              </div>
            </section>
          </div>
        </div>

        <footer data-book-info-actions="true" className={`shrink-0 border-t ${theme.border} px-3 py-2 sm:px-4`}>
          {captureFeedback && (
            <p data-book-info-capture-status="true" role="status" className="mb-1.5 text-center text-[10px] font-bold text-accent-500">
              {captureFeedback}
            </p>
          )}
          <div className={`grid gap-1.5 ${showManagementActions ? 'grid-cols-[1fr_auto_auto_auto]' : 'grid-cols-[auto_auto] justify-end'}`}>
            {showManagementActions && (
              <button
                type="button"
                onClick={() => onOpen?.(book)}
                aria-label="읽기"
                className="min-h-11 rounded-xl bg-accent-600 px-4 text-xs font-bold text-white"
              >
                읽기
              </button>
            )}
            <button
              type="button"
              data-book-info-copy-image="true"
              onClick={() => void copyReadingProof()}
              disabled={capturing || isDeleting}
              aria-label={capturing ? '독서 인증 이미지 생성 중' : '독서 인증 이미지 클립보드에 저장'}
              title="독서 인증 이미지 클립보드에 저장"
              className={`flex size-11 items-center justify-center rounded-xl border ${theme.border} text-accent-500 hover:bg-accent-500/10 disabled:opacity-40`}
            >
              <Clipboard size={18} className={capturing ? 'animate-pulse' : undefined} />
            </button>
            <button
              type="button"
              data-book-info-capture="true"
              onClick={() => void downloadReadingProof()}
              disabled={capturing || isDeleting}
              aria-label={capturing ? '독서 인증 이미지 생성 중' : '독서 인증 이미지 다운로드'}
              title="독서 인증 이미지 다운로드"
              className={`flex size-11 items-center justify-center rounded-xl border ${theme.border} text-accent-500 hover:bg-accent-500/10 disabled:opacity-40`}
            >
              <ImageDown size={18} className={capturing ? 'animate-pulse' : undefined} />
            </button>
            {showManagementActions && (
              <button
                type="button"
                data-book-info-request-delete="true"
                onClick={() => setConfirmingDelete(true)}
                aria-label={`${getDisplayBookTitle(book.name)} 삭제`}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-red-400 hover:bg-red-500/10"
              >
                <Trash2 size={18} />
              </button>
            )}
          </div>
        </footer>
      </section>

      {confirmingDelete && showManagementActions && (
        <div
          className="fixed inset-0 z-[190] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
          onClick={() => { if (!isDeleting) setConfirmingDelete(false); }}
        >
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="book-info-delete-title"
            data-book-info-delete-confirmation="true"
            onClick={(event) => event.stopPropagation()}
            className={`w-full max-w-sm rounded-2xl border ${theme.border} ${theme.bg} ${theme.text} p-4 shadow-2xl outline-none`}
          >
            <h3 id="book-info-delete-title" className="text-base font-black">이 도서를 삭제하시겠습니까?</h3>
            <p className="mt-2 text-xs leading-5 opacity-65">
              {canDeleteLocalCopy
                ? '기기에 저장된 사본만 삭제하거나 Google Drive 원본까지 전체 삭제할 수 있습니다.'
                : sourceLabel === '기기 로컬'
                  ? '로컬 저장소에서 영구 삭제됩니다.'
                  : 'Google Drive 원본과 기기에 저장된 사본이 모두 삭제됩니다.'}
            </p>
            {deleteFeedback && (
              <p role="status" className="mt-2 text-xs font-bold text-red-400">{deleteFeedback}</p>
            )}
            <div className="mt-4 grid gap-1.5">
              {canDeleteLocalCopy && onDeleteLocalCopy && (
                <button
                  type="button"
                  data-book-info-delete-local="true"
                  onClick={() => void deleteLocalCopy()}
                  disabled={isDeleting}
                  className={`min-h-11 rounded-xl border ${theme.border} text-xs font-bold disabled:opacity-40`}
                >
                  {isDeleting ? '삭제 중…' : '로컬 삭제'}
                </button>
              )}
              <button
                type="button"
                data-book-info-confirm-delete="true"
                onClick={() => void onDelete?.()}
                disabled={isDeleting}
                className="min-h-11 rounded-xl bg-red-500 px-4 text-xs font-bold text-white disabled:opacity-50"
              >
                {isDeleting ? '삭제 중…' : canDeleteLocalCopy ? '전체 삭제' : '영구 삭제'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={isDeleting}
                className={`min-h-11 rounded-xl border ${theme.border} text-xs font-bold disabled:opacity-35`}
              >
                취소
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
