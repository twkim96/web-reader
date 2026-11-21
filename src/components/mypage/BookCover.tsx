'use client';

import { useEffect, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { fetchCoverSource } from '../../lib/bookCoverSource';
import { GeneratedBookCover } from '../shelf/GeneratedBookCover';

export type BookCoverLoading = 'direct' | 'proxy' | 'direct-with-proxy-fallback';

type Props = {
  url: string | null;
  identity: string;
  title?: string | null;
  large?: boolean;
  coverLoading?: BookCoverLoading;
};

const directCoverOrigins = new Set(['https://comicthumb-phinf.pstatic.net', 'https://dn-img-page.kakao.com']);

function canLoadCoverDirectly(value: string | null) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && directCoverOrigins.has(url.origin)
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function BookCover({ coverLoading = 'direct', ...props }: Props) {
  return <BookCoverImage key={JSON.stringify([coverLoading, props.url])} {...props} coverLoading={coverLoading} />;
}

function BookCoverImage({ url, identity, title, large = false, coverLoading }: Props) {
  const [nearViewport, setNearViewport] = useState(coverLoading === 'direct');
  const [directFailed, setDirectFailed] = useState(false);
  const [proxiedUrl, setProxiedUrl] = useState<string | null>();
  const container = useRef<HTMLDivElement>(null);
  const tryDirect = coverLoading === 'direct'
    || (coverLoading === 'direct-with-proxy-fallback' && canLoadCoverDirectly(url));
  const loadThroughProxy = coverLoading !== 'direct' && nearViewport && (!tryDirect || directFailed);

  useEffect(() => {
    if (coverLoading === 'direct' || !url || !container.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      const timer = window.setTimeout(() => setNearViewport(true), 0);
      return () => window.clearTimeout(timer);
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setNearViewport(true);
    }, { rootMargin: '120px' });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [coverLoading, url]);

  useEffect(() => {
    if (!loadThroughProxy || !url) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void fetchCoverSource(url, controller.signal).then((image) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(image);
      setProxiedUrl(objectUrl);
    }).catch(() => {
      if (!controller.signal.aborted) setProxiedUrl(null);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [loadThroughProxy, url]);

  const showingDirect = nearViewport && tryDirect && !directFailed;
  const imageUrl = showingDirect ? url : proxiedUrl;
  const fallback = !url || (coverLoading === 'direct' && directFailed) || proxiedUrl === null;
  return (
    <div ref={container} className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[color-mix(in_srgb,currentColor_6%,transparent)] ${large ? 'aspect-[2/3] w-full' : 'h-[72px] w-12'}`}>
      {imageUrl
        // Metadata provides the remote cover URL and its aspect ratio is preserved.
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => {
          if (showingDirect) setDirectFailed(true);
          else setProxiedUrl(null);
        }} className="h-full w-full object-cover" />
        : fallback && title
          ? <GeneratedBookCover identity={identity} title={title} variant={large ? 'grid' : 'list'} />
          : <BookOpen size={large ? 28 : 20} className="opacity-20" />}
    </div>
  );
}
