import { useEffect, useRef } from 'react';

const DEVICE_ID_KEY = 'reader_device_id';

export const useDeviceId = () => {
  const deviceId = useRef('');

  useEffect(() => {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    deviceId.current = id;
  }, []);

  return deviceId;
};
