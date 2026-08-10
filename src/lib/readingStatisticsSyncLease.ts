import { initDB } from './localDB';
import { V13_READING_STATISTICS_LEASES_STORE } from './localDBSchema';
import type { OwnerKey } from './ownerIdentity';

export const READING_STATISTICS_LEASE_DURATION_MS = 15_000;
export const READING_STATISTICS_LEASE_HEARTBEAT_MS = 5_000;

export type ReadingStatisticsSyncLeaseV13 = {
  ownerKey: OwnerKey;
  holderTabId: string;
  epoch: number;
  heartbeatAt: number;
  expiresAt: number;
};

export type ReadingStatisticsSyncLeaseClaimV13 = Pick<
  ReadingStatisticsSyncLeaseV13,
  'holderTabId' | 'epoch'
>;

export const acquireReadingStatisticsSyncLeaseV13 = async (
  ownerKey: OwnerKey,
  tabId: string,
  now = Date.now(),
  durationMs = READING_STATISTICS_LEASE_DURATION_MS,
) => {
  const db = await initDB();
  const tx = db.transaction(V13_READING_STATISTICS_LEASES_STORE, 'readwrite');
  const store = tx.objectStore(V13_READING_STATISTICS_LEASES_STORE);
  const current = await store.get(ownerKey) as ReadingStatisticsSyncLeaseV13 | undefined;
  if (
    current
    && current.expiresAt > now
    && current.holderTabId !== tabId
  ) {
    await tx.done;
    return null;
  }
  const sameLiveHolder = Boolean(
    current
    && current.holderTabId === tabId
    && current.expiresAt > now,
  );
  const lease: ReadingStatisticsSyncLeaseV13 = {
    ownerKey,
    holderTabId: tabId,
    epoch: sameLiveHolder ? current!.epoch : (current?.epoch ?? 0) + 1,
    heartbeatAt: now,
    expiresAt: now + Math.max(1, durationMs),
  };
  await store.put(lease);
  await tx.done;
  return lease;
};

export const isReadingStatisticsSyncLeaseCurrentV13 = async (
  ownerKey: OwnerKey,
  tabId: string,
  epoch: number,
  now = Date.now(),
) => {
  const db = await initDB();
  const lease = await db.get(V13_READING_STATISTICS_LEASES_STORE, ownerKey) as
    ReadingStatisticsSyncLeaseV13 | undefined;
  return Boolean(
    lease
    && lease.holderTabId === tabId
    && lease.epoch === epoch
    && lease.expiresAt > now,
  );
};

export const releaseReadingStatisticsSyncLeaseV13 = async (
  ownerKey: OwnerKey,
  tabId: string,
  epoch: number,
  now = Date.now(),
) => {
  const db = await initDB();
  const tx = db.transaction(V13_READING_STATISTICS_LEASES_STORE, 'readwrite');
  const store = tx.objectStore(V13_READING_STATISTICS_LEASES_STORE);
  const lease = await store.get(ownerKey) as ReadingStatisticsSyncLeaseV13 | undefined;
  if (lease?.holderTabId === tabId && lease.epoch === epoch) {
    await store.put({ ...lease, heartbeatAt: now, expiresAt: 0 });
  }
  await tx.done;
};

export const getReadingStatisticsSyncLeaseV13 = async (ownerKey: OwnerKey) => {
  const db = await initDB();
  return db.get(V13_READING_STATISTICS_LEASES_STORE, ownerKey) as Promise<
    ReadingStatisticsSyncLeaseV13 | undefined
  >;
};

type LeaseDependencies = {
  acquire?: typeof acquireReadingStatisticsSyncLeaseV13;
  isCurrent?: typeof isReadingStatisticsSyncLeaseCurrentV13;
  release?: typeof releaseReadingStatisticsSyncLeaseV13;
};

export class ReadingStatisticsSyncLeaseRuntime {
  private lease: ReadingStatisticsSyncLeaseV13 | null = null;

  private lifecycleGeneration = 0;

  private readonly acquireLease;

  private readonly checkLease;

  private readonly releaseLease;

  constructor(
    private readonly ownerKey: OwnerKey,
    private readonly tabId: string,
    dependencies: LeaseDependencies = {},
  ) {
    this.acquireLease = dependencies.acquire ?? acquireReadingStatisticsSyncLeaseV13;
    this.checkLease = dependencies.isCurrent ?? isReadingStatisticsSyncLeaseCurrentV13;
    this.releaseLease = dependencies.release ?? releaseReadingStatisticsSyncLeaseV13;
  }

  async acquire(now = Date.now()) {
    const generation = this.lifecycleGeneration;
    const holderTabId = `${this.tabId}:${generation}`;
    const lease = await this.acquireLease(this.ownerKey, holderTabId, now);
    if (generation !== this.lifecycleGeneration) {
      if (lease) {
        await this.releaseLease(
          this.ownerKey,
          lease.holderTabId,
          lease.epoch,
          Date.now(),
        );
      }
      return null;
    }
    this.lease = lease;
    return lease;
  }

  async isCurrent(now = Date.now()) {
    const generation = this.lifecycleGeneration;
    const lease = this.lease;
    if (!lease) return false;
    const current = await this.checkLease(
        this.ownerKey,
        lease.holderTabId,
        lease.epoch,
        now,
      );
    return Boolean(
      current
      && generation === this.lifecycleGeneration
      && this.lease?.holderTabId === lease.holderTabId
      && this.lease.epoch === lease.epoch,
    );
  }

  async release(now = Date.now()) {
    this.lifecycleGeneration += 1;
    const lease = this.lease;
    this.lease = null;
    if (lease) {
      await this.releaseLease(
        this.ownerKey,
        lease.holderTabId,
        lease.epoch,
        now,
      );
    }
  }

  get epoch() {
    return this.lease?.epoch ?? null;
  }

  get claim(): ReadingStatisticsSyncLeaseClaimV13 | null {
    return this.lease ? {
      holderTabId: this.lease.holderTabId,
      epoch: this.lease.epoch,
    } : null;
  }
}
