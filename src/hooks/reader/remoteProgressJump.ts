export type RemoteProgressJumpCompletion = boolean | {
  completed: boolean;
  afterRollback?: () => void;
};

export type RemoteProgressJumpSteps = {
  isCurrent: () => boolean;
  ready?: () => Promise<boolean>;
  prepare: () => number;
  cancel: (preparationId: number) => void;
  finish?: (preparationId: number) => void;
  navigate: () => Promise<boolean>;
  rollback?: (preparationId: number) => Promise<boolean>;
  complete: () => Promise<RemoteProgressJumpCompletion>;
};

export const executeRemoteProgressJump = async ({
  isCurrent,
  ready,
  prepare,
  cancel,
  finish,
  navigate,
  rollback,
  complete,
}: RemoteProgressJumpSteps) => {
  if (ready) {
    try {
      if (!await ready() || !isCurrent()) return false;
    } catch {
      return false;
    }
  }

  const preparationId = prepare();
  const rollbackAndCancel = async () => {
    let restored = true;
    try {
      if (rollback) {
        restored = await rollback(preparationId);
        for (let attempt = 0; !restored && ready && attempt < 2; attempt += 1) {
          if (!await ready()) continue;
          restored = await rollback(preparationId);
        }
      }
      return restored;
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
    // A newer user or remote navigation owns the viewport now. Restoring the
    // older pre-jump CFI here would overwrite that newer intent.
    cancel(preparationId);
    return false;
  }

  try {
    const result = await complete();
    const completed = typeof result === 'boolean' ? result : result.completed;
    if (completed) {
      finish?.(preparationId);
      return true;
    }
    const restored = await rollbackAndCancel();
    if (restored && typeof result !== 'boolean') result.afterRollback?.();
    return false;
  } catch (error) {
    await rollbackAndCancel();
    throw error;
  }
};
