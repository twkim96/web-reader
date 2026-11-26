'use client';

import { measureMyPageWork } from '../../lib/myPagePerformance';
import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { useBookTitleDisplay } from '../../contexts/BookTitleDisplayContext';
import { useLocalReadingDate } from '../../hooks/useLocalReadingDate';
import { useMyPageReadingCalendar, useMyPageReadingWeek } from '../../hooks/useMyPageList';
import { useLocalReadingReportSessions } from '../../hooks/useLocalReadingReportSessions';
import { isGuestOwner, type OwnerKey } from '../../lib/ownerIdentity';
import {
  buildReadingStatistics,
  formatReadingDuration,
  getReadingStatisticsRangeBounds,
  isLocalDateWithinBounds,
  MIN_READING_STATISTICS_BLOCK_MS,
} from '../../lib/readingStatistics';
import { canMergeLocalReadingWithPublication, mergePublishedCalendarDays, publishedCalendarCovers } from '../../lib/readingRollupCalendar';
import { readingRollupWeekForDay, type ReadingRollupActivity } from '../../lib/readingStatisticsRollup';

type Props = {
  ownerKey: OwnerKey;
  active?: boolean;
  onRefresh?: () => void;
  onOpenStatistics: () => void;
  onOpenAnnotations: () => void;
};

const readingTimeFormat = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });

const dateKey = (year: number, month: number, day: number) => (
  `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
);

export function ReadingDashboard({ ownerKey, active = true, onRefresh, onOpenStatistics, onOpenAnnotations }: Props) {
  const displayBookTitle = useBookTitleDisplay();
  const today = useLocalReadingDate();
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedDay, setSelectedDay] = useState(() => {
    const now = new Date();
    return dateKey(now.getFullYear(), now.getMonth(), now.getDate());
  });
  const [visibleRows, setVisibleRows] = useState({ day: '', count: 50 });

  const canUseRollup = process.env.NEXT_PUBLIC_ENABLE_READING_STATS_ROLLUP_READS === '1' && !isGuestOwner(ownerKey);
  const currentData = useLocalReadingReportSessions(ownerKey, active, !isGuestOwner(ownerKey));
  useEffect(() => {
    if (active) onRefresh?.();
  }, [active, ownerKey, onRefresh]);

  const { data: published } = useMyPageReadingCalendar(ownerKey, active && canUseRollup);
  const calendar = published?.calendar ?? null;
  const sessions = calendar && !canMergeLocalReadingWithPublication(currentData, calendar) ? null : currentData?.sessions;
  const statistics = useMemo(() => {
    if (!calendar && (!currentData || currentData.error)) return null;
    const details = new Map<string, ReadingRollupActivity[]>();
    const summary = measureMyPageWork('dashboard-timeline', () => buildReadingStatistics(sessions ?? [], {}, undefined, {
      minimumMs: MIN_READING_STATISTICS_BLOCK_MS,
      onBlock: ({ session, ...activity }) => {
        if (calendar && publishedCalendarCovers(calendar, activity.localDate)) return;
        const block = { ...activity, bookId: session.bookId, bookTitle: session.bookTitle, mode: session.mode,
          timezoneOffsetMinutes: session.timezoneOffsetMinutes };
        const day = details.get(block.localDate);
        if (day) day.push(block);
        else details.set(block.localDate, [block]);
      },
    }));
    for (const rows of details.values()) rows.reverse();
    const days = mergePublishedCalendarDays(summary.days, calendar);
    const dayTotals = new Map(days.map(({ localDate, totalMs }) => [localDate, totalMs]));
    return { days, details, dayTotals };
  }, [calendar, currentData, sessions]);
  const days = statistics?.days ?? null;
  const totals = useMemo(() => {
    if (!days) return null;
    const sumRange = (range: 'today' | 'month') => {
      const bounds = getReadingStatisticsRangeBounds(range, today);
      return days.reduce((sum, day) => sum + (
        isLocalDateWithinBounds(day.localDate, bounds) ? day.totalMs : 0
      ), 0);
    };
    return [sumRange('today'), sumRange('month'), days.reduce((sum, day) => sum + day.totalMs, 0)];
  }, [days, today]);
  const rowLimit = visibleRows.day === selectedDay ? visibleRows.count : 50;
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const selectedTotalMs = statistics?.dayTotals.get(selectedDay) ?? 0;
  const selectedWeek = calendar && publishedCalendarCovers(calendar, selectedDay) ? readingRollupWeekForDay(selectedDay) : null;
  const wantsDetails = Boolean(selectedWeek) && selectedTotalMs > 0;
  const week = useMyPageReadingWeek(ownerKey, selectedWeek, active && wantsDetails);
  const missingWeek = wantsDetails && week.data?.week === null;
  const selectedSessions = selectedWeek
    ? week.data?.week?.activities.filter(({ localDate }) => localDate === selectedDay) ?? []
    : statistics?.details.get(selectedDay) ?? [];
  const detailFailed = wantsDetails && (Boolean(week.error) || missingWeek);
  const detailLoading = wantsDetails && !detailFailed && week.data === undefined;
  const changeMonth = (offset: number) => {
    const next = new Date(year, monthIndex + offset, 1);
    setMonth(next);
    setSelectedDay(dateKey(next.getFullYear(), next.getMonth(), 1));
  };

  return (
    <div className="space-y-6 sm:space-y-8">
      <section aria-label="독서 시간 요약">
        <h2 className="text-lg font-semibold tracking-tight sm:text-xl">독서 시간</h2>
        <dl className="mt-4 grid grid-cols-3 gap-3 sm:gap-6">
          {['오늘', '이번 달', currentData?.recentOnly ? '확인된 기록' : '전체'].map((label, index) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs opacity-60 sm:text-sm">{label}</dt>
              <dd className="mt-1.5 text-base font-semibold tracking-tight tabular-nums sm:text-xl">{totals ? formatReadingDuration(totals[index]) : '—'}</dd>
            </div>
          ))}
        </dl>
      </section>

      {(!currentData || currentData.error) && (
        <p role="status" className="text-sm opacity-70">{currentData?.error ? '독서 기록을 불러오지 못했습니다.' : '독서 기록을 불러오는 중입니다.'}</p>
      )}
      {currentData?.recentOnly && (
        <p role="status" className="text-sm opacity-70">{calendar
          ? '확정된 독서 기록을 표시하고 있습니다. 이후 기록은 확인 중입니다.'
          : '서버는 최근 14일에 올라온 기록만 확인합니다. 이전 기록은 이 기기에 있는 만큼 표시합니다.'}</p>
      )}

      <div className="grid items-start gap-6 sm:gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-label="독서 달력">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight sm:text-xl">독서 달력</h2>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => changeMonth(-1)} aria-label="이전 달" className="rounded-full p-2 hover:bg-[color-mix(in_srgb,currentColor_8%,transparent)]"><ChevronLeft size={17} /></button>
              <span className="min-w-[6.5rem] text-center text-sm font-semibold tabular-nums">{year}년 {monthIndex + 1}월</span>
              <button type="button" onClick={() => changeMonth(1)} aria-label="다음 달" className="rounded-full p-2 hover:bg-[color-mix(in_srgb,currentColor_8%,transparent)]"><ChevronRight size={17} /></button>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-7 text-center text-xs">
            {['일', '월', '화', '수', '목', '금', '토'].map((day) => <span key={day} className="py-2 opacity-65">{day}</span>)}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-y-1">
            {Array.from({ length: firstWeekday }, (_, i) => <span key={`empty-${i}`} />)}
            {Array.from({ length: daysInMonth }, (_, i) => {
              const day = i + 1;
              const key = dateKey(year, monthIndex, day);
              const duration = statistics?.dayTotals.get(key) ?? 0;
              const selected = key === selectedDay;
              return (
                <button key={key} type="button" onClick={() => setSelectedDay(key)} aria-pressed={selected}
                  aria-label={`${monthIndex + 1}월 ${day}일${!days ? ', 기록 확인 중' : duration > 0 ? `, ${formatReadingDuration(duration)}` : ''}`}
                  className={`mx-auto flex h-12 w-full max-w-12 flex-col items-center justify-center rounded-xl text-sm transition-colors ${selected ? 'bg-[color-mix(in_srgb,var(--accent-500)_14%,transparent)] text-accent-500' : 'hover:bg-[color-mix(in_srgb,currentColor_8%,transparent)]'}`}>
                  <span className={selected ? 'font-semibold' : ''}>{day}</span>
                  <span className="mt-0.5 h-3 whitespace-nowrap text-[9px] leading-3 text-accent-500">{duration > 0 ? formatReadingDuration(duration) : ''}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section aria-label="선택한 날짜의 독서 기록">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold sm:text-lg">{Number(selectedDay.slice(5, 7))}월 {Number(selectedDay.slice(8, 10))}일</h2>
            {selectedTotalMs > 0 && <span className="text-sm font-semibold text-accent-500">{formatReadingDuration(selectedTotalMs)}</span>}
          </div>
          {!currentData || currentData.error ? (
            <p className="mt-3 text-sm opacity-60">{currentData?.error ? '기록을 표시할 수 없습니다.' : '기록을 불러오는 중입니다.'}</p>
          ) : detailFailed ? (
            <button type="button" className="mt-3 text-sm text-accent-500" onClick={() => void week.refresh()}>기록을 불러오지 못했습니다. 다시 시도</button>
          ) : detailLoading ? (
            <p role="status" className="mt-3 text-sm opacity-60">기록을 불러오는 중입니다.</p>
          ) : selectedSessions.length === 0 ? (
            <p className="mt-3 text-sm opacity-60">{currentData.recentOnly ? '이날 확인된 독서 기록이 없습니다.' : '이날 읽은 기록이 없습니다.'}</p>
          ) : (
            <div key={selectedDay} role="region" aria-label="독서 기록 목록" tabIndex={0}
              className="-ml-1 mt-4 max-h-60 overflow-y-auto pr-2 pl-1 [scrollbar-gutter:stable]">
              <ul className="mypage-divided-list">
                {selectedSessions.slice(0, rowLimit).map(({ bookId, bookTitle, mode, timezoneOffsetMinutes, durationMs, startAt, progressSpanPercent }, index) => (
                  <li key={`${bookId}:${startAt}:${index}`} className="flex items-center justify-between gap-4 py-1">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{displayBookTitle(bookTitle)}</p>
                      <p className="mt-1 text-xs opacity-55">{readingTimeFormat.format(startAt - timezoneOffsetMinutes * 60_000)} · {mode === 'tts' ? '듣기' : '읽기'}</p>
                    </div>
                    <span className="shrink-0 text-xs opacity-70">
                      {progressSpanPercent !== null && `${progressSpanPercent.toFixed(2)}%p | `}
                      {Math.floor(durationMs / 60_000)}분
                    </span>
                  </li>
                ))}
              </ul>
              {selectedSessions.length > rowLimit && (
                <button type="button" className="mt-4 text-sm text-accent-500" onClick={() => setVisibleRows({ day: selectedDay, count: rowLimit + 50 })}>더 보기</button>
              )}
            </div>
          )}
        </section>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {[{ label: '독서 통계', action: onOpenStatistics }, { label: '내 주석', action: onOpenAnnotations }].map(({ label, action }) => (
          <button key={label} type="button" onClick={action} className="flex min-h-10 items-center gap-2 text-left text-sm font-medium transition-colors hover:text-accent-500">
            {label}<ArrowUpRight size={16} className="text-accent-500" />
          </button>
        ))}
      </div>
    </div>
  );
}
