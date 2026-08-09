import type { OwnerKey } from './ownerIdentity';

type ReadingStatisticsChange = { ownerKey: OwnerKey };

const EVENT_NAME = 'twreader:reading-statistics-change';
const CHANNEL_NAME = 'twreader-reading-statistics-v1';
let sharedChannel: BroadcastChannel | null | undefined;

const getSharedChannel = () => {
  if (sharedChannel !== undefined) return sharedChannel;
  sharedChannel = typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel(CHANNEL_NAME);
  return sharedChannel;
};

export const notifyReadingStatisticsChange = (ownerKey: OwnerKey) => {
  if (typeof window === 'undefined') return;
  const change = { ownerKey } satisfies ReadingStatisticsChange;
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: change }));
  getSharedChannel()?.postMessage(change);
};

export const subscribeReadingStatisticsChanges = (
  ownerKey: OwnerKey,
  listener: () => void,
) => {
  if (typeof window === 'undefined') return () => undefined;
  const handle = (change: ReadingStatisticsChange) => {
    if (change.ownerKey === ownerKey) listener();
  };
  const handleLocal = (event: Event) => {
    handle((event as CustomEvent<ReadingStatisticsChange>).detail);
  };
  const handleBroadcast = (event: MessageEvent<ReadingStatisticsChange>) => {
    handle(event.data);
  };
  const channel = getSharedChannel();
  window.addEventListener(EVENT_NAME, handleLocal);
  channel?.addEventListener('message', handleBroadcast);
  return () => {
    window.removeEventListener(EVENT_NAME, handleLocal);
    channel?.removeEventListener('message', handleBroadcast);
  };
};
