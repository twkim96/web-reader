import type { SyncConflictV5 } from './syncOutboxV5';
import type { ProgressPositionV2 } from './progressV2Schema';

type QuietProgressConflictInput = {
  conflict: SyncConflictV5;
  activeBookId?: string;
  currentSessionId: string;
};

export type QuietProgressConflictReason =
  | 'previous-session'
  | 'equivalent-position'
  | 'newer-same-device'
  | 'higher-local-position'
  | 'higher-remote-position'
  | 'equal-progress-newer-revision';

export type AutomaticProgressConflictResolution = {
  winner: 'local' | 'remote';
  reason: QuietProgressConflictReason;
};

const positionAnchor = (position: ProgressPositionV2) => (
  position.anchorCfi ?? position.cfi
);

export const isEquivalentProgressPosition = (
  left: ProgressPositionV2,
  right: ProgressPositionV2,
) => positionAnchor(left) === positionAnchor(right);

export const getAutomaticProgressConflictResolution = ({
  conflict,
  activeBookId,
  currentSessionId,
}: QuietProgressConflictInput): AutomaticProgressConflictResolution | null => {
  const { event, remoteHead } = conflict;
  if (
    !event
    || event.target.kind !== 'progress'
    || event.operation !== 'progress.set'
    || !event.payload
    || conflict.blockedEventIds.length > 0
    || !conflict.latestLocalPosition
    || !('anchorCfi' in conflict.latestLocalPosition)
    || conflict.latestLocalPosition.cfi !== event.payload.cfi
    || (conflict.latestLocalPosition.anchorCfi ?? null) !== (event.payload.anchorCfi ?? null)
    || conflict.latestLocalPosition.progressPercent !== event.payload.progressPercent
    || !remoteHead
    || !('position' in remoteHead)
    || remoteHead.operation !== 'set'
    || !remoteHead.position
    || remoteHead.revision <= event.baseRevision
  ) return null;

  if (isEquivalentProgressPosition(event.payload, remoteHead.position)) {
    return { winner: 'remote', reason: 'equivalent-position' };
  }

  if (event.payload.progressPercent > remoteHead.position.progressPercent) {
    return { winner: 'local', reason: 'higher-local-position' };
  }

  if (remoteHead.position.progressPercent > event.payload.progressPercent) {
    if (
      event.sessionId !== currentSessionId
      && event.target.bookId === activeBookId
    ) {
      return { winner: 'remote', reason: 'previous-session' };
    }

    if (
      remoteHead.acceptedDeviceId === event.deviceId
      && remoteHead.occurredAtClient > event.occurredAtClient
    ) {
      return { winner: 'remote', reason: 'newer-same-device' };
    }

    return { winner: 'remote', reason: 'higher-remote-position' };
  }

  return { winner: 'remote', reason: 'equal-progress-newer-revision' };
};

export const getQuietProgressConflictReason = ({
  conflict,
  activeBookId,
  currentSessionId,
}: QuietProgressConflictInput): QuietProgressConflictReason | null => {
  return getAutomaticProgressConflictResolution({
    conflict,
    activeBookId,
    currentSessionId,
  })?.reason ?? null;
};
