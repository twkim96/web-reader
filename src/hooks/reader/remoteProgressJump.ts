export type RemoteProgressJumpCompletion = boolean | {
  completed: boolean;
  afterRollback?: () => void;
};

export type RemoteProgressJumpSteps = {
  isCurrent: () => boolean;
  prepare: () => number;
  cancel: (preparationId: number) => void;
  finish?: (preparationId: number) => void;
  navigate: () => Promise<boolean>;
  rollback?: (preparationId: number) => Promise<void>;
  complete: () => Promise<RemoteProgressJumpCompletion>;
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
  if (!committed) {
    cancel(preparationId);
    return false;
  }
  if (!isCurrent()) {
    await rollbackAndCancel();
    return false;
  }

  try {
    const result = await complete();
    const completed = typeof result === 'boolean' ? result : result.completed;
    if (!completed) await rollbackAndCancel();
    else finish?.(preparationId);
    if (!completed && typeof result !== 'boolean') result.afterRollback?.();
    return completed;
  } catch (error) {
    await rollbackAndCancel();
    throw error;
  }
};
