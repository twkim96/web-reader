import type { UserProgress } from '../types';

export type ProgressCommitConvergenceAction =
  | 'skip'
  | 'apply-canonical'
  | 'reload-persisted';

export const getProgressCommitConvergenceAction = ({
  ownerCurrent,
  latestLocalWrite,
  currentDisplay,
  optimistic,
}: {
  ownerCurrent: boolean;
  latestLocalWrite: boolean;
  currentDisplay: UserProgress | undefined;
  optimistic: UserProgress;
}): ProgressCommitConvergenceAction => {
  if (!ownerCurrent || !latestLocalWrite) return 'skip';
  return currentDisplay === optimistic ? 'apply-canonical' : 'reload-persisted';
};

export const canApplyReloadedProgress = ({
  ownerCurrent,
  latestLocalWrite,
  currentDisplay,
  observedDisplay,
}: {
  ownerCurrent: boolean;
  latestLocalWrite: boolean;
  currentDisplay: UserProgress | undefined;
  observedDisplay: UserProgress | undefined;
}) => (
  ownerCurrent
  && latestLocalWrite
  && currentDisplay === observedDisplay
);
