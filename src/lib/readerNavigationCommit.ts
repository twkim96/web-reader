import type { Bookmark } from '../types';

export type PendingReaderJump = {
  key: string;
  bookmarks?: Bookmark[];
};

export type PendingSliderMoveSnapshot = {
  targetPercent: number;
  startPercent: number;
  startCfi: string;
  stagedBookmarks?: Bookmark[];
};

const AUTO_BOOKMARK_THRESHOLD_PERCENT = 5;

export const createPendingSliderMove = ({
  targetPercent,
  startPercent,
  startCfi,
  stageAutoBookmark,
}: {
  targetPercent: number;
  startPercent: number;
  startCfi: string;
  stageAutoBookmark: (prevCfi: string, prevPct: number) => Bookmark[];
}): PendingSliderMoveSnapshot => ({
  targetPercent,
  startPercent,
  startCfi,
  stagedBookmarks: Math.abs(targetPercent - startPercent)
    > AUTO_BOOKMARK_THRESHOLD_PERCENT
    ? stageAutoBookmark(startCfi, startPercent)
    : undefined,
});

export const reuseOrStageReaderJump = (
  current: PendingReaderJump | null,
  key: string,
  stageBookmarks: () => Bookmark[] | undefined,
): PendingReaderJump => current?.key === key
  ? current
  : { key, bookmarks: stageBookmarks() };
