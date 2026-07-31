export type BookDeletionSteps = {
  deleteDrive?: () => Promise<void>;
  resetProgress: () => Promise<boolean>;
  removeLocalContent: () => Promise<void>;
  isCurrent?: () => boolean;
};

export const deleteBookInSafeOrder = async ({
  deleteDrive,
  resetProgress,
  removeLocalContent,
  isCurrent,
}: BookDeletionSteps) => {
  const canContinue = () => isCurrent?.() ?? true;

  // Cloud deletion is idempotent (Drive 404 is treated as already deleted),
  // so a failed progress reset can be retried without discarding the local
  // book, progress, or shelf entry first.
  if (!canContinue()) return false;
  await deleteDrive?.();
  if (!canContinue()) return false;
  if (!await resetProgress()) return false;
  if (!canContinue()) return false;
  await removeLocalContent();
  return canContinue();
};
