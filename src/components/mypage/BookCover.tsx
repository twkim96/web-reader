'use client';

import { useEffect, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { fetchCoverSource } from '../../lib/bookCoverSource';
import { GeneratedBookCover } from '../shelf/GeneratedBookCover';

export function BookCover({ url, identity, title, large = false, proxy = false }: {
  url: string | null;
  identity: string;
  title?: string | null;
  large?: boolean;
  proxy?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [proxied, setProxied] = useState<{ source: string; objectUrl: string | null } | null>(null);
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
      }).catch(() => {
        if (!controller.signal.aborted) setProxied({ source: url, objectUrl: null });
      });
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
  const currentProxy = proxied?.source === url ? proxied : null;
  const imageUrl = proxy ? currentProxy?.objectUrl : url;
  const fallback = !url || (imageUrl && imageUrl === failedUrl) || currentProxy?.objectUrl === null;
  return (
    <div ref={container} className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[color-mix(in_srgb,currentColor_6%,transparent)] ${large ? 'aspect-[2/3] w-full' : 'h-[72px] w-12'}`}>
      {imageUrl && imageUrl !== failedUrl
        // Metadata provides the remote cover URL and its aspect ratio is preserved.
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(imageUrl)} className="h-full w-full object-cover" />
        : fallback && title
          ? <GeneratedBookCover identity={identity} title={title} variant={large ? 'grid' : 'list'} />
          : <BookOpen size={large ? 28 : 20} className="opacity-20" />}
    </div>
  );
}
