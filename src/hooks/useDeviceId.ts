import { useEffect, useRef } from 'react';

const DEVICE_ID_KEY = 'reader_device_id';

export const getOrCreateDeviceId = (
  storage: Pick<Storage, 'getItem' | 'setItem'>,
) => {
  const existing = storage.getItem(DEVICE_ID_KEY)?.trim();
  if (existing) return existing;
  const id = crypto.randomUUID();
  storage.setItem(DEVICE_ID_KEY, id);
  return id;
};

export const useDeviceId = () => {
  const deviceId = useRef('');

  useEffect(() => {
    deviceId.current = getOrCreateDeviceId(localStorage);
  }, []);

  return deviceId;
};
