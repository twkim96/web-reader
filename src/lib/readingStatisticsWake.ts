import type { OwnerKey } from './ownerIdentity';

type ReadingStatisticsChange = { ownerKey: OwnerKey };
type ReadingStatisticsRefreshRequest = { ownerKey: OwnerKey };
type ReadingStatisticsServerCheck = { ownerKey: OwnerKey; checkedAt: number | null };

const EVENT_NAME = 'twreader:reading-statistics-change';
const REFRESH_EVENT_NAME = 'twreader:reading-statistics-refresh';
const SERVER_CHECK_EVENT_NAME = 'twreader:reading-statistics-server-check';
const CHANNEL_NAME = 'twreader-reading-statistics-v1';
const REFRESH_CHANNEL_NAME = 'twreader-reading-statistics-refresh-v1';
const SERVER_CHECK_CHANNEL_NAME = 'twreader-reading-statistics-server-check-v1';
let sharedChannel: BroadcastChannel | null | undefined;
let refreshChannel: BroadcastChannel | null | undefined;
let serverCheckChannel: BroadcastChannel | null | undefined;

const getSharedChannel = () => {
  if (sharedChannel !== undefined) return sharedChannel;
  sharedChannel = typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel(CHANNEL_NAME);
  return sharedChannel;
};

const getRefreshChannel = () => {
  if (refreshChannel !== undefined) return refreshChannel;
  refreshChannel = typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel(REFRESH_CHANNEL_NAME);
  return refreshChannel;
};

const getServerCheckChannel = () => {
  if (serverCheckChannel !== undefined) return serverCheckChannel;
  serverCheckChannel = typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel(SERVER_CHECK_CHANNEL_NAME);
  return serverCheckChannel;
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

export const requestReadingStatisticsRefresh = (ownerKey: OwnerKey) => {
  if (typeof window === 'undefined') return;
  const request = { ownerKey } satisfies ReadingStatisticsRefreshRequest;
  window.dispatchEvent(new CustomEvent(REFRESH_EVENT_NAME, { detail: request }));
  getRefreshChannel()?.postMessage(request);
};

export const subscribeReadingStatisticsRefreshRequests = (
  ownerKey: OwnerKey,
  listener: () => void,
) => {
  if (typeof window === 'undefined') return () => undefined;
  const handle = (request: ReadingStatisticsRefreshRequest) => {
    if (request.ownerKey === ownerKey) listener();
  };
  const handleLocal = (event: Event) => {
    handle((event as CustomEvent<ReadingStatisticsRefreshRequest>).detail);
  };
  const handleBroadcast = (event: MessageEvent<ReadingStatisticsRefreshRequest>) => {
    handle(event.data);
  };
  const channel = getRefreshChannel();
  window.addEventListener(REFRESH_EVENT_NAME, handleLocal);
  channel?.addEventListener('message', handleBroadcast);
  return () => {
    window.removeEventListener(REFRESH_EVENT_NAME, handleLocal);
    channel?.removeEventListener('message', handleBroadcast);
  };
};

export const notifyReadingStatisticsServerCheck = (
  ownerKey: OwnerKey,
  checkedAt: number | null,
) => {
  if (typeof window === 'undefined') return;
  const check = { ownerKey, checkedAt } satisfies ReadingStatisticsServerCheck;
  window.dispatchEvent(new CustomEvent(SERVER_CHECK_EVENT_NAME, { detail: check }));
  getServerCheckChannel()?.postMessage(check);
};

export const subscribeReadingStatisticsServerChecks = (
  ownerKey: OwnerKey,
  listener: (checkedAt: number | null) => void,
) => {
  if (typeof window === 'undefined') return () => undefined;
  const handle = (check: ReadingStatisticsServerCheck) => {
    if (
      check.ownerKey === ownerKey
      && (check.checkedAt === null || Number.isSafeInteger(check.checkedAt))
    ) {
      listener(check.checkedAt);
    }
  };
  const handleLocal = (event: Event) => {
    handle((event as CustomEvent<ReadingStatisticsServerCheck>).detail);
  };
  const handleBroadcast = (event: MessageEvent<ReadingStatisticsServerCheck>) => {
    handle(event.data);
  };
  const channel = getServerCheckChannel();
  window.addEventListener(SERVER_CHECK_EVENT_NAME, handleLocal);
  channel?.addEventListener('message', handleBroadcast);
  return () => {
    window.removeEventListener(SERVER_CHECK_EVENT_NAME, handleLocal);
    channel?.removeEventListener('message', handleBroadcast);
  };
};
