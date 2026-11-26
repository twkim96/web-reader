import { useSyncExternalStore } from 'react';
import { ownerRuntime } from '../lib/ownerRuntime';

const getServerSnapshot = () => null;

export const useOwnerSnapshot = () => (
  useSyncExternalStore(ownerRuntime.subscribe, ownerRuntime.capture, getServerSnapshot)
);
