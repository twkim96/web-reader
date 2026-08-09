import {
  buildReadingStatistics,
  formatReadingDuration,
  toReadingSessionPayload,
  type ReadingSessionV1,
} from './readingStatistics';

export type ReadingStatisticsExportFile = {
  filename: string;
  mimeType: string;
  text: string;
};

const getDateStamp = (timestamp: number) => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const escapeMarkdownCell = (value: string) => (
  value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ')
);

export const createReadingStatisticsJsonExport = (
  sessions: readonly ReadingSessionV1[],
  generatedAt = Date.now(),
): ReadingStatisticsExportFile => {
  const payloads = sessions.map(toReadingSessionPayload).sort((left, right) => (
    left.startedAtClient - right.startedAtClient || left.sessionId.localeCompare(right.sessionId)
  ));
  return {
    filename: `web-reader-statistics-${getDateStamp(generatedAt)}.json`,
    mimeType: 'application/json;charset=utf-8',
    text: `${JSON.stringify({
      schemaVersion: 1,
      generatedAt,
      sessions: payloads,
      summary: buildReadingStatistics(payloads),
    }, null, 2)}\n`,
  };
};

export const createReadingStatisticsMarkdownExport = (
  sessions: readonly ReadingSessionV1[],
  generatedAt = Date.now(),
): ReadingStatisticsExportFile => {
  const summary = buildReadingStatistics(sessions);
  const lines = [
    '# Web Reader 독서 통계',
    '',
    `- 내보낸 시각: ${new Date(generatedAt).toLocaleString('ko-KR')}`,
    `- 총 독서 시간: ${formatReadingDuration(summary.totalMs)}`,
    `- 화면 독서: ${formatReadingDuration(summary.screenMs)}`,
    `- TTS 듣기: ${formatReadingDuration(summary.ttsMs)}`,
    `- 완독 도서: ${summary.completedBookCount}권`,
    '',
    '## 도서별',
    '',
    '| 도서 | 합계 | 화면 | TTS | 읽은 날 | 진행률 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...summary.books.map((book) => (
      `| ${escapeMarkdownCell(book.bookTitle)} | ${formatReadingDuration(book.totalMs)} | ${formatReadingDuration(book.screenMs)} | ${formatReadingDuration(book.ttsMs)} | ${book.readDates.length}일 | ${book.endProgressPercent.toFixed(1)}% |`
    )),
    '',
    '## 날짜별',
    '',
    '| 날짜 | 합계 | 화면 | TTS |',
    '| --- | ---: | ---: | ---: |',
    ...summary.days.map((day) => (
      `| ${day.localDate} | ${formatReadingDuration(day.totalMs)} | ${formatReadingDuration(day.screenMs)} | ${formatReadingDuration(day.ttsMs)} |`
    )),
    '',
    '> 여러 기기의 겹치는 구간은 한 번만 계산하며, 같은 시각의 TTS가 화면 독서보다 우선합니다.',
    '',
  ];
  return {
    filename: `web-reader-statistics-${getDateStamp(generatedAt)}.md`,
    mimeType: 'text/markdown;charset=utf-8',
    text: lines.join('\n'),
  };
};
