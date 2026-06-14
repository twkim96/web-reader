export type SequentialBatchResult = {
  refresh?: boolean;
  stop?: boolean;
};

export const runSequentialBatch = async <T>(
  items: T[],
  signal: AbortSignal,
  processItem: (item: T, index: number) => Promise<SequentialBatchResult>,
  onRefresh: () => void,
) => {
  let shouldRefresh = false;
  let processedCount = 0;

  try {
    for (const [index, item] of items.entries()) {
      if (signal.aborted) break;
      const result = await processItem(item, index);
      processedCount += 1;
      shouldRefresh ||= result.refresh === true;
      if (signal.aborted || result.stop) break;
    }
  } finally {
    if (shouldRefresh) onRefresh();
  }

  return { processedCount, refreshed: shouldRefresh };
};
