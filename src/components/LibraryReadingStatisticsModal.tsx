'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Database, FileJson, Headphones, Monitor, RefreshCw, Share2 } from 'lucide-react';
import type { ThemeClasses } from '../types';
import { isGuestOwner, type OwnerKey } from '../lib/ownerIdentity';
import { formatReadingDuration, getReadingStatisticsRangeBounds, type ReadingStatisticsRange } from '../lib/readingStatistics';
import { hasPublishedBoundaryClockRisk, mergePublishedCalendarDays } from '../lib/readingRollupCalendar';
import { prepareLocalReadingReport, sumReadingReportDays } from '../lib/readingStatisticsReport';
import { createReadingStatisticsJsonExport } from '../lib/readingStatisticsExport';
import { useMyPageReadingBookTotals, useMyPageReadingCalendar, useMyPageReadingRangeBooks } from '../hooks/useMyPageList';
import {
  downloadReadingStatisticsExport,
  isReadingStatisticsShareCapabilityError,
  shareReadingStatisticsExport,
} from '../lib/readingStatisticsExportDelivery';
import { useLocalReadingReportSessions } from '../hooks/useLocalReadingReportSessions';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import { useLocalReadingDate } from '../hooks/useLocalReadingDate';
import { useBookTitleDisplay } from '../contexts/BookTitleDisplayContext';
import type { SyncHealth } from '../lib/syncHealth';
import { collectStorageMaintenanceDiagnosticsV1 } from '../lib/storageMaintenanceDiagnostics';
import {
  readReaderBootstrapTrace,
  readReaderOpenPerformanceTrace,
  readReaderResumeFailures,
} from '../lib/readerBootstrapTrace';
import { ACCENT_PALETTE } from '../lib/constants';
import { FOLIATE_RUNTIME_REVISION } from '../lib/foliateRuntimeCache';
import { MenuSheetHeader } from './MenuSheetHeader';

type Props = {
  embedded?: boolean;
  open: boolean;
  visible: boolean;
  ownerKey: OwnerKey;
  theme: ThemeClasses;
  themeVariables: React.CSSProperties;
  accentColor: string;
  syncHealth: SyncHealth;
  quarantinedDocumentCount: number;
  canRefresh: boolean;
  refreshing: boolean;
  lastServerCheckedAt: number | null;
  onRefresh: () => void;
  onClose: () => void;
};

const StatisticsPageHeader = ({ title, titleId, trailing }: React.ComponentProps<typeof MenuSheetHeader>) => (
  <header className="flex flex-wrap items-center justify-between gap-3">
    <h2 id={titleId} className="text-xl font-semibold tracking-tight">{title}</h2>
    <div className="app-menu-sheet-header-actions flex items-center gap-1">{trailing}</div>
  </header>
);
const rangeLabels: Array<{ value: ReadingStatisticsRange; label: string }> = [
  { value: 'today', label: '오늘' },
  { value: 'week', label: '이번 주' },
  { value: 'month', label: '이번 달' },
  { value: 'all', label: '전체' },
];

export const LibraryReadingStatisticsModal: React.FC<Props> = ({
  embedded = false,
  open,
  visible,
  ownerKey,
  theme,
  themeVariables,
  accentColor,
  syncHealth,
  quarantinedDocumentCount,
  canRefresh,
  refreshing,
  lastServerCheckedAt,
  onRefresh,
  onClose,
}) => {
  const Header = embedded ? StatisticsPageHeader : MenuSheetHeader;
  const sectionClass = embedded ? '' : `app-menu-sheet-section border ${theme.border}`;
  const displayBookTitle = useBookTitleDisplay();
  const [range, setRange] = useState<ReadingStatisticsRange>('week');
  const [feedback, setFeedback] = useState('');
  const [sharing, setSharing] = useState(false);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const aggregationNow = useLocalReadingDate(open && visible);
  const dialogRef = useRef<HTMLElement>(null);
  useBodyScrollLock(open && visible && !embedded);
  const accent = ACCENT_PALETTE[accentColor] || ACCENT_PALETTE.rose;
  const accentStyle = {
    '--accent-400': accent[400],
    '--accent-500': accent[500],
    '--accent-600': accent[600],
  } as React.CSSProperties;

  const canReadRollup = open && visible && !isGuestOwner(ownerKey)
    && process.env.NEXT_PUBLIC_ENABLE_READING_STATS_ROLLUP_READS === '1';
  const local = useLocalReadingReportSessions(ownerKey, open && visible, !isGuestOwner(ownerKey));
  useEffect(() => {
    if (open && visible) onRefresh();
  }, [onRefresh, open, visible]);

  const serverCheckLabel = refreshing
    ? '서버 기록 확인 중…'
    : lastServerCheckedAt !== null
      ? `마지막 서버 확인 ${new Intl.DateTimeFormat('ko-KR', {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      }).format(lastServerCheckedAt)}`
      : canRefresh
        ? '서버 기록 확인 전'
        : '이 기기의 로컬 기록';

  useEffect(() => {
    if (!open || !visible || embedded) return;
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const selector = 'button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(selector)]
        .filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const frame = window.requestAnimationFrame(() => {
      (dialog?.querySelector<HTMLElement>(selector) ?? dialog)?.focus();
    });
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handleKeyDown);
      previous?.focus();
    };
  }, [embedded, onClose, open, visible]);

  const calendarQuery = useMyPageReadingCalendar(ownerKey, canReadRollup);
  const publishedCalendar = calendarQuery.data?.calendar ?? null;
  const calendar = useMemo(() => publishedCalendar && !local?.recentOnly && !(local?.rawHistoryComplete
    && hasPublishedBoundaryClockRisk(local.sessions, publishedCalendar)) ? publishedCalendar : null,
  [local, publishedCalendar]);
  const publishedTailReady = local?.tailComplete && publishedCalendar?.firstDay === local.published?.firstDay
    && publishedCalendar?.lastDay === local.published?.lastDay;
  const waitingForHistory = !local?.recentOnly && (canReadRollup || Boolean(local?.published)) && !local?.rawHistoryComplete && !publishedTailReady;
  // Until the first local receive is complete, archived slices stand on their
  // own. A partial raw snapshot may omit the sample used at the archive seam.
  const sessions = calendar && waitingForHistory ? null : local?.sessions;
  const loading = !local && !calendar;
  const localReport = useMemo(() => prepareLocalReadingReport(sessions ?? []), [sessions]);
  const calendarDays = useMemo(() => mergePublishedCalendarDays(localReport.days, calendar), [localReport, calendar]);
  const rangeBounds = useMemo(() => getReadingStatisticsRangeBounds(range, aggregationNow), [range, aggregationNow]);
  const headlineTotals = Object.fromEntries((['today', 'week', 'month'] as const).map((value) => [
    value, sumReadingReportDays(calendarDays, getReadingStatisticsRangeBounds(value, aggregationNow)).totalMs,
  ]));

  const lifetimeQuery = useMyPageReadingBookTotals(ownerKey, Boolean(calendar?.days.length));
  const lifetimeReport = lifetimeQuery.data?.report;
  const lifetimeMatches = lifetimeReport && calendar?.firstDay === lifetimeReport.firstDay && calendar.lastDay === lifetimeReport.lastDay;
  const lifetimePending = Boolean(calendar?.days.length && lifetimeQuery.data === undefined && !lifetimeQuery.error);
  const lifetimeArchive = useMemo(() => {
    if (lifetimeMatches) return lifetimeReport;
    if (calendar && calendar.days.length === 0) return { firstDay: calendar.firstDay, lastDay: calendar.lastDay, books: [] };
    return null;
  }, [calendar, lifetimeMatches, lifetimeReport]);
  const exportDays = lifetimeArchive ? calendarDays : localReport.days;
  const calendarLastDay = calendar?.lastDay;
  const bookReportLastDay = lifetimeReport?.lastDay;
  const refreshCalendar = calendarQuery.refresh;
  const refreshLifetime = lifetimeQuery.refresh;
  const mismatchedLifetime = Boolean(lifetimeReport && calendar && !lifetimeMatches);
  useEffect(() => {
    if (!mismatchedLifetime || !calendarLastDay || !bookReportLastDay) return;
    if (bookReportLastDay <= calendarLastDay) void refreshLifetime();
    if (bookReportLastDay >= calendarLastDay) void refreshCalendar();
  }, [bookReportLastDay, calendarLastDay, mismatchedLifetime, refreshCalendar, refreshLifetime]);

  const selectedArchive = useMemo(() => {
    if (!calendar || range === 'all') return null;
    const firstDay = rangeBounds.startLocalDate && rangeBounds.startLocalDate > calendar.firstDay ? rangeBounds.startLocalDate : calendar.firstDay;
    const lastDay = rangeBounds.endLocalDate && rangeBounds.endLocalDate < calendar.lastDay ? rangeBounds.endLocalDate : calendar.lastDay;
    if (firstDay > lastDay) return null;
    return {
      firstDay, lastDay,
      hasActivity: calendar.days.some(({ localDate }) => localDate >= firstDay && localDate <= lastDay),
    };
  }, [calendar, range, rangeBounds]);
  const needsRangeBooks = Boolean(selectedArchive?.hasActivity);
  const rangeQuery = useMyPageReadingRangeBooks(ownerKey, needsRangeBooks ? selectedArchive : null);
  const missingWeek = needsRangeBooks && rangeQuery.data?.report === null;
  const localRangeFallback = missingWeek && local?.rawHistoryComplete;
  const summaryDays = range === 'all' && !waitingForHistory && !lifetimePending ? exportDays
    : localRangeFallback ? localReport.days : calendarDays;
  const summary = sumReadingReportDays(summaryDays, rangeBounds);
  const archiveReport = useMemo(() => {
    if (range === 'all') return lifetimeArchive;
    if (!selectedArchive) return null;
    if (selectedArchive.hasActivity) return rangeQuery.data?.report ?? null;
    return { firstDay: selectedArchive.firstDay, lastDay: selectedArchive.lastDay, books: [] };
  }, [lifetimeArchive, range, rangeQuery.data, selectedArchive]);
  const booksPending = range === 'all' ? lifetimePending : needsRangeBooks && !rangeQuery.error && rangeQuery.data === undefined;
  const booksUnavailable = !archiveReport && !booksPending
    && ((needsRangeBooks && !localRangeFallback) || (range === 'all' && Boolean(calendar?.days.length) && waitingForHistory));
  const books = useMemo(() => booksPending || booksUnavailable ? [] : localReport.books(rangeBounds, archiveReport),
    [archiveReport, booksPending, booksUnavailable, localReport, rangeBounds]);

  const canExport = !loading && !local?.recentOnly && !waitingForHistory && (!local?.published || Boolean(lifetimeArchive))
    && sumReadingReportDays(exportDays).totalMs > 0
    && (!canReadRollup || Boolean(calendarQuery.data || calendarQuery.error))
    && !lifetimePending;
  const buildExport = () => createReadingStatisticsJsonExport(exportDays, localReport.books({}, lifetimeArchive));
  const refresh = () => {
    onRefresh();
    if (canReadRollup) void calendarQuery.refresh();
    if (calendar?.days.length) void lifetimeQuery.refresh();
    if (needsRangeBooks) void rangeQuery.refresh();
  };
  const exportJson = () => {
    downloadReadingStatisticsExport(buildExport());
    setFeedback('JSON 통계를 저장했습니다.');
  };
  const share = async () => {
    const file = buildExport();
    setSharing(true);
    try {
      if (await shareReadingStatisticsExport(file)) {
        setFeedback('통계 파일을 공유했습니다.');
      } else {
        downloadReadingStatisticsExport(file);
        setFeedback('공유를 지원하지 않아 JSON 파일로 저장했습니다.');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (isReadingStatisticsShareCapabilityError(error)) {
        downloadReadingStatisticsExport(file);
        setFeedback('공유를 지원하지 않아 JSON 파일로 저장했습니다.');
      } else {
        console.error('[ReadingStatistics] share failed:', error);
        setFeedback('통계 파일을 공유하지 못했습니다.');
      }
    } finally {
      setSharing(false);
    }
  };
  const exportDiagnostics = async () => {
    setExportingDiagnostics(true);
    try {
      const diagnostics = await collectStorageMaintenanceDiagnosticsV1(ownerKey);
      const readerBootstrapTrace = readReaderBootstrapTrace();
      const readerOpenPerformanceTrace = readReaderOpenPerformanceTrace();
      const readerResumeFailures = readReaderResumeFailures();
      const date = new Date(diagnostics.collectedAt).toISOString().slice(0, 10);
      downloadReadingStatisticsExport({
        filename: `web-reader-storage-diagnostics-${date}.json`,
        mimeType: 'application/json;charset=utf-8',
        text: `${JSON.stringify({
          ...diagnostics,
          appBuild: FOLIATE_RUNTIME_REVISION,
          ...(readerBootstrapTrace.length > 0 ? { readerBootstrapTrace } : {}),
          ...(readerOpenPerformanceTrace.length > 0 ? { readerOpenPerformanceTrace } : {}),
          ...(readerResumeFailures.length > 0 ? { readerResumeFailures } : {}),
        }, null, 2)}\n`,
      });
      setFeedback('저장소 진단 JSON을 저장했습니다. 원문과 메모는 포함되지 않습니다.');
    } catch (error) {
      console.error('[ReadingStatistics] diagnostics export failed:', error);
      setFeedback('저장소 진단 정보를 만들지 못했습니다.');
    } finally {
      setExportingDiagnostics(false);
    }
  };

  if (!open) return null;
  return (
    <div
      data-menu-sheet-backdrop={embedded ? undefined : 'true'}
      className={embedded ? 'min-w-0' : `app-menu-sheet-backdrop fixed inset-0 z-[105] ${visible ? 'flex' : 'hidden'} items-center justify-center bg-black/65 p-2 backdrop-blur-sm sm:p-5`}
      onClick={embedded ? undefined : onClose}
    >
      <section
        ref={dialogRef}
        role={embedded ? 'region' : 'dialog'}
        aria-modal={embedded ? undefined : true}
        aria-labelledby="reading-statistics-title"
        tabIndex={-1}
        data-reading-statistics-modal={embedded ? undefined : 'true'}
        data-menu-sheet={embedded ? undefined : 'true'}
        data-reading-statistics-accent={accentColor}
        style={{ ...themeVariables, ...accentStyle }}
        onClick={(event) => event.stopPropagation()}
        className={embedded
          ? 'flex min-w-0 flex-col'
          : `app-panel-radius app-menu-sheet flex max-h-[78dvh] w-[min(90vw,36rem)] min-w-0 flex-col overflow-hidden border ${theme.border} ${theme.bg} ${theme.text} shadow-2xl sm:max-h-[82dvh]`}
      >
        <Header
          title="독서 통계"
          kind="statistics"
          titleId="reading-statistics-title"
          onClose={onClose}
          borderClass={theme.border}
          secondaryClass={theme.secondary}
          trailing={(
            <>
            <button type="button" data-reading-statistics-export="json" onClick={exportJson} disabled={!canExport} aria-label="독서 통계 JSON 저장" title="독서 통계 JSON 저장" className="app-menu-header-action">
              <FileJson size={16} />
            </button>
            <button type="button" data-reading-statistics-share="true" onClick={() => void share()} disabled={sharing || !canExport} aria-label={sharing ? '독서 통계 공유 중' : '독서 통계 공유'} title={sharing ? '독서 통계 공유 중' : '독서 통계 JSON 공유'} aria-busy={sharing} className="app-menu-header-action">
              <Share2 size={16} />
            </button>
            <button type="button" data-reading-statistics-diagnostics="true" onClick={() => void exportDiagnostics()} disabled={exportingDiagnostics} aria-label={exportingDiagnostics ? '진단 JSON 생성 중' : '진단 JSON 저장'} title={exportingDiagnostics ? '진단 JSON 생성 중' : '진단 JSON 저장'} aria-busy={exportingDiagnostics} className="app-menu-header-action">
              <Database size={16} />
            </button>
            <button
              type="button"
              data-reading-statistics-refresh="true"
              onClick={refresh}
              disabled={!canRefresh || refreshing}
              aria-label="독서 통계 새로고침"
              title={`서버에 올라온 독서 기록 다시 확인 · ${serverCheckLabel}`}
              aria-busy={refreshing}
              className="app-menu-header-action"
            >
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            </button>
            </>
          )}
        />

        <div data-reading-statistics-body="true" className={embedded ? 'mt-5 min-w-0' : 'min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-2.5 sm:px-4 sm:py-3'}>
          {local?.error && <p role="status" className="mb-3 text-center text-xs opacity-70">이 기기의 독서 기록을 불러오지 못했습니다.</p>}
          {local?.recentOnly && <p role="status" className="mb-3 text-xs opacity-70">확인된 독서 기록만 표시합니다. 전체 기록을 받으면 JSON을 저장할 수 있습니다.</p>}
          {waitingForHistory && calendar && <p role="status" className="mb-3 text-xs opacity-70">동기화를 마치면 최근 기록을 합산하고 JSON으로 저장할 수 있습니다.</p>}
          {feedback && <p role="status" className="mb-3 text-center text-xs font-bold opacity-70">{feedback}</p>}
          {(syncHealth !== 'healthy' || quarantinedDocumentCount > 0) && (
            <div role="status" className="mb-3 rounded-2xl border border-amber-500/35 bg-amber-500/10 px-3 py-2.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
              {syncHealth === 'retrying-receive'
                ? '독서 통계 동기화를 다시 시도하고 있습니다.'
                : syncHealth === 'paused-auth'
                  ? '로그인을 다시 확인하면 독서 통계 동기화를 계속할 수 있습니다.'
                  : syncHealth === 'blocked-permission'
                    ? '독서 통계에 대한 클라우드 권한을 확인해 주세요.'
                    : syncHealth === 'blocked-schema'
                      ? '독서 통계 데이터 형식을 확인해야 합니다.'
                      : null}
              {quarantinedDocumentCount > 0 && (
                <span className="block font-bold">
                  손상된 원격 기록 {quarantinedDocumentCount}개는 제외하고 나머지 통계를 불러왔습니다.
                </span>
              )}
            </div>
          )}
          {loading ? (
            <p role="status" className="py-16 text-center text-sm opacity-50">통계를 불러오는 중...</p>
          ) : (
            <>
              <div className={embedded ? 'grid grid-cols-3 gap-3 sm:gap-6' : 'grid grid-cols-3 gap-1.5'}>
                {(['today', 'week', 'month'] as const).map((value) => (
                  <div key={value} data-reading-statistics-headline={value} className={`min-w-0 ${embedded ? '' : `${sectionClass} rounded-xl px-2 py-1.5 sm:rounded-2xl sm:px-2.5 sm:py-2`}`}>
                    <div className={embedded ? 'text-xs opacity-60' : 'text-[10px] font-bold opacity-50'}>{rangeLabels.find((item) => item.value === value)?.label}</div>
                    <div className={embedded ? 'mt-1.5 text-base font-semibold tabular-nums sm:text-xl' : 'mt-0.5 truncate text-xs font-black sm:text-base'}>{formatReadingDuration(headlineTotals[value])}</div>
                  </div>
                ))}
              </div>

              <div className={`flex overflow-x-auto ${embedded ? 'mt-6 w-fit max-w-full gap-1' : `${sectionClass} mt-2.5 gap-0.5 rounded-xl p-0.5 sm:rounded-2xl`}`}>
                {rangeLabels.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    data-reading-statistics-range={item.value}
                    onClick={() => setRange(item.value)}
                    aria-pressed={range === item.value}
                    className={`min-h-8 min-w-[3.75rem] flex-1 rounded-lg px-2 text-[11px] font-bold sm:min-h-9 sm:rounded-xl sm:text-xs ${range === item.value ? (embedded ? 'text-accent-500' : 'bg-accent-600 text-white') : 'opacity-60 hover:opacity-100'}`}
                  >
                    {local?.recentOnly && item.value === 'all' ? '확인된 기록' : item.label}
                  </button>
                ))}
              </div>

              <div className={embedded ? 'mt-5 grid grid-cols-2 gap-3 sm:gap-6' : 'mt-2.5 grid grid-cols-2 gap-1.5'}>
                <div className={embedded ? '' : `${sectionClass} rounded-xl px-2.5 py-2 sm:rounded-2xl`}>
                  <div className="flex items-center gap-1.5 text-[11px] font-bold opacity-60"><Monitor size={14} /> 화면 독서</div>
                  <div data-reading-statistics-mode-total="screen" className="mt-0.5 text-sm font-black">{formatReadingDuration(summary.screenMs)}</div>
                </div>
                <div className={embedded ? '' : `${sectionClass} rounded-xl px-2.5 py-2 sm:rounded-2xl`}>
                  <div className="flex items-center gap-1.5 text-[11px] font-bold opacity-60"><Headphones size={14} /> TTS 듣기</div>
                  <div data-reading-statistics-mode-total="tts" className="mt-0.5 text-sm font-black">{formatReadingDuration(summary.ttsMs)}</div>
                </div>
              </div>

              <h3 className={embedded ? 'mt-8 text-base font-semibold' : 'mt-3 text-xs font-black sm:text-sm'}>도서별 기록</h3>
              <div className={`mt-2 grid min-w-0 ${embedded ? 'mypage-divided-list' : 'gap-1.5'}`}>
                {booksPending || booksUnavailable ? (
                  <p role="status" className="py-4 text-sm opacity-60">
                    {booksPending ? '도서별 기록을 불러오는 중…' : '도서별 집계를 불러오지 못했습니다.'}
                  </p>
                ) : books.length === 0 ? (
                  <div className={`text-sm opacity-60 ${embedded ? 'py-4' : `${sectionClass} rounded-2xl py-12 text-center`}`}>아직 기록된 독서 시간이 없습니다.</div>
                ) : books.map((book) => (
                  <article
                    key={book.bookId}
                    data-reading-statistics-book="true"
                    data-reading-statistics-book-id={book.bookId}
                    className={`min-w-0 ${embedded ? 'mypage-book-list-item' : `${sectionClass} overflow-hidden rounded-xl px-2.5 py-2`}`}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <h4 className="truncate text-xs font-bold sm:text-sm">{displayBookTitle(book.bookTitle)}</h4>
                      <strong data-reading-statistics-book-duration="true" className="shrink-0 text-xs text-accent-500 sm:text-sm">{formatReadingDuration(book.screenMs + book.ttsMs)}</strong>
                    </div>
                    <div className="mt-1 flex min-w-0 gap-2 text-[10px] opacity-55">
                      <span>화면 {formatReadingDuration(book.screenMs)}</span>
                      <span>TTS {formatReadingDuration(book.ttsMs)}</span>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>

      </section>
    </div>
  );
};
