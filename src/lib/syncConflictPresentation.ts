import type { ViewState } from '../types';
import type { SyncConflictV5 } from './syncOutboxV5';

type SyncConflictPresentationInput = {
  hasConflict: boolean;
  explicitReview: boolean;
  view: ViewState;
  conflictKind: NonNullable<SyncConflictV5['event']>['target']['kind'] | null;
  conflictBookId: string | null;
  activeBookId?: string;
};

export const shouldShowSyncConflictDialog = ({
  hasConflict,
  explicitReview,
  view,
  conflictKind,
  conflictBookId,
  activeBookId,
}: SyncConflictPresentationInput) => Boolean(
  hasConflict
  && (
    explicitReview
    || (
      view === 'reader'
      && conflictKind === 'progress'
      && conflictBookId !== null
      && conflictBookId === activeBookId
    )
  )
);

export const shouldShowSyncReviewBadge = ({
  hasConflict,
  explicitReview,
  view,
  conflictKind,
  conflictBookId,
  activeBookId,
}: SyncConflictPresentationInput) => (
  hasConflict
  && !explicitReview
  && (view === 'shelf' || view === 'reader')
  && !(
    view === 'reader'
    && conflictKind === 'progress'
    && conflictBookId !== null
    && conflictBookId === activeBookId
  )
);

export const selectProgressSyncConflict = (
  conflicts: ReadonlyArray<SyncConflictV5>,
  activeBookId?: string,
) => {
  const supported = conflicts.filter((candidate) => (
    candidate.event?.target.kind === 'progress'
    || candidate.event?.target.kind === 'bookmark'
  ));
  return supported.find((candidate) => (
    candidate.event?.target.kind === 'progress'
    && candidate.event.target.bookId === activeBookId
  )) ?? supported.find((candidate) => (
    candidate.event?.target
    && 'bookId' in candidate.event.target
    && candidate.event.target.bookId === activeBookId
  )) ?? supported[0] ?? null;
};
