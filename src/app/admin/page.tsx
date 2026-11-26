'use client';

import { onAuthStateChanged, type User } from 'firebase/auth';
import { ArrowLeft, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useViewerSettings } from '../../hooks/useViewerSettings';
import type { AdminAccount, AdminAccountsOverview, AdminRollupStatus } from '../../lib/adminAccounts';
import { auth } from '../../lib/firebase';
import { getThemeCssVariables } from '../../lib/themeUtils';

const timeFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short',
});
const formatTime = (value: number | null) => value === null ? '—' : timeFormat.format(value);
const formatWeek = (start: string) => {
  const end = new Date(`${start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return `${start} ~ ${end.toISOString().slice(0, 10)}`;
};

async function requestAdmin<T>(user: User, signal: AbortSignal, uid?: string): Promise<T> {
  const token = await user.getIdToken();
  signal.throwIfAborted();
  if (auth.currentUser !== user) throw new Error('account-changed');
  const query = uid ? `?${new URLSearchParams({ uid })}` : '';
  const response = await fetch(`/api/admin/accounts${query}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal,
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

const stateLabels: Record<AdminRollupStatus['state'], string> = {
  unregistered: '미등록', preparing: '첫 집계 준비 중', scheduled: '대기 중', blocked: '차단됨',
};

function RollupDetails({ admin, uid }: { admin: User; uid: string }) {
  const [result, setResult] = useState<AdminRollupStatus | 'failed'>();
  useEffect(() => {
    const request = new AbortController();
    void requestAdmin<AdminRollupStatus>(admin, request.signal, uid).then((data) => {
      if (!request.signal.aborted) setResult(data);
    }).catch(() => { if (!request.signal.aborted) setResult('failed'); });
    return () => request.abort();
  }, [admin, uid]);

  if (result === 'failed') return <p role="alert" className="px-1 pb-4 text-sm opacity-70">집계 상태를 불러오지 못했습니다.</p>;
  if (!result) return <p role="status" className="px-1 pb-4 text-sm opacity-70">집계 상태를 불러오는 중…</p>;
  return (
    <div className="px-1 pb-5 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 break-words">
        <dt className="opacity-65">집계 발행</dt><dd>{result.publishedThrough ? formatWeek(result.publishedThrough) : '미발행'}</dd>
        <dt className="opacity-65">다음 마감</dt><dd>{formatTime(result.nextDue)}</dd>
        <dt className="opacity-65">작업 상태</dt><dd>{stateLabels[result.state]}{result.blockedReason && <span className="ml-2 break-all opacity-65">{result.blockedReason}</span>}</dd>
      </dl>
      <h3 className="mt-5 font-medium">최근 마감 문서</h3>
      {result.weeks.length === 0 ? <p className="mt-2 opacity-65">발행된 주간 문서가 없습니다.</p> : (
        <ul className="mt-1 divide-y divide-current/10">
          {result.weeks.map((week) => <li key={week.start} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2">
            <span className="tabular-nums">{formatWeek(week.start)}</span>
            <span className="text-xs opacity-65">{formatTime(week.writtenAt)}</span>
          </li>)}
        </ul>
      )}
    </div>
  );
}

function AccountRow({ account, admin, expanded, onToggle }: {
  account: AdminAccount; admin: User; expanded: boolean; onToggle: () => void;
}) {
  return <li>
    <button type="button" aria-expanded={expanded} onClick={onToggle}
      className="flex w-full items-start gap-3 rounded-sm px-1 py-4 text-left hover:bg-current/5 focus-visible:outline-2 focus-visible:outline-accent-500 sm:items-center">
      <span className="grid min-w-0 flex-1 gap-x-6 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto]">
        <span className="min-w-0">
          <span className="block break-all text-sm font-semibold">{account.label}</span>
          {account.email && <span className="block break-all text-xs opacity-60">{account.email}</span>}
        </span>
        <span className="text-xs leading-5 opacity-70 sm:text-right">
          <span className="block">마지막 로그인 {formatTime(account.lastSignIn)}</span>
          <span className="block">토큰 갱신 {formatTime(account.lastRefresh)}</span>
        </span>
      </span>
      <ChevronDown size={17} aria-hidden="true" className={`mt-0.5 shrink-0 opacity-65 ${expanded ? 'rotate-180' : ''}`} />
    </button>
    {expanded && <RollupDetails admin={admin} uid={account.uid} />}
  </li>;
}

function Accounts({ admin }: { admin: User }) {
  const [overview, setOverview] = useState<AdminAccountsOverview | 'denied' | 'failed'>();
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const request = new AbortController();
    void requestAdmin<AdminAccountsOverview>(admin, request.signal).then((data) => {
      if (!request.signal.aborted) setOverview(data);
    }).catch((error: unknown) => {
      if (request.signal.aborted) return;
      setOverview(error instanceof Error && ['401', '403', '404'].includes(error.message) ? 'denied' : 'failed');
    });
    return () => request.abort();
  }, [admin]);

  if (!overview) return <p role="status" className="text-sm opacity-70">계정 현황을 불러오는 중…</p>;
  if (overview === 'denied') return <p role="alert" className="text-sm opacity-70">관리자 계정으로만 볼 수 있습니다.</p>;
  if (overview === 'failed') return <p role="alert" className="text-sm opacity-70">계정 현황을 불러오지 못했습니다.</p>;

  const { activity, accounts } = overview;
  return <>
    <section aria-labelledby="account-activity-heading">
      <h2 id="account-activity-heading" className="text-lg font-semibold">계정 활동</h2>
      <dl className="mt-4 grid grid-cols-3 gap-3">
        {([['오늘', activity.today], ['최근 7일', activity.week], ['최근 30일', activity.month]] as const).map(([label, count]) => (
          <div key={label}>
            <dt className="text-xs opacity-65 sm:text-sm">{label}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums sm:text-2xl">{count.toLocaleString('ko')}명</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs opacity-60">Firebase 로그인·토큰 갱신 기록 기준</p>
    </section>
    <section aria-labelledby="active-account-heading" className="mt-10">
      <h2 id="active-account-heading" className="text-lg font-semibold">최근 30일 로그인 계정 <span className="ml-1 text-sm font-normal opacity-65">{accounts.length}명</span></h2>
      {accounts.length === 0 ? <p className="mt-4 text-sm opacity-65">최근 로그인한 계정이 없습니다.</p> : (
        <ul className="mt-3 divide-y divide-current/10">
          {accounts.map((account) => <AccountRow key={account.uid} account={account} admin={admin}
            expanded={selected === account.uid} onToggle={() => setSelected((current) => current === account.uid ? null : account.uid)} />)}
        </ul>
      )}
    </section>
  </>;
}

export default function AdminPage() {
  const [user, setUser] = useState<User | null>();
  const { settings } = useViewerSettings();
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  return (
    <div style={getThemeCssVariables(settings)} className="min-h-dvh bg-[color:var(--viewer-theme-bg)] text-[color:var(--viewer-theme-text)]">
      <main className="mx-auto max-w-4xl px-5 pt-[max(1.5rem,env(safe-area-inset-top))] pb-12 sm:px-8">
        <header className="mb-8 flex items-center gap-2">
          <Link href="/#mypage/sharing" prefetch={false} aria-label="마이페이지 설정으로 돌아가기"
            className="flex size-11 items-center justify-center rounded-full hover:bg-current/10"><ArrowLeft size={19} aria-hidden="true" /></Link>
          <h1 className="text-xl font-semibold tracking-tight">관리자 화면</h1>
        </header>
        {user === undefined ? <p role="status" className="text-sm opacity-70">로그인 확인 중…</p>
          : user && !user.isAnonymous ? <Accounts key={user.uid} admin={user} />
            : <p role="alert" className="text-sm opacity-70">관리자 계정으로 로그인한 뒤 열어 주세요.</p>}
      </main>
    </div>
  );
}
