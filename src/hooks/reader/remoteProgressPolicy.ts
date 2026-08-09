import { hasMeaningfulProgressDelta } from '../../lib/progressDistancePolicy.ts';

export type RemoteProgressDecision = 'ignore' | 'jump' | 'prompt';

type RemoteProgressDecisionInput = {
  isInitialSync: boolean;
  operation?: 'set' | 'reset';
  hasLocalProgress?: boolean;
  remoteAnchorCfi: string;
  currentAnchorCfi: string;
  remoteTime: number;
  lastSaveTime: number;
  remotePercent: number;
  currentPercent: number;
  isQuietResumeEligible: boolean;
  remoteRevision?: number;
  localRevision?: number;
};

export const decideRemoteProgressAction = ({
  isInitialSync,
  operation = 'set',
  hasLocalProgress = true,
  remoteAnchorCfi,
  currentAnchorCfi,
  remoteTime,
  lastSaveTime,
  remotePercent,
  currentPercent,
  isQuietResumeEligible,
  remoteRevision,
  localRevision,
}: RemoteProgressDecisionInput): RemoteProgressDecision => {
  const hasComparableRevisions = Number.isSafeInteger(remoteRevision)
    && Number.isSafeInteger(localRevision);
  if (hasComparableRevisions) {
    if (remoteRevision! <= localRevision!) return 'ignore';
  } else if (remoteTime <= lastSaveTime) return 'ignore';

  if (operation === 'reset') {
    return isInitialSync && !hasLocalProgress && isQuietResumeEligible
      ? 'jump'
      : 'prompt';
  }

  if (
    !remoteAnchorCfi
    || remoteAnchorCfi === currentAnchorCfi
  ) return 'ignore';

  if (isInitialSync && isQuietResumeEligible) return 'jump';

  return hasMeaningfulProgressDelta(remotePercent, currentPercent)
    ? 'prompt'
    : 'ignore';
};
