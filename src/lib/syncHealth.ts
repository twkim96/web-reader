export type SyncHealth =
  | 'healthy'
  | 'retrying-receive'
  | 'recovering-expired'
  | 'paused-auth'
  | 'blocked-permission'
  | 'blocked-schema';

const AUTH_SYNC_ERROR_CODES = new Set([
  'unauthenticated',
  'auth/user-token-expired',
  'auth/id-token-expired',
]);

export const isAuthSyncErrorCode = (code: string) => AUTH_SYNC_ERROR_CODES.has(code);

const HEALTH_PRIORITY: Record<SyncHealth, number> = {
  healthy: 0,
  'retrying-receive': 1,
  'recovering-expired': 2,
  'paused-auth': 3,
  'blocked-permission': 4,
  'blocked-schema': 5,
};

export const mergeSyncHealth = (...states: SyncHealth[]): SyncHealth => (
  states.reduce((selected, candidate) => (
    HEALTH_PRIORITY[candidate] > HEALTH_PRIORITY[selected] ? candidate : selected
  ), 'healthy')
);
