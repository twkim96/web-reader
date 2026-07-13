export type RemoteProgressDecision = 'ignore' | 'jump' | 'prompt';

type RemoteProgressDecisionInput = {
  isInitialSync: boolean;
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
  if (
    !remoteAnchorCfi
    || remoteAnchorCfi === currentAnchorCfi
  ) return 'ignore';

  const hasComparableRevisions = Number.isSafeInteger(remoteRevision)
    && Number.isSafeInteger(localRevision);
  if (hasComparableRevisions) {
    if (remoteRevision! <= localRevision!) return 'ignore';
  } else if (remoteTime <= lastSaveTime) return 'ignore';

  if (isInitialSync && isQuietResumeEligible) return 'jump';

  return Math.abs((remotePercent || 0) - (currentPercent || 0)) > 0.03
    ? 'prompt'
    : 'ignore';
};
