import type { SyncConflictV5 } from './syncOutboxV5';

type QuietStartupConflictInput = {
  conflict: SyncConflictV5;
  activeBookId?: string;
  currentSessionId: string;
};

export const isQuietStartupProgressConflict = ({
  conflict,
  activeBookId,
  currentSessionId,
}: QuietStartupConflictInput) => {
  const { event, remoteHead } = conflict;
  if (
    !activeBookId
    || !event
    || event.target.kind !== 'progress'
    || event.target.bookId !== activeBookId
    || event.operation !== 'progress.set'
    || event.sessionId === currentSessionId
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
  ) return false;

  return remoteHead.revision > event.baseRevision;
};
