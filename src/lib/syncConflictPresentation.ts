import type { ViewState } from '../types';

type SyncConflictPresentationInput = {
  hasConflict: boolean;
  explicitReview: boolean;
  view: ViewState;
  conflictBookId: string | null;
  activeBookId?: string;
};

export const shouldShowSyncConflictDialog = ({
  hasConflict,
  explicitReview,
  view,
  conflictBookId,
  activeBookId,
}: SyncConflictPresentationInput) => Boolean(
  hasConflict
  && (
    explicitReview
    || (view === 'reader' && conflictBookId !== null && conflictBookId === activeBookId)
  )
);

export const shouldShowSyncReviewBadge = ({
  hasConflict,
  explicitReview,
  view,
}: SyncConflictPresentationInput) => (
  hasConflict && !explicitReview && view === 'shelf'
);
