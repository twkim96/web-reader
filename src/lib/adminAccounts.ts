export type AdminAccount = {
  uid: string;
  label: string;
  email: string | null;
  lastSignIn: number;
  lastRefresh: number | null;
};

export type AdminAccountsOverview = {
  activity: { today: number; week: number; month: number };
  accounts: AdminAccount[];
};

export type AdminRollupStatus = {
  publishedThrough: string | null;
  nextDue: number | null;
  state: 'unregistered' | 'preparing' | 'scheduled' | 'blocked';
  blockedReason: string | null;
  weeks: { start: string; writtenAt: number | null }[];
};
