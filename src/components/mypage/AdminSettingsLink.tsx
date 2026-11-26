'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { splitOwnerKey, type OwnerKey } from '../../lib/ownerIdentity';

export function AdminSettingsLink({ ownerKey }: { ownerKey: OwnerKey }) {
  const [verifiedOwner, setVerifiedOwner] = useState<OwnerKey>();
  useEffect(() => {
    const expected = process.env.NEXT_PUBLIC_WEB_READER_ADMIN_MENU_HASH;
    const { authOwnerKey: owner } = splitOwnerKey(ownerKey);
    if (!expected || !owner.startsWith('firebase:') || !globalThis.crypto?.subtle) return;
    let active = true;
    void crypto.subtle.digest('SHA-256', new TextEncoder().encode(owner.slice('firebase:'.length))).then((digest) => {
      const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (active && hash === expected) setVerifiedOwner(ownerKey);
    }).catch(() => {});
    return () => { active = false; };
  }, [ownerKey]);

  if (verifiedOwner !== ownerKey) return null;
  return <Link href="/admin" prefetch={false}
    className="flex min-h-11 items-center justify-between border-t border-current/10 text-sm font-medium hover:text-accent-500">
    관리자 화면 <ChevronRight size={17} aria-hidden="true" />
  </Link>;
}
