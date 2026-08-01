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
  | 'newer-same-device';

const positionAnchor = (position: ProgressPositionV2) => (
  position.anchorCfi ?? position.cfi
);

export const isEquivalentProgressPosition = (
  left: ProgressPositionV2,
  right: ProgressPositionV2,
) => positionAnchor(left) === positionAnchor(right);

export const getQuietProgressConflictReason = ({
  conflict,
  activeBookId,
  currentSessionId,
}: QuietProgressConflictInput): QuietProgressConflictReason | null => {
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
    || 'bookmarkId' in remoteHead
    || remoteHead.operation !== 'set'
    || !remoteHead.position
    || remoteHead.revision <= event.baseRevision
  ) return null;

  if (isEquivalentProgressPosition(event.payload, remoteHead.position)) {
    return 'equivalent-position';
  }

  if (
    event.sessionId !== currentSessionId
    && event.target.bookId === activeBookId
  ) {
    return 'previous-session';
  }

  if (
    remoteHead.acceptedDeviceId === event.deviceId
    && remoteHead.occurredAtClient > event.occurredAtClient
  ) {
    return 'newer-same-device';
  }

  return null;
};
