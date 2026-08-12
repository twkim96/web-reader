export type LogoutFlowOptions = {
  prepareUi: () => void;
  signOut: () => Promise<void>;
  commitLocalCleanup: () => void;
  recoverUi: (error: unknown) => void;
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
    recoverUi(error);
    return false;
  }

  commitLocalCleanup();
  return true;
};
