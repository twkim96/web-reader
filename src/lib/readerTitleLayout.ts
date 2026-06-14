export type ReaderTitleLayout = 'center' | 'right';

type ReaderTitleLayoutMetrics = {
  viewportWidth: number;
  leftInset: number;
  rightLimit: number;
  titleWidth: number;
};

export const getReaderTitleLayout = ({
  viewportWidth,
  leftInset,
  rightLimit,
  titleWidth,
}: ReaderTitleLayoutMetrics): ReaderTitleLayout => {
  const centeredLeft = (viewportWidth - titleWidth) / 2;
  const centeredRight = (viewportWidth + titleWidth) / 2;
  return centeredLeft < leftInset || centeredRight > rightLimit ? 'right' : 'center';
};
