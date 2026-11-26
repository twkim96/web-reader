'use client';

import { useEffect, useRef, useState } from 'react';
import { CloudDownload } from 'lucide-react';
import { ownerRuntime } from '../../lib/ownerRuntime';
import type { OwnerKey } from '../../lib/ownerIdentity';
import { pickSharedDriveFiles } from '../../lib/googleDrivePicker';

export type SharedDriveConnection = { token: string; sessionId: string; hasValidToken: () => boolean; refreshShelf: () => void };
type PickerConfig = { available: true; pickerKey: string; appId: string } | { available: false };
class SharedDriveRequestError extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(`HTTP ${status}${reason ? `/${reason}` : ''}`);
  }
}

async function requestImport<T>(owner: OwnerKey, driveToken: string, signal: AbortSignal, body?: object): Promise<T> {
  const session = ownerRuntime.capture();
  const { auth } = await import('../../lib/firebase');
  const user = auth.currentUser;
  if (session?.ownerKey !== owner || !user || owner !== `firebase:${user.uid}|library:local`) throw new Error('Login required');
  const token = await user.getIdToken();
  signal.throwIfAborted();
  if (!ownerRuntime.isCurrent(session) || auth.currentUser?.uid !== user.uid) throw new Error('Account changed');
  const response = await fetch('/api/shared-drive', {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`, 'X-Drive-Access-Token': driveToken,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store', signal,
  });
  if (!response.ok) {
    const details = await response.json().catch(() => null) as { reason?: unknown } | null;
    const reason = typeof details?.reason === 'string' && /^[a-z-]{1,24}$/.test(details.reason) ? details.reason : '';
    throw new SharedDriveRequestError(response.status, reason);
  }
  const data = await response.json() as T;
  signal.throwIfAborted();
  if (!ownerRuntime.isCurrent(session) || auth.currentUser?.uid !== user.uid) throw new Error('Account changed');
  return data;
}

const actionStyle = 'min-h-10 rounded-lg px-3 text-sm font-semibold text-accent-500 hover:bg-current/5 disabled:opacity-40';

export function useSharedDriveImport({ owner, drive, title, onReconnect }: {
  owner: OwnerKey;
  drive?: SharedDriveConnection;
  title?: string;
  onReconnect?: () => void;
}) {
  const [checked, setChecked] = useState<{ sessionId: string; result: PickerConfig | 'failed' }>();
  const [checkAttempts, setCheckAttempts] = useState(0);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [refine, setRefine] = useState(false);
  const [feedback, setFeedback] = useState('');
  const controller = useRef<AbortController | null>(null);
  const token = drive?.token;
  const sessionId = drive?.sessionId;
  const hasTitle = Boolean(title);
  // Keep the verified button on this detail after expiry. A new Drive session needs its own check.
  const status = !sessionId || sessionId === checked?.sessionId ? checked?.result : undefined;

  useEffect(() => {
    if (!token || !sessionId || !hasTitle) return;
    const check = new AbortController();
    void requestImport<PickerConfig>(owner, token, check.signal).then((result) => {
      if (!check.signal.aborted) setChecked({ sessionId, result });
    }).catch(() => {
      if (!check.signal.aborted) setChecked({ sessionId, result: 'failed' });
    });
    return () => {
      check.abort();
      controller.current?.abort();
    };
  }, [owner, token, sessionId, hasTitle, checkAttempts]);

  async function open(value: string) {
    if (!status || status === 'failed' || !status.available || !value.trim() || controller.current) return;
    if (!drive?.hasValidToken()) {
      onReconnect?.();
      return;
    }
    const { token } = drive;
    const current = new AbortController();
    const { signal } = current;
    controller.current = current;
    setBusy(true);
    setRefine(true);
    setFeedback('공유 폴더 검색 중…');
    try {
      const { ids, limited } = await requestImport<{ ids: string[]; limited: boolean }>(owner, token, signal, {
        action: 'search', query: value,
      });
      if (!ids.length) {
        setFeedback(limited ? '검색 범위를 좁혀 다시 시도해 주세요.' : '검색 결과가 없습니다.');
        return;
      }
      setFeedback(limited ? '표시할 수 있는 후보까지만 찾았습니다.' : '');
      const selected = await pickSharedDriveFiles({ ids, token, ...status, signal });
      if (signal.aborted || !selected.length) return;
      if (selected.length > 8) {
        setFeedback('한 번에 최대 8권까지 가져올 수 있습니다.');
        return;
      }
      setFeedback('서재로 복사 중…');
      const { results } = await requestImport<{ results: boolean[] }>(owner, token, signal, { action: 'copy', ids: selected });
      const copied = results.filter(Boolean).length;
      if (!copied) {
        setFeedback('복사를 확인하지 못했습니다. 서재를 확인한 뒤 다시 시도해 주세요.');
        return;
      }
      drive.refreshShelf();
      setFeedback(copied === results.length ? `${copied}권을 서재로 가져왔습니다.`
        : `${copied}권을 서재로 가져왔습니다. ${results.length - copied}권은 복사를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.`);
    } catch (error) {
      if (!signal.aborted) {
        if (process.env.NEXT_PUBLIC_WEB_READER_PREVIEW === '1') {
          console.warn('[SharedDrive]', error instanceof SharedDriveRequestError ? error.message : 'Picker or client session failed');
        }
        if (error instanceof SharedDriveRequestError && error.status === 401 && error.reason === 'drive') {
          setRefine(false);
          setFeedback('');
          onReconnect?.();
        } else if (error instanceof SharedDriveRequestError && error.reason === 'destination-changed') {
          setFeedback('복사 대상 서재가 바뀌었습니다. 이전 서재에 사본이 있는지 확인해 주세요.');
        } else if (error instanceof SharedDriveRequestError && error.status === 429) {
          setFeedback('Drive가 요청을 제한하고 있습니다. 잠시 후 다시 시도해 주세요.');
        } else {
          setFeedback('가져오기를 완료하지 못했습니다. Drive 연결과 서재를 확인한 뒤 다시 시도해 주세요.');
        }
      }
    } finally {
      if (controller.current === current) {
        controller.current = null;
        setBusy(false);
      }
    }
  }

  if (!status || status === 'failed' || !status.available) return { button: null, panel: drive && status === 'failed' ? (
    <p role="status" className="mt-1 text-sm opacity-70">
      공유 폴더 연결을 확인하지 못했습니다.
      <button type="button" className={actionStyle} onClick={() => {
        setChecked(undefined);
        setCheckAttempts((current) => current + 1);
      }}>다시 확인</button>
    </p>
  ) : null };
  return {
    button: (
      <button type="button" aria-label="공유 폴더에서 가져오기" title="공유 폴더에서 가져오기" disabled={busy} onClick={() => {
        const initial = title?.slice(0, 200) ?? '';
        setQuery(initial);
        void open(initial);
      }} className="relative inline-flex size-6 items-center justify-center rounded-md text-accent-500 before:absolute before:-inset-y-2.5 before:-start-2.5 before:end-0 hover:bg-current/5 focus-visible:outline-2 focus-visible:outline-accent-500 disabled:opacity-40">
        <CloudDownload size={19} aria-hidden="true" />
      </button>),
    panel: drive && (refine || feedback) ? <>
      {refine && <form className="mt-2 flex gap-2" onSubmit={(event) => { event.preventDefault(); void open(query); }}>
        <input aria-label="공유 폴더 파일 검색" value={query} maxLength={200} required disabled={busy}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 rounded-lg bg-current/5 px-3 text-sm ring-1 ring-inset ring-current/15" />
        <button type="submit" disabled={busy} className={actionStyle}>다시 검색</button>
      </form>}
      {feedback && <p role="status" className="mt-2 text-sm opacity-70">{feedback}</p>}
    </> : null,
  };
}
