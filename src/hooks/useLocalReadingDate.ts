'use client';

import { useEffect, useState } from 'react';

function localDayStart(now: Date) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function useLocalReadingDate(active = true) {
  const [date, setDate] = useState(() => localDayStart(new Date()));
  useEffect(() => {
    if (!active) return;
    let timer: number;
    const update = () => {
      window.clearTimeout(timer);
      const now = new Date();
      setDate(localDayStart(now));
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = window.setTimeout(update, Math.max(1, tomorrow.getTime() - now.getTime()));
    };
    const resume = () => {
      if (document.visibilityState !== 'hidden') update();
    };
    update();
    window.addEventListener('focus', resume);
    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', resume);
      window.removeEventListener('pageshow', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [active]);
  return date;
}
