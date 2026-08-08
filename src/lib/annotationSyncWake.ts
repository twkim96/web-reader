import type { AnnotationPaletteItem } from '../types';
import type { OwnerKey } from './ownerIdentity';

export type AnnotationSyncChange = {
  ownerKey: OwnerKey;
  bookId?: string;
  palette?: AnnotationPaletteItem[];
};

const EVENT_NAME = 'twreader:annotation-sync-change';
const CHANNEL_NAME = 'twreader-annotation-sync-v1';
let sharedChannel: BroadcastChannel | null | undefined;

const getSharedChannel = () => {
  if (sharedChannel !== undefined) return sharedChannel;
  sharedChannel = typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel(CHANNEL_NAME);
  return sharedChannel;
};

export const notifyAnnotationSyncChange = (change: AnnotationSyncChange) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: change }));
  getSharedChannel()?.postMessage(change);
};

export const broadcastAnnotationSyncChange = (change: AnnotationSyncChange) => {
  if (typeof window === 'undefined') return;
  getSharedChannel()?.postMessage(change);
};

export const subscribeAnnotationSyncChanges = (
  ownerKey: OwnerKey,
  listener: (change: AnnotationSyncChange) => void,
) => {
  if (typeof window === 'undefined') return () => undefined;
  const pending = new Map<string, AnnotationSyncChange>();
  const handle = (change: AnnotationSyncChange) => {
    if (change.ownerKey === ownerKey) listener(change);
  };
  const handleLocal = (event: Event) => {
    handle((event as CustomEvent<AnnotationSyncChange>).detail);
  };
  const channel = getSharedChannel();
  const handleBroadcast = (event: MessageEvent<AnnotationSyncChange>) => {
    if (event.data.ownerKey !== ownerKey) return;
    if (document.visibilityState === 'hidden') {
      const key = event.data.bookId
        ? `book:${event.data.bookId}`
        : event.data.palette
          ? 'palette'
          : 'owner';
      pending.set(key, event.data);
      return;
    }
    handle(event.data);
  };
  const handleVisibility = () => {
    if (document.visibilityState !== 'visible' || pending.size === 0) return;
    const changes = [...pending.values()];
    pending.clear();
    changes.forEach(handle);
  };
  window.addEventListener(EVENT_NAME, handleLocal);
  channel?.addEventListener('message', handleBroadcast);
  document.addEventListener('visibilitychange', handleVisibility);
  return () => {
    window.removeEventListener(EVENT_NAME, handleLocal);
    channel?.removeEventListener('message', handleBroadcast);
    document.removeEventListener('visibilitychange', handleVisibility);
  };
};
