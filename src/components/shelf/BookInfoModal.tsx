'use client';

import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, CalendarClock, Clock3, Database, ExternalLink, FileType2, Trash2, X } from 'lucide-react';
import type { Book, UserProgress } from '../../types';
import type { OwnerKey } from '../../lib/ownerIdentity';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { getLocalReadingSessionsV11 } from '../../lib/localReadingStatistics';
import { buildReadingStatistics } from '../../lib/readingStatistics';
import { subscribeReadingStatisticsChanges } from '../../lib/readingStatisticsWake';
import {
  getBookFormatLabel,
  getDisplayBookTitle,
  getProgressTime,
  type ShelfTheme,
} from './bookUtils';
import {
  loadPublicBookMetadata,
  type PublicBookMetadata,
  type PublicBookPlatformMetadata,
} from '../../lib/publicBookMetadata';
import { readHiddenReadingStatisticsSessionIds } from '../../lib/readingStatisticsSessionVisibility';

type Props = {
  book: Book;
  ownerKey: OwnerKey;
  progress?: UserProgress;
  isDownloaded: boolean;
  isOfflineMode: boolean;
  theme: ShelfTheme;
  isDeleting: boolean;
  onOpen: (book: Book) => void;
  onDelete: () => Promise<void>;
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

export const BookInfoModal: React.FC<Props> = ({
  book,
  ownerKey,
  progress,
  isDownloaded,
  isOfflineMode,
  theme,
  isDeleting,
  onOpen,
  onDelete,
  onClose,
}) => {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [metadata, setMetadata] = useState<PublicBookMetadata | null>(null);
  const [metadataState, setMetadataState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [readingTimeMs, setReadingTimeMs] = useState<number | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
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
        className={`flex max-h-[78dvh] w-[min(90vw,36rem)] min-w-0 flex-col overflow-hidden rounded-2xl border ${theme.border} ${theme.bg} ${theme.text} shadow-2xl sm:max-h-[82dvh] sm:rounded-3xl`}
      >
        <header className={`flex items-center justify-between border-b ${theme.border} px-3 py-2 sm:px-4`}>
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-500/15 text-accent-500">
              <BookOpen size={19} />
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

        <div className="min-h-0 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4 sm:py-4">
          <h3 className="break-words text-lg font-black leading-snug sm:text-xl">
            {getDisplayBookTitle(book.name)}
          </h3>
          <p className="mt-1 break-all text-[10px] leading-4 opacity-45">{book.name}</p>

          <div className="mt-3 flex flex-wrap gap-1.5">
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

          <section className={`mt-3 rounded-xl border ${theme.border} px-3 py-2.5 sm:rounded-2xl`} aria-labelledby="book-platform-metadata-title">
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
          </section>

          {confirmingDelete && (
            <div data-book-info-delete-confirmation="true" role="alert" className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs leading-5 text-red-500 sm:rounded-2xl">
              <strong className="block">이 도서를 삭제하시겠습니까?</strong>
              <span className="opacity-80">
                {sourceLabel === '기기 로컬'
                  ? '로컬 저장소에서 영구 삭제됩니다.'
                  : 'Google Drive와 기기에 저장된 사본에서 함께 삭제됩니다.'}
              </span>
            </div>
          )}
        </div>

        <footer className={`grid shrink-0 gap-1.5 border-t ${theme.border} px-3 py-2 sm:px-4 ${confirmingDelete ? 'grid-cols-2' : 'grid-cols-[1fr_auto]'}`}>
          {confirmingDelete ? (
            <>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={isDeleting}
                className={`min-h-11 rounded-xl border ${theme.border} text-xs font-bold disabled:opacity-35`}
              >
                취소
              </button>
              <button
                type="button"
                data-book-info-confirm-delete="true"
                onClick={() => void onDelete()}
                disabled={isDeleting}
                className="min-h-11 rounded-xl bg-red-500 px-4 text-xs font-bold text-white disabled:opacity-50"
              >
                {isDeleting ? '삭제 중…' : '영구 삭제'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onOpen(book)}
                className="min-h-11 rounded-xl bg-accent-600 px-4 text-xs font-bold text-white"
              >
                읽기
              </button>
              <button
                type="button"
                data-book-info-request-delete="true"
                onClick={() => setConfirmingDelete(true)}
                aria-label={`${getDisplayBookTitle(book.name)} 삭제`}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-red-400 hover:bg-red-500/10"
              >
                <Trash2 size={18} />
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
};
