'use client';

import { useSyncExternalStore } from 'react';
import type { OwnerKey } from '../lib/ownerIdentity';

const serverSnapshot = () => undefined;

export function useMyPageDashboardCards<T>(cache: {
  subscribe: (listener: () => void) => () => void;
  read: (owner: OwnerKey) => T | undefined;
}, owner: OwnerKey, enabled: boolean) {
  return useSyncExternalStore(cache.subscribe, () => enabled ? cache.read(owner) : undefined, serverSnapshot);
}
