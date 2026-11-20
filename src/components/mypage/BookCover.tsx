'use client';

import { useEffect, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { fetchCoverSource } from '../../lib/bookCoverSource';

export function BookCover({ url, large = false, proxy = false }: { url: string | null; large?: boolean; proxy?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [proxied, setProxied] = useState<{ source: string; objectUrl: string } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!proxy || !url || !container.current) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const load = () => {
      void fetchCoverSource(url, controller.signal).then((image) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(image);
        setProxied({ source: url, objectUrl });
      }).catch(() => { /* The placeholder covers offline and unavailable covers. */ });
    };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer?.disconnect();
      load();
    }, { rootMargin: '120px' });
    if (observer) observer.observe(container.current);
    else load();
    return () => {
      controller.abort();
      observer?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [proxy, url]);
  const imageUrl = proxy ? (proxied?.source === url ? proxied.objectUrl : null) : url;
  return (
    <div ref={container} className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[color-mix(in_srgb,currentColor_6%,transparent)] ${large ? 'aspect-[2/3] w-full' : 'h-[72px] w-12'}`}>
      {imageUrl && imageUrl !== failedUrl
        // Metadata provides the remote cover URL and its aspect ratio is preserved.
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(imageUrl)} className="h-full w-full object-cover" />
        : <BookOpen size={large ? 28 : 20} className="opacity-20" />}
    </div>
  );
}
