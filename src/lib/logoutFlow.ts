export type LogoutFlowOptions = {
  prepareUi: () => void;
  signOut: () => Promise<void>;
  commitLocalCleanup: () => void;
  recoverUi: (error: unknown) => void | Promise<unknown>;
};

export const runLogoutFlow = async ({
  prepareUi,
  signOut,
  commitLocalCleanup,
  recoverUi,
}: LogoutFlowOptions) => {
  prepareUi();
  try {
    await signOut();
  } catch (error) {
    await recoverUi(error);
    return false;
  }

  commitLocalCleanup();
  return true;
};
