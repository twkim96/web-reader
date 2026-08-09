export type RemoteProgressJumpSteps = {
  isCurrent: () => boolean;
  prepare: () => number;
  cancel: (preparationId: number) => void;
  finish?: (preparationId: number) => void;
  navigate: () => Promise<boolean>;
  rollback?: (preparationId: number) => Promise<void>;
  complete: () => Promise<boolean>;
};

export const executeRemoteProgressJump = async ({
  isCurrent,
  prepare,
  cancel,
  finish,
  navigate,
  rollback,
  complete,
}: RemoteProgressJumpSteps) => {
  const preparationId = prepare();
  const rollbackAndCancel = async () => {
    try {
      await rollback?.(preparationId);
    } finally {
      cancel(preparationId);
    }
  };
  let committed = false;
  try {
    committed = await navigate();
  } catch (error) {
    if (isCurrent()) await rollbackAndCancel();
    else cancel(preparationId);
    throw error;
  }
  if (!committed || !isCurrent()) {
    cancel(preparationId);
    return false;
  }

  try {
    const completed = await complete();
    if (!completed) await rollbackAndCancel();
    else finish?.(preparationId);
    return completed;
  } catch (error) {
    await rollbackAndCancel();
    throw error;
  }
};
