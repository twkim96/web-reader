export type RemoteProgressDecision = 'ignore' | 'jump' | 'prompt';

type RemoteProgressDecisionInput = {
  isInitialSync: boolean;
  remoteAnchorCfi: string;
  currentAnchorCfi: string;
  remoteTime: number;
  lastSaveTime: number;
  remotePercent: number;
  currentPercent: number;
};

export const decideRemoteProgressAction = ({
  isInitialSync,
  remoteAnchorCfi,
  currentAnchorCfi,
  remoteTime,
  lastSaveTime,
  remotePercent,
  currentPercent,
}: RemoteProgressDecisionInput): RemoteProgressDecision => {
  if (
    !remoteAnchorCfi
    || remoteAnchorCfi === currentAnchorCfi
    || remoteTime <= lastSaveTime
  ) return 'ignore';

  if (isInitialSync) return 'jump';

  return Math.abs((remotePercent || 0) - (currentPercent || 0)) > 0.03
    ? 'prompt'
    : 'ignore';
};
