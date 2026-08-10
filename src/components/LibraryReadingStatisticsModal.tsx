'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Database, Download, FileJson, FileText, Headphones, Monitor, Share2, X } from 'lucide-react';
import type { ThemeClasses } from '../types';
import type { OwnerKey } from '../lib/ownerIdentity';
import { getLocalReadingSessionsV11 } from '../lib/localReadingStatistics';
import {
  buildReadingStatistics,
  formatReadingDuration,
  getReadingStatisticsRangeBounds,
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
import { subscribeReadingStatisticsChanges } from '../lib/readingStatisticsWake';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import type { SyncHealth } from '../lib/syncHealth';
import { collectStorageMaintenanceDiagnosticsV1 } from '../lib/storageMaintenanceDiagnostics';

type Props = {
  open: boolean;
  visible: boolean;
  ownerKey: OwnerKey;
  theme: ThemeClasses;
  syncHealth: SyncHealth;
  quarantinedDocumentCount: number;
  onClose: () => void;
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
  syncHealth,
  quarantinedDocumentCount,
  onClose,
}) => {
  const [sessions, setSessions] = useState<StoredReadingSessionV11[]>([]);
  const [range, setRange] = useState<ReadingStatisticsRange>('week');
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState('');
  const [sharing, setSharing] = useState(false);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [aggregationNow, setAggregationNow] = useState(() => Date.now());
  const dialogRef = useRef<HTMLElement>(null);
  const reloadTimerRef = useRef<number | null>(null);
  useBodyScrollLock(open && visible);

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      setSessions(await getLocalReadingSessionsV11(ownerKey));
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
  }, [open, ownerKey, reload, visible]);

  useEffect(() => {
    if (!open || !visible) return;
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
  }, [onClose, open, visible]);

  const allSummary = useMemo(() => buildReadingStatistics(
    sessions,
    getReadingStatisticsRangeBounds('all', aggregationNow),
  ), [aggregationNow, sessions]);
  const summary = useMemo(() => range === 'all'
    ? allSummary
    : buildReadingStatistics(
      sessions,
      getReadingStatisticsRangeBounds(range, aggregationNow),
    ), [aggregationNow, allSummary, range, sessions]);
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

  const exportMarkdown = () => {
    downloadReadingStatisticsExport(createReadingStatisticsMarkdownExport(sessions));
    setFeedback('Markdown 통계를 저장했습니다.');
  };
  const exportJson = () => {
    downloadReadingStatisticsExport(createReadingStatisticsJsonExport(sessions));
    setFeedback('JSON 통계를 저장했습니다.');
  };
  const share = async () => {
    setSharing(true);
    try {
      const shared = await shareReadingStatisticsExport(
        createReadingStatisticsMarkdownExport(sessions),
      );
      if (!shared) {
        downloadReadingStatisticsExport(createReadingStatisticsMarkdownExport(sessions));
        setFeedback('공유를 지원하지 않아 Markdown 파일로 저장했습니다.');
      } else {
        setFeedback('통계 파일을 공유했습니다.');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (isReadingStatisticsShareCapabilityError(error)) {
        downloadReadingStatisticsExport(createReadingStatisticsMarkdownExport(sessions));
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
      const date = new Date(diagnostics.collectedAt).toISOString().slice(0, 10);
      downloadReadingStatisticsExport({
        filename: `web-reader-storage-diagnostics-${date}.json`,
        mimeType: 'application/json;charset=utf-8',
        text: `${JSON.stringify(diagnostics, null, 2)}\n`,
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
      className={`fixed inset-0 z-[105] ${visible ? 'flex' : 'hidden'} items-center justify-center bg-black/65 p-3 backdrop-blur-sm sm:p-6`}
      onClick={onClose}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reading-statistics-title"
        tabIndex={-1}
        data-reading-statistics-modal="true"
        onClick={(event) => event.stopPropagation()}
        className={`flex max-h-[calc(100dvh-1.5rem)] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border ${theme.border} ${theme.bg} ${theme.text} shadow-2xl sm:max-h-[calc(100dvh-3rem)]`}
      >
        <header className={`flex items-center justify-between border-b ${theme.border} px-4 py-3 sm:px-5`}>
          <div>
            <h2 id="reading-statistics-title" className="text-lg font-black">독서 통계</h2>
            <p className="mt-0.5 text-[11px] opacity-55">서버 시각이 확인된 기기 시간은 한 번만 계산합니다</p>
          </div>
          <button type="button" onClick={onClose} aria-label="독서 통계 닫기" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10">
            <X size={22} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
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
              <div className="grid grid-cols-3 gap-2">
                {(['today', 'week', 'month'] as const).map((value) => (
                  <div key={value} className={`rounded-2xl border ${theme.border} p-3`}>
                    <div className="text-[10px] font-bold opacity-50">{rangeLabels.find((item) => item.value === value)?.label}</div>
                    <div className="mt-1 text-sm font-black sm:text-lg">{formatReadingDuration(headlineTotals[value])}</div>
                  </div>
                ))}
              </div>

              <div className={`mt-4 flex gap-1 overflow-x-auto rounded-2xl border ${theme.border} p-1`}>
                {rangeLabels.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setRange(item.value)}
                    aria-pressed={range === item.value}
                    className={`min-h-11 min-w-[4.5rem] flex-1 rounded-xl px-3 text-xs font-bold ${range === item.value ? 'bg-accent-600 text-white' : 'opacity-60 hover:opacity-100'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <div className={`rounded-2xl border ${theme.border} p-3`}>
                  <div className="flex items-center gap-2 text-xs font-bold opacity-60"><Monitor size={15} /> 화면 독서</div>
                  <div className="mt-1 text-lg font-black">{formatReadingDuration(summary.screenMs)}</div>
                </div>
                <div className={`rounded-2xl border ${theme.border} p-3`}>
                  <div className="flex items-center gap-2 text-xs font-bold opacity-60"><Headphones size={15} /> TTS 듣기</div>
                  <div className="mt-1 text-lg font-black">{formatReadingDuration(summary.ttsMs)}</div>
                </div>
              </div>

              <div className="mt-5 flex items-end justify-between gap-3">
                <div>
                  <h3 className="text-sm font-black">도서별 기록</h3>
                  <p className="text-[11px] opacity-50">{summary.books.length}권 · 완독 {summary.completedBookCount}권</p>
                </div>
                <div className="text-right text-xs opacity-45">원본 {summary.sourceSessionCount}개</div>
              </div>

              {summary.uncertainClockSessionCount > 0 && (
                <p className="mt-2 rounded-xl bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-300">
                  서버 시각을 아직 확인하지 못한 기록 {summary.uncertainClockSessionCount}개는 기기별로 합산했습니다. 온라인 동기화 뒤 새 기록부터 기기 간 겹침 제거가 정확해집니다.
                </p>
              )}

              <div className="mt-2 grid gap-2">
                {summary.books.length === 0 ? (
                  <div className={`rounded-2xl border ${theme.border} py-12 text-center text-sm opacity-45`}>아직 기록된 독서 시간이 없습니다.</div>
                ) : summary.books.map((book) => (
                  <article key={book.bookId} data-reading-statistics-book="true" className={`rounded-2xl border ${theme.border} px-3 py-3`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h4 className="truncate text-sm font-bold">{book.bookTitle}</h4>
                        <p className="mt-1 text-[11px] opacity-50">{book.readDates.length}일 · {book.endProgressPercent.toFixed(1)}%{book.completed ? ' · 완독' : ''}</p>
                      </div>
                      <strong className="shrink-0 text-sm text-accent-500">{formatReadingDuration(book.totalMs)}</strong>
                    </div>
                    <div className="mt-2 flex gap-3 text-[11px] opacity-55">
                      <span>화면 {formatReadingDuration(book.screenMs)}</span>
                      <span>TTS {formatReadingDuration(book.ttsMs)}</span>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>

        <footer className={`border-t ${theme.border} px-4 py-3 sm:px-5`}>
          {feedback && <p role="status" className="mb-2 text-center text-xs font-bold text-accent-500">{feedback}</p>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <button type="button" data-reading-statistics-export="markdown" onClick={exportMarkdown} disabled={sessions.length === 0} className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl border ${theme.border} text-xs font-bold disabled:opacity-30`}>
              <FileText size={15} /><Download size={13} /> MD
            </button>
            <button type="button" data-reading-statistics-export="json" onClick={exportJson} disabled={sessions.length === 0} className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl border ${theme.border} text-xs font-bold disabled:opacity-30`}>
              <FileJson size={15} /><Download size={13} /> JSON
            </button>
            <button type="button" data-reading-statistics-share="true" onClick={() => void share()} disabled={sharing || sessions.length === 0} className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-accent-600 text-xs font-bold text-white disabled:opacity-30">
              <Share2 size={15} /> 공유
            </button>
            <button type="button" data-reading-statistics-diagnostics="true" onClick={() => void exportDiagnostics()} disabled={exportingDiagnostics} className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl border ${theme.border} text-xs font-bold disabled:opacity-30`}>
              <Database size={15} /><Download size={13} /> 진단
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
};
