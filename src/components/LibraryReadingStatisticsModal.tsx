'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Database, Download, FileJson, FileText, Headphones, Monitor, RefreshCw, Share2, X } from 'lucide-react';
import type { ThemeClasses } from '../types';
import type { OwnerKey } from '../lib/ownerIdentity';
import {
  confirmLocalReadingRoundV11,
  getLocalReadingSessionsV11,
} from '../lib/localReadingStatistics';
import {
  buildReadingStatistics,
  buildReadingBookRounds,
  formatReadingDuration,
  getReadingStatisticsRangeBounds,
  sortReadingBookRoundsByRecent,
  type ReadingStatisticsRange,
  type StoredReadingSessionV11,
} from '../lib/readingStatistics';
import {
  createReadingStatisticsJsonExport,
  createReadingStatisticsMarkdownExport,
} from '../lib/readingStatisticsExport';
import {
  downloadReadingStatisticsExport,
  isReadingStatisticsShareCapabilityError,
  shareReadingStatisticsExport,
} from '../lib/readingStatisticsExportDelivery';
import {
  notifyReadingStatisticsChange,
  subscribeReadingStatisticsChanges,
} from '../lib/readingStatisticsWake';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import type { SyncHealth } from '../lib/syncHealth';
import { collectStorageMaintenanceDiagnosticsV1 } from '../lib/storageMaintenanceDiagnostics';
import { readReaderBootstrapTrace } from '../lib/readerBootstrapTrace';
import { ACCENT_PALETTE } from '../lib/constants';
import { ConfirmDialog } from './ConfirmDialog';
import {
  READING_STATISTICS_HIDDEN_SESSIONS_STORAGE_KEY,
  hideReadingStatisticsRound,
  readHiddenReadingStatisticsSessionIds,
} from '../lib/readingStatisticsSessionVisibility';

type Props = {
  open: boolean;
  visible: boolean;
  ownerKey: OwnerKey;
  theme: ThemeClasses;
  accentColor: string;
  syncHealth: SyncHealth;
  quarantinedDocumentCount: number;
  canRefresh: boolean;
  refreshing: boolean;
  lastServerCheckedAt: number | null;
  onRefresh: () => void;
  onClose: () => void;
};

type BookListFilter = 'all' | 'current' | 'completed';
type PendingBookListDeletion = {
  bookId: string;
  bookTitle: string;
  roundNumber: number;
  sourceSessionIds: string[];
};

const rangeLabels: Array<{ value: ReadingStatisticsRange; label: string }> = [
  { value: 'today', label: '오늘' },
  { value: 'week', label: '이번 주' },
  { value: 'month', label: '이번 달' },
  { value: 'all', label: '전체' },
];

export const LibraryReadingStatisticsModal: React.FC<Props> = ({
  open,
  visible,
  ownerKey,
  theme,
  accentColor,
  syncHealth,
  quarantinedDocumentCount,
  canRefresh,
  refreshing,
  lastServerCheckedAt,
  onRefresh,
  onClose,
}) => {
  const [sessions, setSessions] = useState<StoredReadingSessionV11[]>([]);
  const [range, setRange] = useState<ReadingStatisticsRange>('week');
  const [bookListFilter, setBookListFilter] = useState<BookListFilter>('all');
  const [expandedCompletionRows, setExpandedCompletionRows] = useState<Set<string>>(
    () => new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState('');
  const [sharing, setSharing] = useState(false);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [completingRoundKey, setCompletingRoundKey] = useState<string | null>(null);
  const [hiddenSessionIds, setHiddenSessionIds] = useState<Set<string>>(() => new Set());
  const [pendingBookListDeletion, setPendingBookListDeletion] = useState<PendingBookListDeletion | null>(null);
  const [aggregationNow, setAggregationNow] = useState(() => Date.now());
  const dialogRef = useRef<HTMLElement>(null);
  const reloadTimerRef = useRef<number | null>(null);
  const bookListLongPressTimerRef = useRef<number | null>(null);
  const bookListLongPressStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  useBodyScrollLock(open && visible);
  const accent = ACCENT_PALETTE[accentColor] || ACCENT_PALETTE.indigo;
  const accentStyle = {
    '--accent-400': accent[400],
    '--accent-500': accent[500],
    '--accent-600': accent[600],
  } as React.CSSProperties;

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      setSessions(await getLocalReadingSessionsV11(ownerKey));
      setHiddenSessionIds(readHiddenReadingStatisticsSessionIds(ownerKey));
      setAggregationNow(Date.now());
    } catch (error) {
      console.error('[ReadingStatistics] load failed:', error);
      setFeedback('독서 통계를 불러오지 못했습니다.');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [ownerKey]);

  useEffect(() => {
    if (!open || !visible) return;
    void reload(true);
    onRefresh();
    const unsubscribe = subscribeReadingStatisticsChanges(ownerKey, () => {
      if (reloadTimerRef.current !== null) window.clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = window.setTimeout(() => {
        reloadTimerRef.current = null;
        void reload();
      }, 250);
    });
    return () => {
      unsubscribe();
      if (reloadTimerRef.current !== null) window.clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = null;
    };
  }, [onRefresh, open, ownerKey, reload, visible]);

  useEffect(() => {
    if (!open || !visible) return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key === READING_STATISTICS_HIDDEN_SESSIONS_STORAGE_KEY) {
        setHiddenSessionIds(readHiddenReadingStatisticsSessionIds(ownerKey));
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [open, ownerKey, visible]);

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
    if (!open || !visible) return;
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const selector = 'button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (pendingBookListDeletion) setPendingBookListDeletion(null);
        else onClose();
        return;
      }
      if (pendingBookListDeletion) return;
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
  }, [onClose, open, pendingBookListDeletion, visible]);

  const visibleSessions = useMemo(() => sessions.filter(({ sessionId }) => (
    !hiddenSessionIds.has(sessionId)
  )), [hiddenSessionIds, sessions]);
  const allSummary = useMemo(() => buildReadingStatistics(
    visibleSessions,
    getReadingStatisticsRangeBounds('all', aggregationNow),
  ), [aggregationNow, visibleSessions]);
  const summary = useMemo(() => range === 'all'
    ? allSummary
    : buildReadingStatistics(
      visibleSessions,
      getReadingStatisticsRangeBounds(range, aggregationNow),
    ), [aggregationNow, allSummary, range, visibleSessions]);
  const headlineTotals = useMemo(() => Object.fromEntries(
    (['today', 'week', 'month'] as const).map((value) => {
      const bounds = getReadingStatisticsRangeBounds(value, aggregationNow);
      return [value, allSummary.days.reduce((total, day) => (
        (!bounds.startLocalDate || day.localDate >= bounds.startLocalDate)
        && (!bounds.endLocalDate || day.localDate <= bounds.endLocalDate)
          ? total + day.totalMs
          : total
      ), 0)];
    }),
  ) as Record<'today' | 'week' | 'month', number>, [aggregationNow, allSummary.days]);
  const bookRounds = useMemo(() => buildReadingBookRounds(
    sessions,
    getReadingStatisticsRangeBounds(range, aggregationNow),
    hiddenSessionIds,
  ), [aggregationNow, hiddenSessionIds, range, sessions]);
  const listedBookRounds = useMemo(
    () => sortReadingBookRoundsByRecent(bookRounds),
    [bookRounds],
  );
  const bookStatusSummary = useMemo(() => {
    const latestRoundByBook = new Map<string, (typeof listedBookRounds)[number]>();
    for (const round of listedBookRounds) {
      const latest = latestRoundByBook.get(round.bookId);
      if (!latest || round.roundNumber > latest.roundNumber) {
        latestRoundByBook.set(round.bookId, round);
      }
    }
    const latestRounds = [...latestRoundByBook.values()];
    return {
      currentCount: latestRounds.filter(({ completed }) => !completed).length,
      completedCount: latestRounds.filter(({ completed }) => completed).length,
    };
  }, [listedBookRounds]);
  const visibleBookRounds = useMemo(() => listedBookRounds.filter((book) => (
    bookListFilter === 'all'
    || (bookListFilter === 'completed' ? book.completed : !book.completed)
  )), [bookListFilter, listedBookRounds]);
  const formatReadingDate = (localDate: string) => {
    const [year, month, day] = localDate.split('-').map(Number);
    return `${year}. ${month}. ${day}.`;
  };
  const confirmRound = async (bookId: string, roundNumber: number, rowKey: string) => {
    setCompletingRoundKey(rowKey);
    setFeedback('');
    try {
      const result = await confirmLocalReadingRoundV11(ownerKey, bookId, roundNumber);
      if (result.status === 'created') {
        setFeedback(`${roundNumber}회차를 완료했습니다.`);
      } else if (result.status === 'already-completed') {
        setFeedback('이미 완료된 회차입니다.');
      } else if (result.status === 'not-eligible') {
        setFeedback('진행률 99%부터 완료할 수 있습니다.');
      } else {
        setFeedback('최신 회차가 바뀌었습니다. 목록을 다시 확인해 주세요.');
      }
      await reload();
    } catch (error) {
      console.error('[ReadingStatistics] round completion failed:', error);
      setFeedback('회차를 완료하지 못했습니다.');
    } finally {
      setCompletingRoundKey(null);
    }
  };

  const clearBookListLongPress = useCallback(() => {
    if (bookListLongPressTimerRef.current !== null) {
      window.clearTimeout(bookListLongPressTimerRef.current);
    }
    bookListLongPressTimerRef.current = null;
    bookListLongPressStartRef.current = null;
  }, []);

  const startBookListLongPress = useCallback((
    event: React.PointerEvent<HTMLElement>,
    book: PendingBookListDeletion,
  ) => {
    if (
      (event.pointerType === 'mouse' && event.button !== 0)
      || (event.target instanceof Element && event.target.closest('button,a,input'))
    ) return;
    clearBookListLongPress();
    bookListLongPressStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    bookListLongPressTimerRef.current = window.setTimeout(() => {
      bookListLongPressTimerRef.current = null;
      bookListLongPressStartRef.current = null;
      setPendingBookListDeletion(book);
    }, 650);
  }, [clearBookListLongPress]);

  const moveBookListLongPress = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const start = bookListLongPressStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) {
      clearBookListLongPress();
    }
  }, [clearBookListLongPress]);

  useEffect(() => () => clearBookListLongPress(), [clearBookListLongPress]);

  const confirmBookListDeletion = useCallback(() => {
    if (!pendingBookListDeletion) return;
    if (!hideReadingStatisticsRound(
      ownerKey,
      pendingBookListDeletion.bookId,
      pendingBookListDeletion.roundNumber,
      pendingBookListDeletion.sourceSessionIds,
    )) {
      setFeedback('회차 기록을 목록에서 삭제하지 못했습니다.');
      return;
    }
    setHiddenSessionIds((current) => new Set([
      ...current,
      ...pendingBookListDeletion.sourceSessionIds,
    ]));
    setExpandedCompletionRows((current) => {
      const next = new Set(current);
      next.delete(`${pendingBookListDeletion.bookId}:${pendingBookListDeletion.roundNumber}`);
      return next;
    });
    setFeedback(`${pendingBookListDeletion.roundNumber}회차 기록을 통계에서 숨겼습니다. 해당 시간은 표시 합계에서 제외됩니다.`);
    setPendingBookListDeletion(null);
    notifyReadingStatisticsChange(ownerKey);
  }, [ownerKey, pendingBookListDeletion]);

  const exportMarkdown = () => {
    downloadReadingStatisticsExport(createReadingStatisticsMarkdownExport(visibleSessions));
    setFeedback('Markdown 통계를 저장했습니다.');
  };
  const exportJson = () => {
    downloadReadingStatisticsExport(createReadingStatisticsJsonExport(visibleSessions));
    setFeedback('JSON 통계를 저장했습니다.');
  };
  const share = async () => {
    setSharing(true);
    try {
      const shared = await shareReadingStatisticsExport(
        createReadingStatisticsMarkdownExport(visibleSessions),
      );
      if (!shared) {
        downloadReadingStatisticsExport(createReadingStatisticsMarkdownExport(visibleSessions));
        setFeedback('공유를 지원하지 않아 Markdown 파일로 저장했습니다.');
      } else {
        setFeedback('통계 파일을 공유했습니다.');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (isReadingStatisticsShareCapabilityError(error)) {
        downloadReadingStatisticsExport(createReadingStatisticsMarkdownExport(visibleSessions));
        setFeedback('공유를 지원하지 않아 Markdown 파일로 저장했습니다.');
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
      const date = new Date(diagnostics.collectedAt).toISOString().slice(0, 10);
      downloadReadingStatisticsExport({
        filename: `web-reader-storage-diagnostics-${date}.json`,
        mimeType: 'application/json;charset=utf-8',
        text: `${JSON.stringify({
          ...diagnostics,
          ...(readerBootstrapTrace.length > 0 ? { readerBootstrapTrace } : {}),
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
    <>
    <div
      className={`fixed inset-0 z-[105] ${visible ? 'flex' : 'hidden'} items-center justify-center bg-black/65 p-2 backdrop-blur-sm sm:p-5`}
      onClick={onClose}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reading-statistics-title"
        tabIndex={-1}
        data-reading-statistics-modal="true"
        data-reading-statistics-accent={accentColor}
        style={accentStyle}
        onClick={(event) => event.stopPropagation()}
        className={`flex max-h-[78dvh] w-[min(90vw,36rem)] min-w-0 flex-col overflow-hidden rounded-2xl border ${theme.border} ${theme.bg} ${theme.text} shadow-2xl sm:max-h-[82dvh] sm:rounded-3xl`}
      >
        <header className={`flex items-center justify-between border-b ${theme.border} px-3 py-2 sm:px-4`}>
          <div className="min-w-0">
            <h2 id="reading-statistics-title" className="text-base font-black sm:text-lg">독서 통계</h2>
            <p aria-live="polite" className="mt-0.5 text-[11px] opacity-55">{serverCheckLabel}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              data-reading-statistics-refresh="true"
              onClick={onRefresh}
              disabled={!canRefresh || refreshing}
              aria-label="독서 통계 새로고침"
              title="서버에 올라온 독서 기록 다시 확인"
              className="flex h-11 w-11 items-center justify-center rounded-full text-accent-500 hover:bg-accent-500/10 disabled:opacity-35"
            >
              <RefreshCw size={20} className={refreshing ? 'animate-spin' : ''} />
            </button>
            <button type="button" onClick={onClose} aria-label="독서 통계 닫기" className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10">
              <X size={22} />
            </button>
          </div>
        </header>

        <div data-reading-statistics-body="true" className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-2.5 sm:px-4 sm:py-3">
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
              <div className="grid grid-cols-3 gap-1.5">
                {(['today', 'week', 'month'] as const).map((value) => (
                  <div key={value} data-reading-statistics-headline={value} className={`min-w-0 rounded-xl border ${theme.border} px-2 py-1.5 sm:rounded-2xl sm:px-2.5 sm:py-2`}>
                    <div className="text-[10px] font-bold opacity-50">{rangeLabels.find((item) => item.value === value)?.label}</div>
                    <div className="mt-0.5 truncate text-xs font-black text-accent-500 sm:text-base">{formatReadingDuration(headlineTotals[value])}</div>
                  </div>
                ))}
              </div>

              <div className={`mt-2.5 flex gap-0.5 overflow-x-auto rounded-xl border ${theme.border} p-0.5 sm:rounded-2xl`}>
                {rangeLabels.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    data-reading-statistics-range={item.value}
                    onClick={() => setRange(item.value)}
                    aria-pressed={range === item.value}
                    className={`min-h-10 min-w-[3.75rem] flex-1 rounded-lg px-2 text-[11px] font-bold sm:rounded-xl sm:text-xs ${range === item.value ? 'bg-accent-600 text-white' : 'opacity-60 hover:opacity-100'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="mt-2.5 grid grid-cols-2 gap-1.5">
                <div className={`rounded-xl border ${theme.border} px-2.5 py-2 sm:rounded-2xl`}>
                  <div className="flex items-center gap-1.5 text-[11px] font-bold opacity-60"><Monitor size={14} /> 화면 독서</div>
                  <div data-reading-statistics-mode-total="screen" className="mt-0.5 text-sm font-black text-accent-500">{formatReadingDuration(summary.screenMs)}</div>
                </div>
                <div className={`rounded-xl border ${theme.border} px-2.5 py-2 sm:rounded-2xl`}>
                  <div className="flex items-center gap-1.5 text-[11px] font-bold opacity-60"><Headphones size={14} /> TTS 듣기</div>
                  <div data-reading-statistics-mode-total="tts" className="mt-0.5 text-sm font-black text-accent-500">{formatReadingDuration(summary.ttsMs)}</div>
                </div>
              </div>

              <div className="mt-3 flex items-end justify-between gap-2">
                <div>
                  <h3 className="text-xs font-black sm:text-sm">도서별 기록</h3>
                  <p data-reading-statistics-book-summary="true" className="text-[10px] opacity-50">
                    {bookStatusSummary.currentCount}권 읽는 중 · 완료 {bookStatusSummary.completedCount}권
                  </p>
                </div>
                <div data-reading-statistics-book-filter="true" className="flex shrink-0 items-center text-[11px] font-bold opacity-55">
                  {(['all', 'current', 'completed'] as const).map((value, index) => (
                    <React.Fragment key={value}>
                      {index > 0 && <span aria-hidden="true" className="px-1 opacity-35">|</span>}
                      <button
                        type="button"
                        onClick={() => setBookListFilter(value)}
                        aria-pressed={bookListFilter === value}
                        className={bookListFilter === value ? 'text-accent-500 opacity-100' : 'hover:opacity-100'}
                      >
                        {value === 'all' ? '전체' : value === 'current' ? '현재' : '완료'}
                      </button>
                    </React.Fragment>
                  ))}
                </div>
              </div>

              <div className="mt-2 min-w-0 grid gap-1.5">
                {visibleBookRounds.length === 0 ? (
                  <div className={`rounded-2xl border ${theme.border} py-12 text-center text-sm opacity-45`}>아직 기록된 독서 시간이 없습니다.</div>
                ) : visibleBookRounds.map((book) => {
                  const rowKey = `${book.bookId}:${book.roundNumber}`;
                  const completionExpanded = expandedCompletionRows.has(rowKey);
                  return (
                  <article
                    key={rowKey}
                    data-reading-statistics-book="true"
                    data-reading-statistics-book-id={book.bookId}
                    data-reading-statistics-round={book.roundNumber}
                    title="길게 눌러 이 회차를 통계 목록에서 삭제"
                    onPointerDown={(event) => startBookListLongPress(event, {
                      bookId: book.bookId,
                      bookTitle: book.bookTitle,
                      roundNumber: book.roundNumber,
                      sourceSessionIds: book.sourceSessionIds,
                    })}
                    onPointerMove={moveBookListLongPress}
                    onPointerUp={clearBookListLongPress}
                    onPointerCancel={clearBookListLongPress}
                    onPointerLeave={clearBookListLongPress}
                    onContextMenu={(event) => {
                      if (event.target instanceof Element && event.target.closest('button,a,input')) return;
                      event.preventDefault();
                      setPendingBookListDeletion({
                        bookId: book.bookId,
                        bookTitle: book.bookTitle,
                        roundNumber: book.roundNumber,
                        sourceSessionIds: book.sourceSessionIds,
                      });
                    }}
                    className={`min-w-0 touch-manipulation select-none overflow-hidden rounded-xl border ${theme.border} px-2.5 py-2`}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h4 className="truncate text-xs font-bold sm:text-sm">{book.bookTitle} · {book.roundNumber}회차</h4>
                        <p className="mt-0.5 truncate text-[10px] opacity-50">시작 {formatReadingDate(book.startedLocalDate)} · {book.endProgressPercent.toFixed(1)}%</p>
                        {completionExpanded && book.completedLocalDate && (
                          <p data-reading-statistics-completion-dates="true" className="mt-1 text-[10px] font-bold text-accent-500/80">
                            시작 {formatReadingDate(book.startedLocalDate)} · 종료 {formatReadingDate(book.completedLocalDate)}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end">
                        <strong className="text-xs text-accent-500 sm:text-sm">{formatReadingDuration(book.totalMs)}</strong>
                        {book.completed ? (
                          <button
                            type="button"
                            data-reading-statistics-complete="true"
                            aria-expanded={completionExpanded}
                            aria-label={`${book.bookTitle} ${book.roundNumber}회차 시작일과 종료일`}
                            onClick={() => setExpandedCompletionRows((current) => {
                              const next = new Set(current);
                              if (next.has(rowKey)) next.delete(rowKey);
                              else next.add(rowKey);
                              return next;
                            })}
                            className="mt-0.5 rounded-md bg-accent-500/10 px-1.5 py-0.5 text-xs font-bold text-accent-500 hover:bg-accent-500/20 sm:text-sm"
                          >
                            완료됨
                          </button>
                        ) : book.canComplete ? (
                          <button
                            type="button"
                            data-reading-statistics-confirm-complete="true"
                            disabled={completingRoundKey !== null}
                            aria-label={`${book.bookTitle} ${book.roundNumber}회차 완료 처리`}
                            onClick={() => void confirmRound(
                              book.bookId,
                              book.roundNumber,
                              rowKey,
                            )}
                            className="mt-0.5 rounded-md bg-accent-500/10 px-1.5 py-0.5 text-xs font-bold text-accent-500 hover:bg-accent-500/20 disabled:opacity-30 sm:text-sm"
                          >
                            {completingRoundKey === rowKey ? '처리 중' : '완료하기'}
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-1 flex min-w-0 gap-2 text-[10px] opacity-55">
                      <span>화면 {formatReadingDuration(book.screenMs)}</span>
                      <span>TTS {formatReadingDuration(book.ttsMs)}</span>
                    </div>
                  </article>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <footer className={`border-t ${theme.border} px-3 py-2 sm:px-4`}>
          {feedback && <p role="status" className="mb-2 text-center text-xs font-bold text-accent-500">{feedback}</p>}
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <button type="button" data-reading-statistics-export="markdown" onClick={exportMarkdown} disabled={visibleSessions.length === 0} className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl border ${theme.border} text-xs font-bold text-accent-500 hover:bg-accent-500/10 disabled:opacity-30`}>
              <FileText size={15} /><Download size={13} /> MD
            </button>
            <button type="button" data-reading-statistics-export="json" onClick={exportJson} disabled={visibleSessions.length === 0} className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl border ${theme.border} text-xs font-bold text-accent-500 hover:bg-accent-500/10 disabled:opacity-30`}>
              <FileJson size={15} /><Download size={13} /> JSON
            </button>
            <button type="button" data-reading-statistics-share="true" onClick={() => void share()} disabled={sharing || visibleSessions.length === 0} className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-accent-600 text-xs font-bold text-white disabled:opacity-30">
              <Share2 size={15} /> 공유
            </button>
            <button type="button" data-reading-statistics-diagnostics="true" onClick={() => void exportDiagnostics()} disabled={exportingDiagnostics} className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl border ${theme.border} text-xs font-bold text-accent-500 hover:bg-accent-500/10 disabled:opacity-30`}>
              <Database size={15} /><Download size={13} /> 진단
            </button>
          </div>
        </footer>
      </section>
    </div>
    {pendingBookListDeletion && (
      <ConfirmDialog
        message={`“${pendingBookListDeletion.bookTitle}” ${pendingBookListDeletion.roundNumber}회차를 목록에서 삭제할까요?`}
        subMessage="선택한 회차의 세션만 통계에서 숨깁니다. 같은 책의 다른 회차와 원본 세션은 유지되며, 표시되는 독서 합계에서는 제외됩니다."
        confirmLabel="목록에서 삭제"
        theme={theme}
        onConfirm={confirmBookListDeletion}
        onCancel={() => setPendingBookListDeletion(null)}
      />
    )}
    </>
  );
};
