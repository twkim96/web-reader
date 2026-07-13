export type BookDeletionSteps = {
  deleteDrive?: () => Promise<void>;
  resetProgress: () => Promise<boolean>;
  removeLocalContent: () => Promise<void>;
};

export const deleteBookInSafeOrder = async ({
  deleteDrive,
  resetProgress,
  removeLocalContent,
}: BookDeletionSteps) => {
  // Cloud deletion is idempotent (Drive 404 is treated as already deleted),
  // so a failed progress reset can be retried without discarding the local
  // book, progress, or shelf entry first.
  await deleteDrive?.();
  if (!await resetProgress()) return false;
  await removeLocalContent();
  return true;
};
