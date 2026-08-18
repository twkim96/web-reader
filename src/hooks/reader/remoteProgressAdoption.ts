import type { RemoteProgressAdoptionResult } from '../../types';

export const getRemoteProgressIdentity = (progress: {
  operation: 'set' | 'reset';
  cfi: string;
  anchorCfi?: string;
  lastRead: number;
  syncRevision?: number;
  acceptedEventId?: string;
}) => (
  Number.isSafeInteger(progress.syncRevision)
  && progress.syncRevision! > 0
  && progress.acceptedEventId
    ? `${progress.syncRevision}:${progress.acceptedEventId}`
    : `${progress.operation}:${progress.anchorCfi || progress.cfi}:${progress.lastRead}`
);

export type CanonicalRemoteNavigationResult =
  | { status: 'navigated'; progress: Extract<RemoteProgressAdoptionResult, { status: 'adopted' }>['progress'] }
  | { status: 'blocked-by-local-work'; work: Extract<RemoteProgressAdoptionResult, { status: 'blocked-by-local-work' }>['work'] }
  | { status: 'stale-remote' }
  | { status: 'adopted-navigation-superseded'; progress: Extract<RemoteProgressAdoptionResult, { status: 'adopted' }>['progress'] }
  | { status: 'adopted-navigation-failed'; progress: Extract<RemoteProgressAdoptionResult, { status: 'adopted' }>['progress']; retryable: boolean }
  | { status: 'cancelled'; retryable: boolean };

type CanonicalRemoteNavigationSteps = {
  isCurrent: () => boolean;
  isCurrentAfterCommit?: () => boolean;
  ready?: () => Promise<boolean>;
  adopt: () => Promise<RemoteProgressAdoptionResult>;
  prepare: () => number;
  cancel: (preparationId: number) => void;
  finish?: (preparationId: number) => void;
  navigate: () => Promise<boolean>;
};

export const executeCanonicalRemoteProgressNavigation = async ({
  isCurrent,
  isCurrentAfterCommit = isCurrent,
  ready,
  adopt,
  prepare,
  cancel,
  finish,
  navigate,
}: CanonicalRemoteNavigationSteps): Promise<CanonicalRemoteNavigationResult> => {
  if (ready) {
    try {
      if (!await ready()) return { status: 'cancelled', retryable: true };
    } catch {
      return { status: 'cancelled', retryable: true };
    }
    if (!isCurrent()) return { status: 'cancelled', retryable: true };
  }

  let adoption: RemoteProgressAdoptionResult;
  try {
    adoption = await adopt();
  } catch {
    return { status: 'cancelled', retryable: true };
  }
  if (adoption.status === 'blocked-by-local-work') return adoption;
  if (adoption.status === 'stale-remote') return adoption;
  if (adoption.status === 'cancelled') return { status: 'cancelled', retryable: true };
  if (!isCurrentAfterCommit()) {
    return { status: 'adopted-navigation-superseded', progress: adoption.progress };
  }

  const preparationId = prepare();
  try {
    const navigated = await navigate();
    if (!isCurrentAfterCommit()) {
      cancel(preparationId);
      return { status: 'adopted-navigation-superseded', progress: adoption.progress };
    }
    if (!navigated) {
      cancel(preparationId);
      return {
        status: 'adopted-navigation-failed',
        progress: adoption.progress,
        retryable: true,
      };
    }
    finish?.(preparationId);
    return { status: 'navigated', progress: adoption.progress };
  } catch {
    cancel(preparationId);
    return {
      status: 'adopted-navigation-failed',
      progress: adoption.progress,
      retryable: true,
    };
  }
};
