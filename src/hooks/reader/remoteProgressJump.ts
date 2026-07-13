export type RemoteProgressJumpSteps = {
  claimDevice: boolean;
  isCurrent: () => boolean;
  prepare: () => void;
  navigate: () => Promise<void>;
  complete: () => Promise<boolean>;
};

export const executeRemoteProgressJump = async ({
  claimDevice,
  isCurrent,
  prepare,
  navigate,
  complete,
}: RemoteProgressJumpSteps) => {
  // Quiet resume adopts the verified remote head atomically before moving the
  // viewport. If a persisted local intent exists, adoption returns false and
  // the reader remains at the local position so the prompt can be shown.
  if (!claimDevice) {
    if (!await complete() || !isCurrent()) return false;
  }

  prepare();
  await navigate();
  if (!isCurrent()) return false;

  return claimDevice ? complete() : true;
};
