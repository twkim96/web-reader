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
}: RemoteProgressDecisionInput): RemoteProgressDecision => {
  if (
    !remoteAnchorCfi
    || remoteAnchorCfi === currentAnchorCfi
    || remoteTime <= lastSaveTime
  ) return 'ignore';

  if (isInitialSync && isQuietResumeEligible) return 'jump';

  return Math.abs((remotePercent || 0) - (currentPercent || 0)) > 0.03
    ? 'prompt'
    : 'ignore';
};
