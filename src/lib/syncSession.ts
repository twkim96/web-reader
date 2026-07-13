let syncSessionId: string | undefined;

export const getSyncSessionId = () => {
  syncSessionId ??= crypto.randomUUID();
  return syncSessionId;
};

export const setSyncSessionIdForTests = (sessionId?: string) => {
  syncSessionId = sessionId;
};

export const isExactSyncSessionEcho = (
  acceptedSessionId: string | undefined,
  currentSessionId: string,
) => Boolean(acceptedSessionId) && acceptedSessionId === currentSessionId;
