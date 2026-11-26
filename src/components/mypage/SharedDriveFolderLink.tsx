'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { myPageRequest } from '../../lib/myPageSocialClient';
import { isGuestOwner, type OwnerKey } from '../../lib/ownerIdentity';
import { ownerRuntime } from '../../lib/ownerRuntime';

export function SharedDriveFolderLink({ owner }: { owner: OwnerKey }) {
  const [available, setAvailable] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(false);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    if (isGuestOwner(owner)) return;
    const controller = new AbortController();
    const session = ownerRuntime.capture();
    if (session?.ownerKey !== owner) return;
    void myPageRequest<{ available: boolean }>({ view: 'shared-drive' }, { owner, signal: controller.signal })
      .then(({ available }) => {
        if (!controller.signal.aborted && ownerRuntime.isCurrent(session)) setAvailable(available === true);
      }).catch(() => {});
    return () => {
      controller.abort();
      pending.current?.abort();
    };
  }, [owner]);

  const open = async () => {
    const session = ownerRuntime.capture();
    if (session?.ownerKey !== owner || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setOpening(true);
    setError(false);
    try {
      const { url } = await myPageRequest<{ url: string }>({ view: 'shared-drive', open: '1' }, { owner, signal: controller.signal });
      if (!controller.signal.aborted && ownerRuntime.isCurrent(session)) window.location.assign(url);
    } catch {
      if (!controller.signal.aborted && ownerRuntime.isCurrent(session)) setError(true);
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setOpening(false);
    }
  };

  if (!available) return null;
  return (
    <div className="mt-1">
      <button type="button" onClick={() => void open()} disabled={opening}
        className="inline-flex min-h-10 items-center gap-1 rounded-sm text-xs font-semibold text-accent-500 hover:underline disabled:opacity-50">
        {opening ? '폴더 여는 중…' : 'Google Drive에서 열기'}
        <ArrowUpRight size={14} aria-hidden="true" />
      </button>
      {error && <p role="status" className="text-xs opacity-65">공유 폴더를 열 수 없습니다.</p>}
    </div>
  );
}
