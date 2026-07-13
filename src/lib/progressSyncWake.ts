import type { OwnerKey } from './ownerIdentity';

const EVENT_NAME = 'twreader:progress-sync-work';
const CHANNEL_NAME = 'twreader-progress-sync-v5';

export const notifyProgressSyncWork = (ownerKey: OwnerKey) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: ownerKey }));
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage(ownerKey);
  channel.close();
};

export const notifyProgressSyncWorkAfter = (
  ownerKey: OwnerKey,
  delayMs: number,
) => {
  if (typeof window === 'undefined') return;
  window.setTimeout(
    () => notifyProgressSyncWork(ownerKey),
    Math.max(0, delayMs),
  );
};

export const subscribeProgressSyncWork = (
  ownerKey: OwnerKey,
  listener: () => void,
) => {
  if (typeof window === 'undefined') return () => undefined;
  const handleLocal = (event: Event) => {
    if ((event as CustomEvent<OwnerKey>).detail === ownerKey) listener();
  };
  const channel = typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel(CHANNEL_NAME);
  const handleBroadcast = (event: MessageEvent<OwnerKey>) => {
    if (event.data === ownerKey) listener();
  };
  window.addEventListener(EVENT_NAME, handleLocal);
  channel?.addEventListener('message', handleBroadcast);
  return () => {
    window.removeEventListener(EVENT_NAME, handleLocal);
    channel?.removeEventListener('message', handleBroadcast);
    channel?.close();
  };
};
