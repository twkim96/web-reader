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

export type CanonicalRemoteNavigationResult = {
  adoption: RemoteProgressAdoptionResult;
  navigated: boolean;
};

type CanonicalRemoteNavigationSteps = {
  isCurrent: () => boolean;
  adopt: () => Promise<RemoteProgressAdoptionResult>;
  prepare: () => number;
  cancel: (preparationId: number) => void;
  finish?: (preparationId: number) => void;
  navigate: () => Promise<boolean>;
};

export const executeCanonicalRemoteProgressNavigation = async ({
  isCurrent,
  adopt,
  prepare,
  cancel,
  finish,
  navigate,
}: CanonicalRemoteNavigationSteps): Promise<CanonicalRemoteNavigationResult> => {
  const adoption = await adopt();
  if (adoption.status !== 'adopted' || !isCurrent()) {
    return { adoption, navigated: false };
  }

  const preparationId = prepare();
  try {
    const navigated = await navigate();
    if (!navigated || !isCurrent()) {
      cancel(preparationId);
      return { adoption, navigated: false };
    }
    finish?.(preparationId);
    return { adoption, navigated: true };
  } catch (error) {
    cancel(preparationId);
    throw error;
  }
};
